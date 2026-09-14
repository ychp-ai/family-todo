import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPersonalData } from "@family-todo/contracts";
import type { OccurrenceDTO, OccurrenceRef, PersonalAction, PersonalActionMap, TaskDraft } from "@family-todo/contracts";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { CollaborativeTaskService } from "../packages/application/src/collaborative-tasks";
import { CloudBasePersonalStore } from "../packages/infra-cloudbase/src/personal-store";
import { familyFixture } from "./support/family-fixture";

function ref(o: OccurrenceDTO): OccurrenceRef { return { id: o.id, taskId: o.taskId, segmentId: o.segmentId, localDate: o.localDate, slot: o.slot }; }
async function fixture() {
  const f = await familyFixture(); let now = "2026-09-11T10:30:00.000Z";
  const call = async <K extends PersonalAction>(action: K, payload: PersonalActionMap[K]["payload"], requestId = randomUUID()) => {
    const service = new CollaborativeTaskService(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date(now) }, { generate: randomUUID });
    const result = await service.execute(action, payload, requestId); if (!isPersonalData(action, result)) throw new Error("Invalid result"); return result;
  };
  return { ...f, call, time: (value: string) => { now = value; } };
}
function draft(): TaskDraft { return { title: "每日安排", note: "", familyId: null, subject: { kind: "self" }, schedule: { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["08:00", "20:00"] }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } }; }

