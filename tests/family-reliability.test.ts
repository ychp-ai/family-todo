import { createCipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isFamilyData } from "@family-todo/contracts";
import { FamilyBudgetExceededError } from "@family-todo/ports";
import { FamilyService } from "../packages/application/src/family";
import { CloudBaseFamilyStore, invitationKeyringFromEnvironment } from "../packages/infra-cloudbase/src/family-store";
import type { InvitationKeyring } from "../packages/infra-cloudbase/src/family-store";
import { familyFixture } from "./support/family-fixture";

const cursorSecret = "test-cursor-secret-more-than-32-characters";
const oldSecret = "test-old-invitation-secret-more-than-32-characters";
const newSecret = "test-new-invitation-secret-more-than-32-characters";
const keys: InvitationKeyring = { activeKeyId: "old", keys: { old: oldSecret } };
function service(store: CloudBaseFamilyStore, now: string) { return new FamilyService(store, { now: () => new Date(now) }, { generate: randomUUID }); }
async function setup() {
  const f = await familyFixture(); const make = (ring = keys, secret = cursorSecret, time: () => number = Date.now) => new CloudBaseFamilyStore(f.database, f.identity, secret, ring, time);
  const result = await service(make(), f.now).execute("family.create", { name: "家庭", myName: "我" }, randomUUID());
  if (!isFamilyData("family.create", result)) throw new Error("Missing fixture");
  return { ...f, make, family: result.family };
}
function legacySeal(value: unknown, secret: string) {
  const nonce = randomBytes(12); const key = Buffer.from(hkdfSync("sha256", secret, "family-todo", "invitation-receipt/v1", 32));
  const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from("family-todo/invitation-receipt/v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

describe("邀请密钥轮换与家庭共享时间预算", () => {
  it("新密钥写入、保留旧key重放，以及单独轮换cursor secret不损坏回执", async () => {
    const f = await setup(); const id = randomUUID(); const payload = { familyId: f.family.id, expectedFamilyVersion: f.family.version };
    const original = await service(f.make(), f.now).execute("invitation.create", payload, id);
    const ring = { activeKeyId: "new", keys: { old: oldSecret, new: newSecret } };
    const rotated = f.make(ring, "rotated-cursor-secret-at-least-32-characters");
    expect(await service(rotated, f.now).execute("invitation.create", payload, id)).toEqual(original);
    expect(rotated.seal({ value: true })).toMatch(/^v2\.new\./);
    const receipt = await f.make().transaction(tx => tx.receipt(f.user.id, id));
    expect(receipt?.result).toMatchObject({ sealed: expect.stringMatching(/^v2\.old\./) });
    const withoutOld = f.make({ activeKeyId: "new", keys: { new: newSecret } });
    await expect(service(withoutOld, f.now).execute("invitation.create", payload, id)).rejects.toThrow("Invalid collaboration storage record.");
  });
  it("v1仅用显式保留的legacy密钥解密；未知keyId和keyId篡改拒绝", async () => {
    const f = await setup(); const legacy = legacySeal({ token: "AAAAAAAAAAAAAAAAAAAAAA" }, cursorSecret);
    const compatible = new CloudBaseFamilyStore(f.database, f.identity, "rotated-cursor-secret-at-least-32-characters", { ...keys, legacyV1Secret: cursorSecret });
    expect(compatible.unseal(legacy)).toEqual({ token: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(() => f.make().unseal(legacy)).toThrow();
    const sealed = compatible.seal({ secret: true });
    expect(() => compatible.unseal(sealed.replace(".old.", ".unknown."))).toThrow();
    const two = f.make({ activeKeyId: "old", keys: { old: oldSecret, alternate: oldSecret } });
    expect(() => two.unseal(sealed.replace(".old.", ".alternate."))).toThrow();
    const json = JSON.stringify({ activeKeyId: "old", keys: { old: oldSecret } });
    const encoded = `base64url:${Buffer.from(json).toString("base64url")}`;
    expect(invitationKeyringFromEnvironment(encoded)).toEqual(invitationKeyringFromEnvironment(json));
    for (const value of ["base64url:", "base64url:!invalid", "base64url:e30=", undefined, "{", "{}", JSON.stringify({ activeKeyId: "missing", keys: { old: oldSecret } })]) expect(() => invitationKeyringFromEnvironment(value)).toThrow("Invitation keyring unavailable.");
  });
  it("已有v1邀请回执在cursor轮换后仍可用显式legacy密钥完整重放", async () => {
    const f = await setup(); const id = randomUUID(); const payload = { familyId: f.family.id, expectedFamilyVersion: f.family.version };
    const original = await service(f.make(), f.now).execute("invitation.create", payload, id);
    await f.make().transaction(async tx => {
      const receipt = await tx.receipt(f.user.id, id); if (!receipt) throw new Error("Missing fixture");
      await tx.saveReceipt(f.user.id, id, { ...receipt, result: { sealed: legacySeal(original, cursorSecret) } });
    });
    const rotated = f.make({ activeKeyId: "new", keys: { new: newSecret }, legacyV1Secret: cursorSecret }, "rotated-cursor-secret-at-least-32-characters");
    expect(await service(rotated, f.now).execute("invitation.create", payload, id)).toEqual(original);
  });
  it("撤销后即使历史解密key已移除也先鉴权邀请有效性，不尝试解密", async () => {
    const f = await setup(); const id = randomUUID(); const payload = { familyId: f.family.id, expectedFamilyVersion: f.family.version };
    const invitation = await service(f.make(), f.now).execute("invitation.create", payload, id); if (!isFamilyData("invitation.create", invitation)) throw new Error("Missing fixture");
    await service(f.make(), f.now).execute("invitation.revoke", { id: invitation.id, expectedVersion: 1 }, randomUUID());
    const rotated = f.make({ activeKeyId: "new", keys: { new: newSecret } }); const unseal = vi.spyOn(rotated, "unseal");
    await expect(service(rotated, f.now).execute("invitation.create", payload, id)).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" }); expect(unseal).not.toHaveBeenCalled();
  });
  it("转交家庭后原拥有人重试邀请时先拒绝失权，不尝试解密", async () => {
    const f = await setup(); const other = await familyFixture(f.database); const id = randomUUID();
    const payload = { familyId: f.family.id, expectedFamilyVersion: f.family.version };
    const invitation = await service(f.make(), f.now).execute("invitation.create", payload, id); if (!isFamilyData("invitation.create", invitation)) throw new Error("Missing fixture");
    const join = await service(new CloudBaseFamilyStore(f.database, other.identity, cursorSecret, keys), f.now).execute("invitation.accept", { token: invitation.token, myName: "新拥有人" }, randomUUID()); if (!isFamilyData("invitation.accept", join)) throw new Error("Missing fixture");
    const target = { familyId: f.family.id, toMembershipId: join.membershipId };
    const preview = await service(f.make(), f.now).execute("family.previewTransfer", target, randomUUID()); if (!isFamilyData("family.previewTransfer", preview) || !preview.complete) throw new Error("Missing fixture");
    await service(f.make(), f.now).execute("family.transferOwnership", { ...target, previewToken: preview.preview.previewToken, expectedFamilyVersion: preview.preview.familyVersion }, randomUUID());
    const rotated = f.make({ activeKeyId: "new", keys: { new: newSecret } }); const unseal = vi.spyOn(rotated, "unseal");
    await expect(service(rotated, f.now).execute("invitation.create", payload, id)).rejects.toMatchObject({ code: "FORBIDDEN" }); expect(unseal).not.toHaveBeenCalled();
  });
  it("每次事务至少预留2秒；冲突推进到预算不足后不再启动下一次", async () => {
    const f = await setup(); let elapsed = 0; const store = f.make(keys, cursorSecret, () => elapsed); elapsed = 6001;
    const run = vi.spyOn(f.database, "runTransaction");
    await expect(store.transaction(async () => true)).rejects.toBeInstanceOf(FamilyBudgetExceededError); expect(run).not.toHaveBeenCalled();
    elapsed = 0; const retrying = f.make(keys, cursorSecret, () => elapsed);
    run.mockImplementationOnce(async () => { elapsed = 6500; throw { code: "DATABASE_TRANSACTION_CONFLICT" }; });
    await expect(retrying.transaction(async () => true)).rejects.toBeInstanceOf(FamilyBudgetExceededError); expect(run).toHaveBeenCalledTimes(1); run.mockRestore();
  });
  it("家庭冲突最多重试两次，文档操作和会话读写也检查共享deadline", async () => {
    const f = await setup(); let elapsed = 0; const store = f.make(keys, cursorSecret, () => elapsed);
    const run = vi.spyOn(f.database, "runTransaction").mockRejectedValue({ code: "DATABASE_TRANSACTION_CONFLICT" });
    await expect(store.transaction(async () => true)).rejects.toMatchObject({ code: "DATABASE_TRANSACTION_CONFLICT" }); expect(run).toHaveBeenCalledTimes(3); run.mockRestore();
    const before = structuredClone(f.database.documents);
    await expect(store.transaction(async tx => { const family = await tx.family(f.family.id); if (!family) throw new Error("Missing fixture"); elapsed = 8000; await tx.saveFamily({ ...family, name: "不得提交" }); })).rejects.toBeInstanceOf(FamilyBudgetExceededError);
    expect(f.database.documents).toEqual(before);
    await expect(store.readSession("invalid")).rejects.toBeInstanceOf(FamilyBudgetExceededError);
    await expect(store.saveSession({ expiresAt: f.now })).rejects.toBeInstanceOf(FamilyBudgetExceededError);
  });
  it("慢扫描在完整页边界续扫，active与recycle统计不丢失、不重复", async () => {
    const f = await setup(); const other = await familyFixture(f.database);
    const invite = await service(f.make(), f.now).execute("invitation.create", { familyId: f.family.id, expectedFamilyVersion: 1 }, randomUUID()); if (!isFamilyData("invitation.create", invite)) throw new Error("Missing fixture");
    const join = await service(new CloudBaseFamilyStore(f.database, other.identity, cursorSecret, keys), f.now).execute("invitation.accept", { token: invite.token, myName: "成员" }, randomUUID()); if (!isFamilyData("invitation.accept", join)) throw new Error("Missing fixture");
    for (let i = 0; i < 45; i++) await f.make().transaction(tx => tx.saveTask({ id: randomUUID(), ownerUserId: other.user.id, ownerName: "成员", title: "秘密", note: "", version: 1, segmentId: randomUUID(), occurrenceId: randomUUID(), date: null, time: null, lifecycle: i < 35 ? "active" : "deleted", status: "pending", occurrenceVersion: 0, actualCompletedAt: null, recordedAt: null, operatorName: null, reminderEnabled: false, reminderSelfDisabled: false, reminderVersion: 1, readAt: null, dismissedAt: null, createdAt: f.now, updatedAt: f.now, collaboration: { familyId: f.family.id, creatorMembershipId: join.membershipId, createdByUserId: other.user.id, ownerBinding: { kind: "membership", membershipId: join.membershipId }, subject: { kind: "member", membershipId: join.membershipId }, subjectName: "成员", viewerMembershipIds: [], helperMembershipIds: [] } }));
    let elapsed = 0; const slow = f.make(keys, cursorSecret, () => elapsed); const scan = slow.scanTasks.bind(slow);
    const spy = vi.spyOn(slow, "scanTasks").mockImplementation(async (...args) => { const page = await scan(...args); elapsed += 4100; return page; });
    const payload = { familyId: f.family.id, targetMembershipId: join.membershipId, mode: "remove" as const };
    const first = await service(slow, f.now).execute("family.previewExit", payload, randomUUID()); if (!isFamilyData("family.previewExit", first) || first.complete) throw new Error("Expected continuation");
    expect(spy).toHaveBeenCalledTimes(1); expect(first.preview).toBeNull(); expect((await f.make().readSession(first.nextCursor))?.ownedTaskCount).toBe(20);
    const finished = await service(f.make(), f.now).execute("family.previewExit", { ...payload, cursor: first.nextCursor }, randomUUID());
    expect(finished).toMatchObject({ complete: true, preview: { ownedTaskCount: 45, privateTaskCount: 45, createdManagementCount: 45 } });
  });
});
