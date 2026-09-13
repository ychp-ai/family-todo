import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Family, Membership } from "@family-todo/domain";
import { resolvedMember } from "@family-todo/domain";
import { familyFixture } from "./support/family-fixture";

async function seededFamily() {
  const fixture = await familyFixture(); const familyId = randomUUID(); const memberId = randomUUID();
  const family: Family = { id: familyId, name: "我们的家", ownerMembershipId: memberId, version: 1, authEpoch: 1, taskCount: 0, memberCount: 1, virtualMemberCount: 0, createdAt: fixture.now, updatedAt: fixture.now };
  const member: Membership = { id: memberId, familyId, userId: fixture.user.id, name: "我", status: "active", successorMembershipId: null, version: 1, createdAt: fixture.now, updatedAt: fixture.now };
  await fixture.store().transaction(async tx => { await tx.saveFamily(family); await tx.saveMember(member); await tx.saveSlot({ familyId, userId: member.userId, activeMembershipId: member.id }); });
  return { ...fixture, family, member };
}

describe("CloudBase family adapter (local transactional simulator)", () => {
  it("loads a complete successor chain beyond the active roster without reviving an old membership", async () => {
    const f = await seededFamily(); let successor = f.member.id; const ids: string[] = [];
    for (let index = 0; index < 100; index++) {
      const member: Membership = { ...f.member, id: randomUUID(), userId: randomUUID(), status: "left", successorMembershipId: successor };
      await f.store().transaction(tx => tx.saveMember(member)); successor = member.id; ids.push(member.id);
    }
    const context = await f.store().context(f.family.id, [successor]);
    expect(context).not.toBeNull(); if (!context) throw new Error("Missing fixture");
    expect(context.members).toHaveLength(101); expect(resolvedMember(context, successor).id).toBe(f.member.id);
    expect(await f.store().families(f.user.id)).toEqual([f.family]);
    const first = ids[0]; if (!first) throw new Error("Missing fixture");
    const historical = await f.store().readMember(first); if (!historical) throw new Error("Missing fixture");
    await f.store().transaction(tx => tx.saveMember({ ...historical, successorMembershipId: successor }));
    await expect(f.store().context(f.family.id, [successor])).rejects.toThrow();
  });
  it("rolls back business writes when a receipt fails, and enforces the document budget", async () => {
    const f = await seededFamily(); f.database.failCollection = "idempotency_receipts";
    await expect(f.store().transaction(async tx => { await tx.saveFamily({ ...f.family, name: "未提交" }); await tx.saveReceipt(f.user.id, randomUUID(), { taskId: f.family.id, fingerprint: "x", result: {} }); })).rejects.toThrow();
    expect((await f.store().context(f.family.id))?.family.name).toBe("我们的家");
    await expect(f.store().transaction(async tx => { for (let index = 0; index < 81; index++) await tx.family(f.family.id); })).rejects.toThrow("budget");
  });
  it("authenticates encrypted invitation receipts and opaque session signatures", async () => {
    const f = await seededFamily(); const store = f.store(); const token = store.randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sealed = store.seal({ token }); expect(sealed).not.toContain(token); expect(store.unseal(sealed)).toEqual({ token });
    expect(() => store.unseal(sealed.replace(/^v2/, "v3"))).toThrow();
    const parts = sealed.split("."); const ciphertext = parts[3]; if (!ciphertext) throw new Error("Missing fixture"); parts[3] = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    expect(() => store.unseal(parts.join("."))).toThrow();
    const cursor = await store.saveSession({ actorId: f.user.id, expiresAt: "2026-09-11T12:15:00.000Z" });
    expect((await store.readSession(cursor))?.actorId).toBe(f.user.id);
    expect(await store.readSession("A" + cursor.slice(1))).toBeNull();
    await expect(store.saveSession({ expiresAt: "2026-09-11T12:15:00.000Z", data: "a".repeat(128 * 1024) })).rejects.toThrow("size");
  });
  it("keeps reminder choices by user identity through a new membership and isolates occurrence receipts", async () => {
    const f = await seededFamily(); const taskId = randomUUID(); const occurrenceId = randomUUID(); const otherUserId = randomUUID();
    await f.store().transaction(async tx => {
      await tx.savePreference({ taskId, userId: f.user.id, membershipId: f.member.id, enabled: false, selfDisabled: true, version: 1 });
      await tx.saveReminderReceipt({ occurrenceId, userId: f.user.id, readAt: f.now, dismissedAt: null, version: 1 });
    });
    expect(await f.store().transaction(tx => tx.preference(taskId, f.user.id))).toMatchObject({ selfDisabled: true, enabled: false });
    expect(await f.store().transaction(tx => tx.reminderReceipt(occurrenceId, otherUserId))).toBeNull();
  });
});