describe("recurring write closure", () => {
  it("creates sparse pending, rejects future writes, atomically records and replays", async () => {
    const f = await fixture(); const d = draft(); const created = await f.call("task.create", { draft: d });
    expect(created.task.schedule.kind).toBe("daily"); expect(created.nextOccurrences[0]?.slot).toBe("20:00");
    const o = created.nextOccurrences[0]; if (!o) throw new Error("Missing occurrence"); expect(o.version).toBe(0);
    await expect(f.call("occurrence.record", { occurrence: ref(o), expectedVersion: 0, status: "completed" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    f.time("2026-09-11T12:30:00.000Z"); const requestId = randomUUID(); const payload = { occurrence: ref(o), expectedVersion: 0, status: "completed" as const };
    const written = await f.call("occurrence.record", payload, requestId); expect(written.occurrence.version).toBe(1);
    expect(await f.call("occurrence.record", payload, requestId)).toEqual(written);
    const got = await f.call("task.get", { id: created.task.id, occurrence: ref(o) }); expect(got.occurrence?.status).toBe("completed");
    const undone = await f.call("occurrence.undo", { occurrence: ref(o), expectedVersion: 1 }); expect(undone.occurrence.version).toBe(2);
    expect([...f.database.documents.keys()].filter(k => k.startsWith("occurrence_states/"))).toHaveLength(1);
  });
  it("preserves due slots through editing and rejects obsolete future refs", async () => {
    const f = await fixture(); f.time("2026-09-11T22:30:00.000Z"); const d = draft();
    const created = await f.call("task.create", { draft: d }); const morning = created.nextOccurrences.find(o => o.slot === "08:00"), evening = created.nextOccurrences.find(o => o.slot === "20:00");
    if (!morning || !evening) throw new Error("Missing slots");
    f.time("2026-09-12T10:30:00.000Z"); d.schedule = { ...d.schedule, kind: "daily", startDate: "2026-09-11", endDate: null, times: ["19:00"] };
    await f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: d });
    const old = await f.call("task.get", { id: created.task.id, occurrence: ref(morning) }); expect(old.occurrence?.subject).toEqual(morning.subject);
    await expect(f.call("occurrence.record", { occurrence: ref(evening), expectedVersion: 0, status: "completed" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const result = await f.call("occurrence.record", { occurrence: ref(morning), expectedVersion: 0, status: "completed" }); expect(result.occurrence.status).toBe("completed");
  });
  it("restores paused, never loses irreversible stopped history, and rolls back failures", async () => {
    const f = await fixture(); const created = await f.call("task.create", { draft: draft() });
    const stopped = await f.call("task.stop", { id: created.task.id, expectedVersion: 1 });
    const deleted = await f.call("task.delete", { id: created.task.id, expectedVersion: stopped.task.version });
    const restored = await f.call("task.restore", { id: created.task.id, expectedVersion: deleted.version });
    expect(restored.task.lifecycle).toBe("paused"); expect(restored.task.capabilities.canResume).toBe(false);
    await expect(f.call("task.resume", { id: created.task.id, expectedVersion: restored.task.version })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const size = f.database.documents.size; f.database.failCollection = "schedule_controls";
    await expect(f.call("task.delete", { id: created.task.id, expectedVersion: restored.task.version })).rejects.toThrow();
    expect(f.database.documents.size).toBe(size); f.database.failCollection = null;
    expect((await f.call("task.get", { id: created.task.id })).task.version).toBe(restored.task.version);
  });
});

describe("recurring projection pages", () => {
  it("prefetches edited segments and resumes every unconsumed segment after a deadline", async () => {
    const f = await fixture(); f.time("2026-09-11T22:30:00.000Z"); const d = draft();
    const created = await f.call("task.create", { draft: d });
    f.time("2026-09-12T10:30:00.000Z"); d.schedule = { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["19:00", "21:00"] };
    await f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: d });
    const payload = { taskId: created.task.id, dateFrom: "2026-09-12", dateTo: "2026-09-13" };
    const clock = { now: () => new Date("2026-09-12T10:30:00.000Z") };
    const fast = f.store(); const segments = vi.spyOn(fast, "segments");
    const expected = await new OccurrenceLists(fast, clock).execute("occurrence.list", payload);
    if (!isPersonalData("occurrence.list", expected)) throw new Error("Invalid list");
    expect(expected.items.map(o => `${o.localDate}/${o.slot}`)).toEqual(["2026-09-12/08:00", "2026-09-12/19:00", "2026-09-12/21:00", "2026-09-13/19:00", "2026-09-13/21:00"]);
    expect(segments).toHaveBeenCalledTimes(1);
    const slow = f.store(); const read = slow.segments.bind(slow); let remaining = 8000;
    vi.spyOn(slow, "remainingBudgetMs").mockImplementation(() => remaining);
    vi.spyOn(slow, "segments").mockImplementation(async (...args) => { const page = await read(...args); remaining = 3500; return page; });
    const partial = await new OccurrenceLists(slow, clock).execute("occurrence.list", payload);
    if (!isPersonalData("occurrence.list", partial) || !partial.nextCursor) throw new Error("Expected continuation");
    expect(partial.items).toEqual([]);
    const resumed = await new OccurrenceLists(f.store(), clock).execute("occurrence.list", { ...payload, cursor: partial.nextCursor });
    expect(resumed).toEqual(expected);
  });
  it("pages across edited segments in actual occurrence order without duplicates", async () => {
    const f = await fixture(); f.time("2026-09-11T22:30:00.000Z"); const d = draft();
    const created = await f.call("task.create", { draft: d });
    f.time("2026-09-12T10:30:00.000Z"); d.schedule = { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["19:00", "21:00"] };
    await f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: d });
    let cursor: string | undefined; const slots: string[] = [];
    do {
      const page = await f.call("occurrence.list", { taskId: created.task.id, dateFrom: "2026-09-12", dateTo: "2026-09-13", limit: 1, ...(cursor ? { cursor } : {}) });
      slots.push(...page.items.map(o => `${o.localDate}/${o.slot}`)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(slots).toEqual(["2026-09-12/08:00", "2026-09-12/19:00", "2026-09-12/21:00", "2026-09-13/19:00", "2026-09-13/21:00"]);
  });
  it("loads all long absence backlog with empty continuation pages and final cumulative summary", async () => {
    const f = await fixture(); f.time("2026-01-01T00:30:00.000Z"); const d = draft();
    d.schedule = { kind: "daily", startDate: "2026-01-01", endDate: null, times: [] };
    await f.call("task.create", { draft: d }); f.time("2026-09-12T10:30:00.000Z");
    let cursor: string | undefined; let calls = 0; const ids: string[] = []; const dates: string[] = [];
    do {
      const page = await f.call("task.list", { familyId: null, overdue: true, limit: 50, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map(i => i.occurrence.id)); dates.push(...page.items.map(i => i.occurrence.localDate ?? ""));
      if (!page.complete) expect(page.summary).toBeNull(); else expect(page.summary?.pending).toBe(254);
      cursor = page.nextCursor ?? undefined; expect(++calls).toBeLessThan(60);
    } while (cursor);
    expect(new Set(ids).size).toBe(254); expect(ids).toHaveLength(254); expect(dates).toContain("2026-01-01");
    expect(dates[0]).toBe("2026-08-12"); // Latest 31-day window, dates ascending within the window.
  });
  it("retains due history during pause, excludes paused slots after resume, and freezes cursor revisions", async () => {
    const f = await fixture(); f.time("2026-09-11T22:30:00.000Z"); const created = await f.call("task.create", { draft: draft() });
    f.time("2026-09-12T10:30:00.000Z"); const paused = await f.call("task.pause", { id: created.task.id, expectedVersion: 1 });
    const page = await f.call("task.list", { dateFrom: "2026-09-12", dateTo: "2026-09-14", limit: 1 });
    expect(page.items.map(i => i.occurrence.slot)).toEqual(["08:00"]); expect(page.complete).toBe(true);
    f.time("2026-09-13T10:30:00.000Z"); await f.call("task.resume", { id: created.task.id, expectedVersion: paused.task.version });
    const all = await f.call("occurrence.list", { taskId: created.task.id, dateFrom: "2026-09-12", dateTo: "2026-09-14" });
    expect(all.items.map(o => `${o.localDate}/${o.slot}`)).toEqual(["2026-09-12/08:00", "2026-09-13/20:00", "2026-09-14/08:00", "2026-09-14/20:00"]);
    const first = await f.call("task.list", { dateFrom: "2026-09-12", dateTo: "2026-09-14", limit: 1 });
    expect(first.nextCursor).not.toBeNull(); await f.call("task.create", { draft: draft() });
    await expect(f.call("task.list", { dateFrom: "2026-09-12", dateTo: "2026-09-14", limit: 1, cursor: first.nextCursor ?? "" })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
  it("keeps per-occurrence reminder receipts independent and status overlays sparse", async () => {
    const f = await fixture(); f.time("2026-09-11T22:30:00.000Z"); const created = await f.call("task.create", { draft: draft() });
    f.time("2026-09-12T13:30:00.000Z"); const before = await f.call("reminder.list", {}); expect(before.items).toHaveLength(2);
    const first = before.items[0]; if (!first) throw new Error("Missing reminder");
    await f.call("reminder.dismiss", { occurrence: first.occurrence });
    const after = await f.call("reminder.list", {}); expect(after.items).toHaveLength(1); expect(after.items[0]?.occurrence.slot).toBe("20:00");
    await f.call("occurrence.record", { occurrence: first.occurrence, expectedVersion: 0, status: "skipped" });
    const list = await f.call("task.list", {}); expect(list.summary).toMatchObject({ skipped: 1, pending: 1, denominator: 1 });
    const history = await f.call("task.history", { taskId: created.task.id }); expect(history.items.some(e => e.kind === "occurrence.skipped")).toBe(true);
  });
  it("keeps legacy refs and legacy receipt replay across once to daily conversion", async () => {
    const f = await fixture(); const d = draft(); d.schedule = { kind: "once", date: "2026-09-12", time: "08:00" };
    const requestId = randomUUID(); const payload = { draft: d }; const created = await f.call("task.create", payload, requestId);
    const list = await f.call("task.list", { dateFrom: "2026-09-12", dateTo: "2026-09-12" }); expect(list.items[0]?.occurrence.id).toBe(created.nextOccurrences[0]?.id);
    await f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: draft() });
    expect(await f.call("task.create", payload, requestId)).toEqual(created);
  });
});

describe("recurring transactional boundaries", () => {
  it("allows only one same-version record and rolls back sparse state when the receipt fails", async () => {
    const f = await fixture(); const created = await f.call("task.create", { draft: draft() }); const o = created.nextOccurrences[0]; if (!o) throw new Error("Missing slot"); f.time("2026-09-11T13:00:00.000Z");
    f.database.failCollection = "idempotency_receipts";
    await expect(f.call("occurrence.record", { occurrence: ref(o), expectedVersion: 0, status: "completed" })).rejects.toThrow();
    expect([...f.database.documents.keys()].filter(k => k.startsWith("occurrence_states/"))).toHaveLength(0);
    expect((await f.call("task.get", { id: created.task.id })).task.version).toBe(1); f.database.failCollection = null;
    const results = await Promise.allSettled([f.call("occurrence.record", { occurrence: ref(o), expectedVersion: 0, status: "completed" }), f.call("occurrence.record", { occurrence: ref(o), expectedVersion: 0, status: "skipped" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("date-only creation has history immediately and resume never backfills its day", async () => {
    const f = await fixture(); const d = draft(); d.schedule = { kind: "daily", startDate: "2026-09-11", endDate: null, times: [] };
    const created = await f.call("task.create", { draft: d }); const first = await f.call("task.list", {}); expect(first.items).toHaveLength(1); expect(first.items[0]?.occurrence.canRecord).toBe(true);
    const once: TaskDraft = { ...d, schedule: { kind: "once", date: "2026-09-12", time: null } };
    await expect(f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: once })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const paused = await f.call("task.pause", { id: created.task.id, expectedVersion: 1 }); f.time("2026-09-12T10:00:00.000Z");
    await f.call("task.resume", { id: created.task.id, expectedVersion: paused.task.version });
    const page = await f.call("occurrence.list", { taskId: created.task.id, dateFrom: "2026-09-11", dateTo: "2026-09-13" });
    expect(page.items.map(o => o.localDate)).toEqual(["2026-09-11", "2026-09-13"]);
  });
});

describe("reviewed recurrence response consistency", () => {
  it("excludes daily/weekly from unscheduled and preserves legacy and converted-once refs", async () => {
    const f = await fixture(); const daily = await f.call("task.create", { draft: draft() });
    const weekly: TaskDraft = { ...draft(), schedule: { kind: "weekly", startDate: "2026-09-12", endDate: null, times: [], weekdays: [6] } };
    await f.call("task.create", { draft: weekly });
    expect((await f.call("task.list", { unscheduled: true })).items).toEqual([]);
    const once: TaskDraft = { ...draft(), schedule: { kind: "once", date: null, time: null } };
    const legacy = await f.call("task.create", { draft: once });
    const converted = await f.call("task.update", { id: daily.task.id, expectedVersion: 1, draft: once });
    if (!("nextOccurrences" in converted)) throw new Error("Missing converted result");
    const convertedOccurrence = converted.nextOccurrences[0]; if (!convertedOccurrence) throw new Error("Missing converted once");
    const listed = await f.call("task.list", { unscheduled: true }); expect(listed.items).toHaveLength(2);
    expect(listed.items.find(i => i.task.id === legacy.task.id)?.occurrence.id).toBe(legacy.nextOccurrences[0]?.id);
    const occurrence = listed.items.find(i => i.task.id === daily.task.id)?.occurrence; expect(occurrence).toEqual(convertedOccurrence);
    expect((await f.call("task.get", { id: daily.task.id })).occurrence).toEqual(occurrence);
    const written = await f.call("occurrence.record", { occurrence: ref(convertedOccurrence), expectedVersion: 0, status: "completed" });
    const after = await f.call("task.list", { unscheduled: true });
    expect(after.items.find(i => i.task.id === daily.task.id)?.occurrence).toEqual(written.occurrence);
    expect((await f.call("task.get", { id: daily.task.id })).occurrence).toEqual(written.occurrence);
    expect(after.summary).toMatchObject({ completed: 1, pending: 1 });
  });
  it.each(["completed", "skipped"] as const)("retains %s sparse state when only a date-only series title changes", async status => {
    const f = await fixture(); const d: TaskDraft = { ...draft(), schedule: { kind: "daily", startDate: "2026-09-11", endDate: null, times: [] } };
    const created = await f.call("task.create", { draft: d }); const occurrence = created.nextOccurrences[0]; if (!occurrence) throw new Error("Missing today");
    const written = await f.call("occurrence.record", { occurrence: ref(occurrence), expectedVersion: 0, status });
    const updated = await f.call("task.update", { id: created.task.id, expectedVersion: written.taskVersion, draft: { ...d, title: "只改标题" } });
    if (!("nextOccurrences" in updated)) throw new Error("Missing updated result");
    expect(updated.nextOccurrences[0]).toEqual(written.occurrence);
    expect((await f.call("task.get", { id: created.task.id })).occurrence).toEqual(written.occurrence);
    expect((await f.call("task.list", {})).items[0]?.occurrence).toEqual(written.occurrence);
  });
  it("retains an early completed converted once in an unchanged-schedule update response", async () => {
    const f = await fixture(); const created = await f.call("task.create", { draft: draft() });
    const once: TaskDraft = { ...draft(), schedule: { kind: "once", date: "2026-09-15", time: "08:00" } };
    const converted = await f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: once });
    if (!("nextOccurrences" in converted)) throw new Error("Missing conversion"); const o = converted.nextOccurrences[0]; if (!o) throw new Error("Missing once");
    const written = await f.call("occurrence.record", { occurrence: ref(o), expectedVersion: 0, status: "completed" });
    const updated = await f.call("task.update", { id: created.task.id, expectedVersion: written.taskVersion, draft: { ...once, title: "只改标题" } });
    if (!("nextOccurrences" in updated)) throw new Error("Missing update"); expect(updated.nextOccurrences[0]).toEqual(written.occurrence);
    expect((await f.call("task.get", { id: created.task.id })).occurrence).toEqual(written.occurrence);
    expect((await f.call("task.list", { dateFrom: "2026-09-15", dateTo: "2026-09-15" })).items[0]?.occurrence).toEqual(written.occurrence);
  });
});
