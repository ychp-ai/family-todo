import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import type { PersonalActionMap } from "@family-todo/contracts";
import { call, leave, progressBatchFixture, taskDraft } from "./support/progress-batch-fixture";
import type { BatchActor } from "./support/progress-batch-fixture";

type Input = PersonalActionMap["progress.get"]["payload"];
async function complete(actor: BatchActor, input: Input) {
  let page = await call(actor, "progress.get", input); let count = 0;
  while (!page.complete) {
    expect(page.members).toBeNull(); if (!page.nextCursor || ++count > 1000) throw new Error("Progress failed to advance.");
    page = await call(actor, "progress.get", { ...input, cursor: page.nextCursor });
  }
  return page;
}

describe("visible subject progress", () => {
  it("returns honest empty progress and excludes private arrangements even for the family owner", async () => {
    const f = await progressBatchFixture(); const input = { familyId: f.family.id, date: "2026-09-11" };
    expect(await complete(f.owner, input)).toMatchObject({ members: [], complete: true, nextCursor: null });
    await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    expect((await complete(f.owner, input)).members).toEqual([]);
    expect((await complete(f.creator, input)).members).toEqual([{ subject: { kind: "member", membershipId: f.creator.member.id }, name: f.creator.member.name, completed: 0, pending: 1, skipped: 0, denominator: 1 }]);
    await leave(f.viewer, f.owner);
    await expect(call(f.viewer, "progress.get", input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps same-name identities distinct, future pending, and skipped outside denominator", async () => {
    const f = await progressBatchFixture();
    await f.creator.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveMember({ ...f.viewer.member, name: f.creator.member.name }); await tx.saveFamily({ ...family, version: family.version + 1 });
    });
    const a = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const b = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const d = taskDraft(f.family.id); d.subject = { kind: "member", membershipId: f.viewer.member.id }; d.schedule = { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["23:00"] };
    await call(f.creator, "task.create", { draft: d });
    const first = a.nextOccurrences[0], second = b.nextOccurrences[0]; if (!first || !second) throw new Error("Missing once occurrences");
    const ref = (o: typeof first) => ({ id: o.id, taskId: o.taskId, segmentId: o.segmentId, localDate: o.localDate, slot: o.slot });
    await call(f.creator, "occurrence.record", { occurrence: ref(first), expectedVersion: 0, status: "completed" });
    await call(f.creator, "occurrence.record", { occurrence: ref(second), expectedVersion: 0, status: "skipped" });
    const result = await complete(f.creator, { familyId: f.family.id, date: "2026-09-11" });
    expect(result.members).toHaveLength(2);
    expect(result.members).toEqual(expect.arrayContaining([
      { subject: { kind: "member", membershipId: f.creator.member.id }, name: f.creator.member.name, completed: 1, pending: 0, skipped: 1, denominator: 1 },
      { subject: { kind: "member", membershipId: f.viewer.member.id }, name: f.creator.member.name, completed: 0, pending: 1, skipped: 0, denominator: 1 },
    ]));
    expect(result.members?.every(member => member.denominator === member.completed + member.pending)).toBe(true);
  });
  it("groups old slots by inactive historical virtual subject and future slots by the new subject", async () => {
    const f = await progressBatchFixture(); const virtualId = randomUUID(); f.creator.now = "2026-09-10T23:00:00.000Z";
    await f.creator.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveVirtualMember({ id: virtualId, familyId: family.id, name: "旧称呼", status: "active", version: 1, createdAt: f.creator.now, updatedAt: f.creator.now });
      await tx.saveFamily({ ...family, version: family.version + 1, virtualMemberCount: 1 });
    });
    const d = taskDraft(f.family.id); d.subject = { kind: "virtual", virtualMemberId: virtualId }; d.schedule = { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["08:00", "20:00"] };
    const created = await call(f.creator, "task.create", { draft: d });
    f.creator.now = "2026-09-11T01:00:00.000Z"; d.subject = { kind: "self" };
    await call(f.creator, "task.update", { id: created.task.id, expectedVersion: 1, draft: d });
    await f.creator.store().transaction(async tx => {
      const family = await tx.family(f.family.id), member = await tx.virtualMember(virtualId); if (!family || !member) throw new Error("Missing data");
      await tx.saveVirtualMember({ ...member, name: "后来改名", status: "inactive", version: 2 }); await tx.saveFamily({ ...family, version: family.version + 1, virtualMemberCount: 0 });
    });
    const input = { familyId: f.family.id, date: "2026-09-11" };
    const result = await complete(f.creator, input);
    expect(result.members).toEqual(expect.arrayContaining([{ subject: { kind: "virtual", virtualMemberId: virtualId }, name: "旧称呼", completed: 0, pending: 1, skipped: 0, denominator: 1 }]));
    expect(result.members).toHaveLength(2);
    const filtered = await complete(f.creator, { ...input, subject: { kind: "virtual", virtualMemberId: virtualId } });
    expect(filtered.members).toHaveLength(1); expect(filtered.members?.[0]?.name).toBe("旧称呼");
  });
  it("keeps incomplete totals private and binds cursors to actor, filter, asOf, revisions and 15-minute expiry", async () => {
    const f = await progressBatchFixture(); const input = { familyId: f.family.id, date: "2026-09-11" };
    for (let i = 0; i < 22; i++) { const d = taskDraft(f.family.id); d.access.viewerMembershipIds = [f.viewer.member.id]; await call(f.creator, "task.create", { draft: d }); }
    const page = await call(f.creator, "progress.get", input); expect(page.members).toBeNull(); expect(page.complete).toBe(false); if (!page.nextCursor) throw new Error("No cursor");
    const result = await complete(f.creator, { ...input, cursor: page.nextCursor }); expect(result.members?.[0]?.pending).toBe(22); expect(result.asOf).toBe(page.asOf);
    await expect(call(f.viewer, "progress.get", { ...input, cursor: page.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(call(f.creator, "progress.get", { ...input, date: "2026-09-12", cursor: page.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(call(f.creator, "progress.get", { ...input, subject: { kind: "member", membershipId: f.creator.member.id }, cursor: page.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    f.creator.now = "2026-09-11T12:15:00.000Z";
    await expect(call(f.creator, "progress.get", { ...input, cursor: page.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    f.creator.now = "2026-09-11T12:00:00.000Z";
    await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    await expect(call(f.creator, "progress.get", { ...input, cursor: page.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
  it("does not publish zero totals for a failed family and checks permission again before returning final members", async () => {
    const f = await progressBatchFixture(); const input = { familyId: f.family.id, date: "2026-09-11" };
    const store = f.creator.store(); vi.spyOn(store, "context").mockRejectedValue(new Error("Unavailable context"));
    await expect(call(f.creator, "progress.get", input, randomUUID(), store)).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
    const d = taskDraft(f.family.id); d.access.viewerMembershipIds = [f.viewer.member.id]; await call(f.creator, "task.create", { draft: d });
    const ready = await call(f.viewer, "progress.get", input); if (!ready.nextCursor) throw new Error("No final cursor");
    const replayStore = f.viewer.store(), read = replayStore.readSession.bind(replayStore); let changed = false;
    vi.spyOn(replayStore, "readSession").mockImplementation(async token => {
      const value = await read(token);
      if (value?.kind === "progress-node" && !changed) { changed = true; await leave(f.viewer, f.owner); }
      return value;
    });
    await expect(call(f.viewer, "progress.get", { ...input, cursor: ready.nextCursor }, randomUUID(), replayStore)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("advances an empty partial source page and gives final materialization a fresh budget", async () => {
    const f = await progressBatchFixture(); await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const input = { familyId: f.family.id, date: "2026-09-11" }; const store = f.creator.store();
    vi.spyOn(store, "remainingBudgetMs").mockReturnValue(3500);
    const first = await call(f.creator, "progress.get", input, randomUUID(), store);
    expect(first).toMatchObject({ complete: false, members: null }); if (!first.nextCursor) throw new Error("Missing cursor");
    const result = await complete(f.creator, { ...input, cursor: first.nextCursor }); expect(result.members?.[0]?.pending).toBe(1);
    const ready = await call(f.creator, "progress.get", input); if (!ready.nextCursor) throw new Error("Missing ready cursor");
    const limited = f.creator.store(); vi.spyOn(limited, "remainingBudgetMs").mockReturnValue(2500);
    await expect(call(f.creator, "progress.get", { ...input, cursor: ready.nextCursor }, randomUUID(), limited)).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
    expect((await complete(f.creator, { ...input, cursor: ready.nextCursor })).members).toEqual(result.members);
  });
  it("retains more than the active roster in bounded immutable accumulator nodes", async () => {
    const f = await progressBatchFixture(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const occurrence = created.nextOccurrences[0]; if (!occurrence) throw new Error("Missing occurrence");
    // Exercise accumulator splitting independently of the source's already-tested task scan.
    const rows = Array.from({ length: 301 }, () => ({ task: created.task, occurrence: { ...occurrence, id: randomUUID(), subject: { kind: "user" as const, userId: randomUUID() }, subjectName: "历史家人" } }));
    const source = vi.spyOn(OccurrenceLists.prototype, "execute").mockImplementation(async (_action, payload) => {
      if (typeof payload !== "object" || payload === null) throw new Error("Invalid source query");
      const offset = "cursor" in payload && typeof payload.cursor === "string" ? Number(payload.cursor) : 0;
      const items = rows.slice(offset, offset + 20); const done = offset + items.length === rows.length;
      return { items, complete: done, nextCursor: done ? null : String(offset + items.length), asOf: f.creator.now, scopes: [{ familyId: f.family.id, status: done ? "ok" : "partial" }], summary: done ? { completed: 0, pending: 301, skipped: 0, denominator: 301 } : null };
    });
    const input = { familyId: f.family.id, date: "2026-09-11" }; const first = await call(f.creator, "progress.get", input); if (!first.nextCursor) throw new Error("Missing cursor");
    const result = await complete(f.creator, { ...input, cursor: first.nextCursor }); expect(result.members).toHaveLength(301);
    expect(result.members?.reduce((sum, member) => sum + member.denominator, 0)).toBe(301);
    const sessions = [...f.database.documents.entries()].filter(([k]) => k.startsWith("query_sessions/"));
    expect(sessions.every(([, row]) => Buffer.byteLength(JSON.stringify(row), "utf8") <= 128 * 1024)).toBe(true);
    const repeated = await complete(f.creator, { ...input, cursor: first.nextCursor }); expect(repeated).toEqual(result); source.mockRestore();
  }, 30000);
});
