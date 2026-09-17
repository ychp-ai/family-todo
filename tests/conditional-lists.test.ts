import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isFamilyData, isPersonalData, isUnchangedList, isPersonalPayload, isFamilyPayload } from "@family-todo/contracts";
import type { FamilyAction, FamilyActionMap, PersonalAction, PersonalActionMap, TaskDraft, ListCache } from "@family-todo/contracts";
import { FamilyService } from "../packages/application/src/family";
import { CollaborativeTaskService } from "../packages/application/src/collaborative-tasks";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { CloudBasePersonalStore } from "../packages/infra-cloudbase/src/personal-store";
import { familyFixture } from "./support/family-fixture";
import { listBatchFixture } from "./support/list-batch-fixture";
import { measureApi } from "../packages/infra-cloudbase/src/api-metrics";

async function fixture() {
  const f = await familyFixture(); let now = "2026-09-16T00:00:00.000Z";
  const clock = { now: () => new Date(now) };
  const family = async <A extends FamilyAction>(action: A, payload: FamilyActionMap[A]["payload"]) => {
    const value = await new FamilyService(f.store(), clock, { generate: randomUUID }).execute(action, payload, randomUUID());
    if (!isFamilyData(action, value)) throw new Error("Invalid family data"); return value;
  };
  const task = async <A extends PersonalAction>(action: A, payload: PersonalActionMap[A]["payload"]) => {
    const value = await new CollaborativeTaskService(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-cursor-and-encryption-secret"), clock, { generate: randomUUID }).execute(action, payload, randomUUID());
    if (!isPersonalData(action, value)) throw new Error("Invalid personal data"); return value;
  };
  const created = await family("family.create", { name: "家", myName: "我" });
  const draft = (schedule: TaskDraft["schedule"]): TaskDraft => ({ familyId: created.family.id, title: "事项", note: "", subject: { kind: "self" }, schedule, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } });
  return { ...f, clock, family, task, draft, familyId: created.family.id, memberId: created.family.myMembershipId, setTime: (value: string) => { now = value; } };
}
function cache(v: { cache?: ListCache } | { unchanged: true }): ListCache { if (!("cache" in v) || !v.cache) throw new Error("Missing validator"); return v.cache; }
const once = { kind: "once" as const, date: "2026-09-16", time: "09:00" };
const daily = { kind: "daily" as const, startDate: "2026-09-16", endDate: null, times: ["09:00"] };

describe("conditional complete-list contract", () => {
  it("accepts old and opt-in requests, rejecting token+cursor and malformed tokens", () => {
    for (const action of ["task.list", "reminder.list"] as const) {
      expect(isPersonalPayload(action, {})).toBe(true);
      expect(isPersonalPayload(action, { conditional: {}, cursor: "next" })).toBe(true);
      expect(isPersonalPayload(action, { conditional: { token: "valid" } })).toBe(true);
      expect(isPersonalPayload(action, { conditional: { token: "valid" }, cursor: "next" })).toBe(false);
      expect(isPersonalPayload(action, { conditional: { token: "" } })).toBe(false);
      expect(isPersonalPayload(action, { conditional: { token: 1 } })).toBe(false);
      expect(isPersonalData(action, { unchanged: true, token: "valid" })).toBe(false);
      expect(isPersonalData(action, { unchanged: true, token: "valid", serverTime: "2026-09-16T00:00:00.000Z" })).toBe(true);
    }
    expect(isFamilyPayload("family.list", { conditional: {}, cursor: "next" })).toBe(true);
    expect(isFamilyPayload("family.list", { conditional: { token: "valid" }, cursor: "next" })).toBe(false);
  });
  it("rejects partial/failed pages with cache and unchanged masquerading as an empty page", () => {
    const asOf = "2026-09-16T00:00:00.000Z", end = "2026-09-16T00:15:00.000Z";
    const page = { items: [], nextCursor: null, complete: true, asOf, serverTime: asOf, cache: { token: "valid", nextInvalidationAt: end, expiresAt: end }, scopes: [{ familyId: null, status: "ok" }], summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } };
    expect(isPersonalData("task.list", page)).toBe(true);
    expect(isPersonalData("task.list", { ...page, scopes: [{ familyId: null, status: "failed" }] })).toBe(false);
    expect(isPersonalData("task.list", { ...page, complete: false, nextCursor: "next" })).toBe(false);
    expect(isPersonalData("task.list", { ...page, unchanged: true })).toBe(false);
  });
});

