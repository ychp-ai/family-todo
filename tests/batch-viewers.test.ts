import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PersonalActionMap } from "@family-todo/contracts";
import { call, leave, progressBatchFixture, taskDraft } from "./support/progress-batch-fixture";

type Input = PersonalActionMap["task.batchAddViewers"]["payload"];
describe("batch append visibility", () => {
  it("appends viewers without replacing helpers, reminders or explicit selfDisabled choices", async () => {
    const f = await progressBatchFixture(); const draft = taskDraft(f.family.id);
    draft.access.viewerMembershipIds = [f.viewer.member.id]; draft.access.helperMembershipIds = [f.viewer.member.id]; draft.access.reminderMembershipIds = [f.viewer.member.id];
    const created = await call(f.creator, "task.create", { draft });
    const viewed = await call(f.viewer, "task.get", { id: created.task.id });
    await call(f.viewer, "reminder.setMine", { taskId: created.task.id, enabled: false, expectedVersion: viewed.task.myReminder.version });
    const before = await f.creator.store().readTask(created.task.id);
    const preferences = [...f.database.documents].filter(([k]) => k.startsWith("reminder_preferences/"));
    const result = await call(f.creator, "task.batchAddViewers", { items: [{ taskId: created.task.id, expectedVersion: 2, viewerMembershipIds: [f.owner.member.id, f.viewer.member.id] }] });
    expect(result).toEqual({ complete: true, results: [{ taskId: created.task.id, status: "succeeded", version: 3 }] });
    const after = await f.creator.store().readTask(created.task.id);
    expect(after?.collaboration?.viewerMembershipIds).toEqual(expect.arrayContaining(before?.collaboration?.viewerMembershipIds ?? []));
    expect(after?.collaboration?.helperMembershipIds).toEqual(before?.collaboration?.helperMembershipIds);
    expect([...f.database.documents].filter(([k]) => k.startsWith("reminder_preferences/"))).toEqual(preferences);
    expect((await call(f.owner, "task.get", { id: created.task.id })).task.myReminder.enabled).toBe(false);
  });
  it("durably records mixed per-item failures and never accepts duplicate IDs or changed parent payload", async () => {
    const f = await progressBatchFixture(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const own = await call(f.creator, "task.create", { draft: taskDraft(null) });
    const hidden = await call(f.owner, "task.create", { draft: taskDraft(f.family.id) });
    const missing = randomUUID(), requestId = randomUUID();
    const payload: Input = { items: [
      { taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] },
      { taskId: own.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] },
      { taskId: hidden.task.id, expectedVersion: 1, viewerMembershipIds: [] },
      { taskId: missing, expectedVersion: 1, viewerMembershipIds: [] },
    ] };
    const result = await call(f.creator, "task.batchAddViewers", payload, requestId);
    expect(result.complete).toBe(true); expect(result.results.map(r => r.status)).toEqual(["succeeded", "failed", "failed", "failed"]);
    expect(result.results[1]).toMatchObject({ error: { code: "INVALID_STATE" } });
    expect(result.results.slice(2)).toEqual(expect.arrayContaining([{ taskId: hidden.task.id, status: "failed", error: expect.objectContaining({ code: "NOT_FOUND" }) }]));
    expect(await call(f.creator, "task.batchAddViewers", payload, requestId)).toEqual(result);
    await expect(call(f.creator, "task.batchAddViewers", { items: payload.items.slice(1) }, requestId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const item = payload.items[0]; if (!item) throw new Error("Missing item");
    await expect(call(f.creator, "task.batchAddViewers", { items: [item, item] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const retry = await call(f.creator, "task.batchAddViewers", { items: [{ taskId: own.task.id, expectedVersion: 1, targetFamilyId: f.family.id, viewerMembershipIds: [f.viewer.member.id] }] });
    expect(retry.results[0]?.status).toBe("succeeded");
  });
  it("preserves a personal task's identity, schedule, state, reminder receipts and self-disable during atomic promotion", async () => {
    const f = await progressBatchFixture(); const draft = taskDraft(null); draft.access.remindMe = false;
    const created = await call(f.creator, "task.create", { draft });
    const task = await f.creator.store().readTask(created.task.id); if (!task) throw new Error("Missing task");
    await f.creator.store().transaction(tx => tx.saveTask({ ...task, readAt: f.creator.now, dismissedAt: f.creator.now }));
    const payload: Input = { items: [{ taskId: task.id, expectedVersion: 1, targetFamilyId: f.family.id, viewerMembershipIds: [f.viewer.member.id] }] };
    const result = await call(f.creator, "task.batchAddViewers", payload);
    expect(result.results[0]).toMatchObject({ status: "succeeded", version: 2 });
    const after = await f.creator.store().readTask(task.id);
    expect(after).toMatchObject({ id: task.id, occurrenceId: task.occurrenceId, segmentId: task.segmentId, date: task.date, time: task.time, title: task.title, note: task.note, status: task.status });
    const mine = await call(f.creator, "task.get", { id: task.id }); expect(mine.task.myReminder).toMatchObject({ enabled: false, selfDisabled: true });
    expect(mine.occurrence?.subject).toEqual({ kind: "user", userId: f.creator.user.id });
    const receipt = await f.creator.store().transaction(tx => tx.reminderReceipt(task.occurrenceId, f.creator.user.id)); expect(receipt).toMatchObject({ readAt: f.creator.now, dismissedAt: f.creator.now });
    const scope = await f.creator.store().transaction(tx => tx.scope(f.creator.user.id)); expect(scope.personalTaskCount).toBe(0);
  });
  it("handles different target families independently and rejects migration of an existing family task", async () => {
    const f = await progressBatchFixture(); const otherFamilyId = randomUUID(), membershipId = randomUUID();
    await f.creator.store().transaction(async tx => {
      await tx.saveFamily({ ...f.family, id: otherFamilyId, ownerMembershipId: membershipId, memberCount: 1 });
      await tx.saveMember({ ...f.creator.member, id: membershipId, familyId: otherFamilyId });
      await tx.saveSlot({ familyId: otherFamilyId, userId: f.creator.user.id, activeMembershipId: membershipId });
    });
    const familyTask = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const personalA = await call(f.creator, "task.create", { draft: taskDraft(null) });
    const personalB = await call(f.creator, "task.create", { draft: taskDraft(null) });
    const result = await call(f.creator, "task.batchAddViewers", { items: [
      { taskId: familyTask.task.id, expectedVersion: 1, targetFamilyId: otherFamilyId, viewerMembershipIds: [] },
      { taskId: personalA.task.id, expectedVersion: 1, targetFamilyId: otherFamilyId, viewerMembershipIds: [membershipId] },
      { taskId: personalB.task.id, expectedVersion: 1, targetFamilyId: f.family.id, viewerMembershipIds: [f.viewer.member.id] },
    ] });
    expect(result.results.map(item => item.status)).toEqual(["failed", "succeeded", "succeeded"]);
    expect((await f.creator.store().readTask(familyTask.task.id))?.collaboration?.familyId).toBe(f.family.id);
    expect((await f.creator.store().readTask(personalA.task.id))?.collaboration?.familyId).toBe(otherFamilyId);
  });
});

describe("batch durable continuation and failure recovery", () => {
  it("advances pending suffix under sustained 2100ms transactions before authorizing old successes", async () => {
    const f = await progressBatchFixture();
    const a = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const b = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const payload: Input = { items: [a, b].map(created => ({ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] })) }, requestId = randomUUID();
    const attempt = async () => {
      const store = f.creator.store(); let remaining = 8000;
      vi.spyOn(store, "remainingBudgetMs").mockImplementation(() => remaining);
      f.database.afterCommit = () => { remaining -= 2100; };
      try { return await call(f.creator, "task.batchAddViewers", payload, requestId, store); }
      finally { f.database.afterCommit = undefined; }
    };
    const first = await attempt();
    expect(first).toMatchObject({ complete: false, results: [{ taskId: a.task.id, status: "succeeded" }, { taskId: b.task.id, status: "pending" }] });
    const second = await attempt();
    expect(second).toMatchObject({ complete: false, results: [{ taskId: a.task.id, status: "pending" }, { taskId: b.task.id, status: "succeeded" }] });
    expect(second.results[0]).not.toHaveProperty("version");
    expect((await f.creator.store().readTask(b.task.id))?.version).toBe(2);
    const third = await attempt();
    expect(third).toMatchObject({ complete: true, results: [{ status: "succeeded", version: 2 }, { status: "succeeded", version: 2 }] });
    expect([...f.database.documents.values()].filter(row => row.kind === "task.accessChanged")).toHaveLength(2);
  });
  it("accepts exactly 20 independently committed items and rejects 21 before writes", async () => {
    const f = await progressBatchFixture(); const items: Input["items"] = [];
    for (let index = 0; index < 20; index++) {
      const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
      items.push({ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] });
    }
    const before = f.database.documents.size;
    await expect(call(f.creator, "task.batchAddViewers", { items: [...items, { taskId: randomUUID(), expectedVersion: 1, viewerMembershipIds: [] }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.database.documents.size).toBe(before);
    const result = await call(f.creator, "task.batchAddViewers", { items });
    expect(result.complete).toBe(true); expect(result.results).toHaveLength(20);
    expect(result.results.every(item => item.status === "succeeded")).toBe(true);
  });
  it("rechecks membership before a pending item executes after continuation", async () => {
    const f = await progressBatchFixture(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const payload: Input = { items: [{ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] }] }, requestId = randomUUID();
    const store = f.creator.store(); let remaining = 8000; vi.spyOn(store, "remainingBudgetMs").mockImplementation(() => remaining);
    f.database.afterCommit = () => { remaining = 1999; };
    expect(await call(f.creator, "task.batchAddViewers", payload, requestId, store)).toMatchObject({ complete: false, results: [{ status: "pending" }] });
    f.database.afterCommit = undefined;
    await leave(f.creator, f.owner);
    const result = await call(f.creator, "task.batchAddViewers", payload, requestId);
    expect(result).toMatchObject({ complete: true, results: [{ status: "failed", error: { code: "NOT_FOUND" } }] });
    expect((await f.owner.store().readTask(created.task.id))?.version).toBe(1);
  });
  it("replays a lost success response and concurrent same-ID submissions without duplicate effects", async () => {
    const f = await progressBatchFixture(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const payload: Input = { items: [{ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] }] }, requestId = randomUUID();
    const [first, second] = await Promise.all([call(f.creator, "task.batchAddViewers", payload, requestId), call(f.creator, "task.batchAddViewers", payload, requestId)]);
    const replay = await call(f.creator, "task.batchAddViewers", payload, requestId);
    expect(replay).toMatchObject({ complete: true, results: [{ status: "succeeded", version: 2 }] });
    expect([first, second].some(r => r.results[0]?.status === "succeeded")).toBe(true);
    expect((await f.creator.store().readTask(created.task.id))?.version).toBe(2);
    expect([...f.database.documents.values()].filter(row => row.kind === "task.accessChanged")).toHaveLength(1);
    expect([...f.database.documents.values()].filter(row => row.kind === "batch-child/v1")).toHaveLength(1);
    expect(await call(f.creator, "task.batchAddViewers", payload, requestId)).toEqual(replay);
  });
  it("keeps commit-unknown pending, resolves its durable child next time, and never executes it twice", async () => {
    const f = await progressBatchFixture(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const payload: Input = { items: [{ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] }] }, requestId = randomUUID();
    f.database.afterCommit = writes => { if (writes.some(w => w.data.kind === "batch-child/v1")) { f.database.afterCommit = undefined; throw new Error("Unknown commit transport failure"); } };
    const first = await call(f.creator, "task.batchAddViewers", payload, requestId);
    expect(first).toEqual({ complete: false, results: [{ taskId: created.task.id, status: "pending" }] });
    expect((await f.creator.store().readTask(created.task.id))?.version).toBe(2);
    expect(await call(f.creator, "task.batchAddViewers", payload, requestId)).toMatchObject({ complete: true, results: [{ status: "succeeded", version: 2 }] });
    expect([...f.database.documents.values()].filter(row => row.kind === "task.accessChanged")).toHaveLength(1);
  });
  it("preserves the complete original request over an 8-second invocation budget and starts no transaction below 2 seconds", async () => {
    const f = await progressBatchFixture(); const a = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) }); const b = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const payload: Input = { items: [a, b].map(created => ({ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] })) }, requestId = randomUUID();
    const store = f.creator.store(); let remaining = 8000;
    vi.spyOn(store, "remainingBudgetMs").mockImplementation(() => remaining);
    f.database.afterCommit = writes => { if (writes.some(w => w.data.kind === "batch-child/v1")) remaining = 1999; };
    const first = await call(f.creator, "task.batchAddViewers", payload, requestId, store); f.database.afterCommit = undefined;
    expect(first).toMatchObject({ complete: false, results: [{ status: "succeeded" }, { status: "pending" }] });
    expect((await f.creator.store().readTask(b.task.id))?.version).toBe(1);
    await expect(call(f.creator, "task.batchAddViewers", { items: payload.items.slice(1) }, requestId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const second = await call(f.creator, "task.batchAddViewers", payload, requestId); expect(second.complete).toBe(true); expect(second.results[0]).toEqual(first.results[0]);
    expect(second.results[1]).toMatchObject({ status: "succeeded", version: 2 });
  });
  it("keeps a durable version failure terminal even after the data changes and isolates action request IDs", async () => {
    const f = await progressBatchFixture(); const createId = randomUUID(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) }, createId);
    const payload: Input = { items: [{ taskId: created.task.id, expectedVersion: 2, viewerMembershipIds: [f.viewer.member.id] }] }, requestId = randomUUID();
    await expect(call(f.creator, "task.batchAddViewers", payload, createId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const first = await call(f.creator, "task.batchAddViewers", payload, requestId); expect(first.results[0]).toMatchObject({ status: "failed", error: { code: "VERSION_CONFLICT" } });
    await call(f.creator, "task.batchAddViewers", { items: [{ ...payload.items[0], taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [] }] });
    expect(await call(f.creator, "task.batchAddViewers", payload, requestId)).toEqual(first);
    const next = await call(f.creator, "task.batchAddViewers", payload); expect(next.results[0]).toMatchObject({ status: "succeeded", version: 3 });
    await expect(call(f.creator, "task.delete", { id: created.task.id, expectedVersion: 3 }, requestId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("hides old success after membership loss and never replaces or re-executes its immutable receipt", async () => {
    const f = await progressBatchFixture(); const created = await call(f.creator, "task.create", { draft: taskDraft(f.family.id) });
    const payload: Input = { items: [{ taskId: created.task.id, expectedVersion: 1, viewerMembershipIds: [f.viewer.member.id] }] }, requestId = randomUUID();
    await call(f.creator, "task.batchAddViewers", payload, requestId);
    const before = await f.creator.store().transaction(tx => tx.batchReceipt(f.creator.user.id, requestId, created.task.id));
    await leave(f.creator, f.owner);
    const replay = await call(f.creator, "task.batchAddViewers", payload, requestId);
    expect(replay).toMatchObject({ complete: true, results: [{ status: "failed", error: { code: "NOT_FOUND" } }] });
    expect(replay.results[0]).not.toHaveProperty("version");
    expect(await f.creator.store().transaction(tx => tx.batchReceipt(f.creator.user.id, requestId, created.task.id))).toEqual(before);
    expect((await f.owner.store().readTask(created.task.id))?.version).toBe(2);
  });
  it("rolls back a complex personal recurring promotion at max roster without crossing 80 physical documents", async () => {
    const f = await progressBatchFixture(20); const draft = taskDraft(null); draft.schedule = { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["20:30", "21:00", "21:30", "22:00", "22:30", "23:00"] }; draft.access.remindMe = false;
    const created = await call(f.creator, "task.create", { draft });
    const snapshot = await f.creator.store().readTask(created.task.id);
    const segments = [...f.database.documents].filter(([name]) => name.startsWith("schedule_segments/"));
    const payload: Input = { items: [{ taskId: created.task.id, expectedVersion: 1, targetFamilyId: f.family.id, viewerMembershipIds: f.actors.map(a => a.member.id) }] }, requestId = randomUUID();
    f.database.beforeSet = (_name, row) => { if (row.kind === "batch-child/v1") throw new Error("Failed child write"); };
    const failed = await call(f.creator, "task.batchAddViewers", payload, requestId); f.database.beforeSet = undefined;
    expect(failed.results[0]?.status).toBe("pending"); expect(await f.creator.store().readTask(created.task.id)).toEqual(snapshot);
    expect((await f.creator.store().context(f.family.id))?.family.taskCount).toBe(0);
    f.database.operations = [];
    const result = await call(f.creator, "task.batchAddViewers", payload, requestId);
    expect(result.results[0]).toMatchObject({ status: "succeeded", version: 2 });
    expect(Math.max(...f.database.operations)).toBeLessThanOrEqual(80);
    expect([...f.database.documents].filter(([name]) => name.startsWith("schedule_segments/"))).toEqual(segments);
    expect((await call(f.creator, "task.get", { id: created.task.id })).task.myReminder).toMatchObject({ enabled: false, selfDisabled: true });
    expect((await f.creator.store().readTask(created.task.id))?.collaboration?.viewerMembershipIds).toHaveLength(19);
  });
});