describe("conditional list snapshots", () => {
  it.each(["once", "daily"] as const)("empty reminders gain %s due items exactly at the recorded boundary", async kind => {
    const f = await fixture(); await f.task("task.create", { draft: f.draft(kind === "once" ? once : daily) });
    f.setTime("2026-09-16T00:59:59.999Z");
    const first = await f.task("reminder.list", { conditional: {} });
    if (isUnchangedList(first)) throw new Error("Expected full");
    expect(first.items).toEqual([]); expect(cache(first).nextInvalidationAt).toBe("2026-09-16T01:00:00.000Z");
    expect(isUnchangedList(await f.task("reminder.list", { conditional: { token: cache(first).token } }))).toBe(true);
    f.setTime("2026-09-16T01:00:00.000Z");
    const due = await f.task("reminder.list", { conditional: { token: cache(first).token } });
    if (isUnchangedList(due)) throw new Error("Due boundary reused"); expect(due.items).toHaveLength(1);
  });
  it("changes recurring canRecord at due time and date-only at Shanghai midnight", async () => {
    const f = await fixture(); await f.task("task.create", { draft: f.draft(daily) });
    f.setTime("2026-09-16T00:59:59.999Z");
    const first = await f.task("task.list", { view: "summary", conditional: {} });
    if (isUnchangedList(first)) throw new Error("Expected full"); expect(first.items[0]?.occurrence.canRecord).toBe(false);
    f.setTime("2026-09-16T01:00:00.000Z");
    const due = await f.task("task.list", { view: "summary", conditional: { token: cache(first).token } });
    if (isUnchangedList(due)) throw new Error("Due boundary reused"); expect(due.items[0]?.occurrence.canRecord).toBe(true);
    await f.task("task.create", { draft: f.draft({ ...daily, times: [] }) });
    f.setTime("2026-09-16T15:59:59.999Z");
    const input = { dateFrom: "2026-09-17", dateTo: "2026-09-17", view: "summary" as const };
    const tomorrow = await f.task("task.list", { ...input, conditional: {} });
    if (isUnchangedList(tomorrow)) throw new Error("Expected full"); expect(tomorrow.items.every(item => !item.occurrence.canRecord)).toBe(true);
    expect(cache(tomorrow).nextInvalidationAt).toBe("2026-09-16T16:00:00.000Z");
    f.setTime("2026-09-16T16:00:00.000Z");
    const midnight = await f.task("task.list", { ...input, conditional: { token: cache(tomorrow).token } });
    if (isUnchangedList(midnight)) throw new Error("Midnight reused"); expect(midnight.items.find(item => item.occurrence.time === null)?.occurrence.canRecord).toBe(true);
  });
  it("family lists expire naturally without a midnight boundary, unscheduled lists participate", async () => {
    const f = await fixture(); await f.task("task.create", { draft: f.draft({ kind: "once", date: null, time: null }) });
    const unscheduled = await f.task("task.list", { unscheduled: true, conditional: {} });
    expect(isUnchangedList(await f.task("task.list", { unscheduled: true, conditional: { token: cache(unscheduled).token } }))).toBe(true);
    expect(isUnchangedList(await f.task("task.list", { conditional: { token: cache(unscheduled).token } }))).toBe(false);
    f.setTime("2026-09-16T15:59:59.999Z");
    const first = await f.family("family.list", { conditional: {} });
    f.setTime("2026-09-16T16:00:00.000Z");
    expect(isUnchangedList(await f.family("family.list", { conditional: { token: cache(first).token } }))).toBe(true);
    f.setTime(cache(first).expiresAt);
    expect(isUnchangedList(await f.family("family.list", { conditional: { token: cache(first).token } }))).toBe(false);
  });
  it.each(["reminder.markRead", "reminder.dismiss"] as const)("%s invalidates specified-family tokens by actor scope only", async action => {
    const f = await fixture(); const task = await f.task("task.create", { draft: f.draft(once) });
    f.setTime("2026-09-16T01:00:00.000Z");
    const input = { familyId: f.familyId, view: "summary" as const };
    const first = await f.task("task.list", { ...input, conditional: {} });
    const reminders = await f.task("reminder.list", { conditional: {} }); if (isUnchangedList(reminders)) throw new Error("Expected full");
    const occurrence = reminders.items[0]?.occurrence; if (!occurrence) throw new Error("Missing reminder");
    const before = await f.store().transaction(async tx => ({ family: await tx.family(f.familyId), scope: await tx.scope(f.user.id) }));
    await f.task(action, { occurrence });
    const after = await f.store().transaction(async tx => ({ family: await tx.family(f.familyId), scope: await tx.scope(f.user.id) }));
    expect(after.family?.version).toBe(before.family?.version); expect(after.scope.revision).toBeGreaterThan(before.scope.revision);
    expect(isUnchangedList(await f.task("task.list", { ...input, conditional: { token: cache(first).token } }))).toBe(false);
    expect(isUnchangedList(await f.task("reminder.list", { conditional: { token: cache(reminders).token } }))).toBe(false);
    expect(task.task.id).toBe(occurrence.taskId);
  });
  it("family writes and scope changes invalidate family and task validators", async () => {
    const f = await fixture(); const first = await f.family("family.list", { conditional: {} });
    const tasks = await f.task("task.list", { conditional: {} });
    const family = await f.family("family.get", { id: f.familyId });
    await f.family("family.update", { id: f.familyId, expectedVersion: family.family.version, name: "新名称" });
    expect(isUnchangedList(await f.family("family.list", { conditional: { token: cache(first).token } }))).toBe(false);
    expect(isUnchangedList(await f.task("task.list", { conditional: { token: cache(tasks).token } }))).toBe(false);
    const beforeJoin = await f.family("family.list", { conditional: {} });
    await f.family("family.create", { name: "第二个家", myName: "我" });
    const afterJoin = await f.family("family.list", { conditional: { token: cache(beforeJoin).token } });
    if (isUnchangedList(afterJoin)) throw new Error("Scope reused"); expect(afterJoin.items).toHaveLength(2);
  });
  it("withdrawal never reuses a snapshot and scoped reads retain access errors", async () => {
    const f = await fixture(); const all = await f.task("task.list", { conditional: {} });
    const scoped = await f.task("task.list", { familyId: f.familyId, conditional: {} });
    await f.store().transaction(async tx => {
      const member = await tx.member(f.memberId); if (!member) throw new Error("Missing member");
      await tx.saveMember({ ...member, status: "removed" }); await tx.saveSlot({ familyId: f.familyId, userId: f.user.id, activeMembershipId: null });
      const scope = await tx.scope(f.user.id); await tx.saveScope({ ...scope, revision: scope.revision + 1, activeFamilyCount: 0 });
    });
    const result = await f.task("task.list", { conditional: { token: cache(all).token } });
    if (isUnchangedList(result)) throw new Error("Withdrawal reused"); expect(result.scopes.map(scope => scope.familyId)).toEqual([null]);
    await expect(f.task("task.list", { familyId: f.familyId, conditional: { token: cache(scoped).token } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("binds actor, null/undefined family scope, filters and representation; unknown tokens fall back", async () => {
    const f = await fixture(); const first = await f.task("task.list", { conditional: {} }); const token = cache(first).token;
    for (const input of [{ familyId: null }, { view: "summary" as const }, { status: "completed" as const }, { limit: 50 }, { dateFrom: "2026-09-17", dateTo: "2026-09-17" }]) expect(isUnchangedList(await f.task("task.list", { ...input, conditional: { token } }))).toBe(false);
    const reminder = await f.task("reminder.list", { conditional: {} });
    expect(isUnchangedList(await f.task("reminder.list", { includeDismissed: true, conditional: { token: cache(reminder).token } }))).toBe(false);
    expect(isUnchangedList(await f.task("task.list", { conditional: { token: "unknown" } }))).toBe(false);
    const other = await familyFixture(f.database);
    const value = await new OccurrenceLists(other.store(), f.clock).execute("task.list", { conditional: { token } });
    expect(isUnchangedList(value)).toBe(false);
    // Legacy clients retain exact normal shape and cause no validator writes.
    const before = [...f.database.documents.keys()].filter(key => key.startsWith("query_sessions/")).length;
    const old = await f.task("task.list", {}); expect(Object.keys(old).sort()).toEqual(["asOf", "complete", "items", "nextCursor", "scopes", "summary"]);
    expect([...f.database.documents.keys()].filter(key => key.startsWith("query_sessions/")).length).toBe(before);
  });
  it("rejects mismatched membership metadata even without a version change", async () => {
    const f = await fixture(); const first = await f.family("family.list", { conditional: {} });
    await f.store().transaction(async tx => { const member = await tx.member(f.memberId); if (!member) throw new Error("Missing member"); await tx.saveMember({ ...member, status: "removed" }); });
    await expect(f.family("family.list", { conditional: { token: cache(first).token } })).rejects.toThrow();
  });
  it("accumulates boundaries across pages, rejects legacy proof and crossing during a scan", async () => {
    const f = await fixture(); await f.task("task.create", { draft: f.draft(daily) }); await f.task("task.create", { draft: f.draft({ ...daily, times: ["10:00"] }) });
    f.setTime("2026-09-16T00:59:59.999Z");
    const input = { view: "summary" as const, limit: 1 };
    const first = await f.task("task.list", { ...input, conditional: {} });
    if (isUnchangedList(first) || !first.nextCursor) throw new Error("Expected continuation"); expect(first.cache).toBeUndefined();
    const last = await f.task("task.list", { ...input, conditional: {}, cursor: first.nextCursor });
    expect(cache(last).nextInvalidationAt).toBe("2026-09-16T01:00:00.000Z");
    const sessionId = first.nextCursor.split(".")[0]; const saved = f.database.documents.get(`query_sessions/${sessionId}`); if (!saved) throw new Error("Missing session");
    delete saved.nextInvalidationAt;
    const legacy = await f.task("task.list", { ...input, conditional: {}, cursor: first.nextCursor }); expect(legacy).not.toHaveProperty("cache");
    saved.nextInvalidationAt = "2026-09-16T01:00:00.000Z";
    f.setTime("2026-09-16T01:00:00.000Z");
    const crossed = await f.task("task.list", { ...input, conditional: {}, cursor: first.nextCursor }); expect(crossed).not.toHaveProperty("cache");
  });
  it("preserves missing legacy family proof across intermediate continuation pages", async () => {
    const f = await fixture();
    await f.family("family.create", { name: "第二家", myName: "我" });
    await f.family("family.create", { name: "第三家", myName: "我" });
    const first = await f.family("family.list", { limit: 1, conditional: {} });
    if (isUnchangedList(first) || !first.nextCursor) throw new Error("Expected first cursor");
    const saved = f.database.documents.get(`query_sessions/${first.nextCursor.split(".")[0]}`);
    if (!saved) throw new Error("Missing first session");
    expect(saved.validationProof).toBe(true);
    delete saved.validationProof;
    const middle = await f.family("family.list", { limit: 1, conditional: {}, cursor: first.nextCursor });
    if (isUnchangedList(middle) || !middle.nextCursor) throw new Error("Expected intermediate cursor");
    expect(middle).not.toHaveProperty("cache");
    expect(f.database.documents.get(`query_sessions/${middle.nextCursor.split(".")[0]}`)?.validationProof).not.toBe(true);
    const final = await f.family("family.list", { limit: 1, conditional: {}, cursor: middle.nextCursor });
    expect(final).toMatchObject({ complete: true, nextCursor: null });
    expect(final).not.toHaveProperty("cache");
  });
  it("never issues a validator for failed scopes", async () => {
    const f = await fixture(), store = f.store(); vi.spyOn(store, "context").mockResolvedValue(null);
    const value = await new OccurrenceLists(store, f.clock).execute("task.list", { conditional: {} });
    expect(value).not.toHaveProperty("cache"); expect(value).toMatchObject({ complete: true, summary: null });
  });
});

describe("fixed ten-minute conditional read benchmark", () => {
  it("reuses immutable metadata with no scanning or session renewal for 20 logical refreshes", async () => {
    const f = await listBatchFixture(); let now = f.clock.now().toISOString(); const clock = { now: () => new Date(now) };
    const logs: { mode: string; action: string; metric: Record<string, unknown> }[] = [];
    const run = async (action: "task.list" | "reminder.list" | "family.list", mode: string, payload: Record<string, unknown>) => {
      const requestId = f.generate();
      const response = await measureApi({ apiVersion: 1, action, requestId, payload }, async () => ({ ok: true as const, requestId, data: action === "family.list" ? await new FamilyService(f.store(), clock, { generate: f.generate }).execute(action, payload, requestId) : await new OccurrenceLists(f.store(), clock).execute(action, payload) }), log => logs.push({ mode, action, metric: JSON.parse(log) }), { detailedDatabase: true });
      if (!response.ok) throw new Error("Unexpected failure");
      if (!(isFamilyData("family.list", response.data) || isPersonalData("task.list", response.data) || isPersonalData("reminder.list", response.data))) throw new Error("Invalid result");
      return response.data;
    };
    const tokens = new Map<string, string>();
    const inputs = { "task.list": { view: "summary", limit: 20, familyId: f.familyId }, "reminder.list": { limit: 20 }, "family.list": { limit: 20 } };
    const full = async (action: keyof typeof inputs, mode: string, conditional = false) => {
      let cursor: string | undefined;
      do { const page = await run(action, mode, { ...inputs[action], ...(conditional ? { conditional: {} } : {}), ...(cursor ? { cursor } : {}) });
        if (isUnchangedList(page)) throw new Error("Expected full page"); cursor = page.nextCursor ?? undefined;
        if (page.cache) tokens.set(action, page.cache.token);
      } while (cursor);
    };
    for (const action of Object.keys(inputs) as (keyof typeof inputs)[]) await full(action, "initial", true);
    const saved = structuredClone([...f.database.documents].filter(([key]) => key.startsWith("query_sessions/")));
    for (let tick = 1; tick <= 20; tick++) {
      now = new Date(f.clock.now().getTime() + tick * 30000).toISOString();
      for (const action of Object.keys(inputs) as (keyof typeof inputs)[]) {
        const hit = await run(action, "hit", { ...inputs[action], conditional: { token: tokens.get(action) } });
        expect(isUnchangedList(hit)).toBe(true);
      }
    }
    expect([...f.database.documents].filter(([key]) => key.startsWith("query_sessions/"))).toEqual(saved);
    for (let tick = 1; tick <= 20; tick++) {
      now = new Date(f.clock.now().getTime() + tick * 30000).toISOString();
      for (const action of Object.keys(inputs) as (keyof typeof inputs)[]) await full(action, "baseline");
    }
    const sum = (mode: string, action: string, field: string) => logs.filter(row => row.mode === mode && row.action === action).reduce((total, row) => total + Number(row.metric[field]), 0);
    const report = Object.keys(inputs).map(action => ({ action, initial: Object.fromEntries(["documentReads", "queries", "documentWrites", "transactions"].map(field => [field, sum("initial", action, field)])), hits: Object.fromEntries(["documentReads", "queries", "documentWrites", "transactions"].map(field => [field, sum("hit", action, field)])), baseline: Object.fromEntries(["documentReads", "queries", "documentWrites", "transactions"].map(field => [field, sum("baseline", action, field)])), hitOperations: logs.find(row => row.mode === "hit" && row.action === action)?.metric.databaseOperations }));
    for (const result of report) { expect(result.hits.queries).toBe(0); expect(result.hits.documentWrites).toBe(0); expect(result.hits.documentReads).toBe(140); expect(result.hits.transactions).toBe(20); }
    console.log("C1_TEN_MINUTE " + JSON.stringify(report));
  });
});
