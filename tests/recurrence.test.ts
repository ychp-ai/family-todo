import { seedLegacyTask } from "./support/legacy-task";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { projectOccurrences } from "@family-todo/domain";
import { overlayOccurrence, overlayOccurrences, projectionTask } from "../packages/application/src/recurrence-projection";
import { isFullPersonalData as isPersonalData } from "./support/full-data";
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
    const result = action === "task.create" && "draft" in payload && !payload.draft.familyId
    ? await seedLegacyTask(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date(now) }, { generate: randomUUID }, payload.draft, requestId)
    : await service.execute(action, payload, requestId); if (!isPersonalData(action, result)) throw new Error("Invalid result"); return result;
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
  it("matches single overlays across pause/resume boundaries, including an exact due instant", async () => {
    const f = await fixture(); const created = await f.call("task.create", { draft: draft() });
    const store = f.store(); const task = await store.readTask(created.task.id);
    if (!task?.recurrence) throw new Error("Missing recurring task");
    const segment = await store.readSegment(task.recurrence.currentSegmentId);
    if (!segment) throw new Error("Missing segment");
    await store.transaction(async tx => {
      await tx.saveControl({ id: randomUUID(), taskId: task.id, kind: "pause", effectiveAt: "2026-09-12T00:00:00.000Z", taskVersion: 2, enabled: false, stopped: false });
      await tx.saveControl({ id: randomUUID(), taskId: task.id, kind: "resume", effectiveAt: "2026-09-13T00:00:00.000Z", taskVersion: 3, enabled: true, stopped: false });
    });
    const candidates = [...projectOccurrences({ task: projectionTask(task), segments: [segment], controls: [], dateFrom: "2026-09-12", dateTo: "2026-09-13", now: "2026-09-13T12:30:00.000Z" })];
    const expected = [];
    for (const candidate of candidates) expected.push(await overlayOccurrence(store, task, candidate));
    const control = vi.spyOn(store, "controlBefore");
    const actual = await overlayOccurrences(store, task, candidates);
    expect(actual).toEqual(expected);
    expect(actual.map(value => value !== null)).toEqual([true, false, false, true]);
    expect(control).toHaveBeenCalledTimes(3);
  });
  it("reuses materialized occurrence pages instead of projecting source segments again", async () => {
    const f = await fixture(); const created = await f.call("task.create", { draft: draft() });
    const payload = { taskId: created.task.id, dateFrom: "2026-09-12", dateTo: "2026-09-13", limit: 1 };
    const clock = { now: () => new Date("2026-09-11T10:30:00.000Z") };
    const initial = f.store(); const controls = vi.spyOn(initial, "controlBefore");
    const first = await new OccurrenceLists(initial, clock).execute("occurrence.list", payload);
    expect(controls).toHaveBeenCalledTimes(1);
    if (!isPersonalData("occurrence.list", first) || !first.nextCursor) throw new Error("Expected cursor");
    const store = f.store(); const segments = vi.spyOn(store, "segments");
    const states = vi.spyOn(store, "readOccurrenceStates");
    const occurrences = [...first.items]; let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = await new OccurrenceLists(store, clock).execute("occurrence.list", { ...payload, cursor });
      if (!isPersonalData("occurrence.list", page)) throw new Error("Invalid list");
      occurrences.push(...page.items); cursor = page.nextCursor;
    }
    expect(occurrences.map(o => `${o.localDate}/${o.slot}`)).toEqual(["2026-09-12/08:00", "2026-09-12/20:00", "2026-09-13/08:00", "2026-09-13/20:00"]);
    expect(segments).not.toHaveBeenCalled(); expect(states).not.toHaveBeenCalled();
    const replay = await new OccurrenceLists(f.store(), clock).execute("occurrence.list", { ...payload, cursor: first.nextCursor });
    if (!isPersonalData("occurrence.list", replay)) throw new Error("Invalid replay");
    expect(replay.items).toEqual([occurrences[1]]);
  });
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


describe("list performance continuation", () => {
  it("batches reminder receipts and preserves dismissal filtering and read state", async () => {
    const f = await fixture(); f.time("2026-09-12T00:00:00.000Z");
    const created = await f.call("task.create", { draft: { ...draft(), schedule: { kind: "daily", startDate: "2026-09-12", endDate: "2026-09-12", times: ["09:00", "10:00", "11:00", "12:00"] } } });
    f.time("2026-09-12T10:00:00.000Z");
    const initial = await f.call("reminder.list", {}); const first = initial.items[0], second = initial.items[1];
    if (!first || !second) throw new Error("Missing reminders");
    await f.call("reminder.dismiss", { occurrence: first.occurrence });
    await f.call("reminder.markRead", { occurrence: second.occurrence });
    const store = f.store(), reads = vi.spyOn(store, "readReminderReceipts");
    const result = await new OccurrenceLists(store, { now: () => new Date("2026-09-12T10:00:00.000Z") }).execute("reminder.list", {});
    if (!isPersonalData("reminder.list", result)) throw new Error("Invalid reminders");
    expect(reads).toHaveBeenCalledTimes(1); expect(reads.mock.calls[0]?.[0]).toHaveLength(4);
    expect(result.items).toHaveLength(3); expect(result.items[0]?.readAt).not.toBeNull();
    expect(result.items.every(item => item.occurrence.taskId === created.task.id)).toBe(true);
    expect((await f.call("reminder.list", { includeDismissed: true })).items).toHaveLength(4);
  });
  it("returns a compact task only when requested, retaining full details and unscheduled/recycle behavior", async () => {
    const f = await fixture();
    const created = await f.call("task.create", { draft: { ...draft(), note: "详细备注" } });
    const full = await f.call("task.list", {});
    const compact = await f.call("task.list", { view: "summary" });
    expect(full.items[0]?.task).toHaveProperty("note", "详细备注");
    expect(compact.items[0]?.task).not.toHaveProperty("note");
    expect(compact.items[0]?.task).not.toHaveProperty("participants");
    expect(compact.items[0]?.occurrence).toEqual(full.items[0]?.occurrence);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length);
    expect((await f.call("task.get", { id: created.task.id })).task.note).toBe("详细备注");
    await f.call("task.create", { draft: { ...draft(), schedule: { kind: "once", date: null, time: null } } });
    const unscheduled = await f.call("task.list", { unscheduled: true, view: "summary" });
    expect(unscheduled.items).toHaveLength(1); expect(unscheduled.items[0]?.task).not.toHaveProperty("myReminder");
    await f.call("task.delete", { id: created.task.id, expectedVersion: 1 });
    const recycle = await f.call("task.recycleList", { view: "summary" });
    expect(recycle.items[0]?.capabilities.canRestore).toBe(true);
    expect(recycle.items[0]).not.toHaveProperty("participants");
    expect((await f.call("task.recycleList", {})).items[0]).toHaveProperty("participants");
  });
  it("jumps a decades-long empty gap and still returns old closed-segment occurrences", async () => {
    const f = await fixture(); f.time("2001-01-01T10:00:00.000Z");
    const original: TaskDraft = { ...draft(), schedule: { kind: "daily", startDate: "2001-01-01", endDate: "2001-01-02", times: ["20:00"] } };
    const created = await f.call("task.create", { draft: original });
    f.time("2001-01-03T10:00:00.000Z");
    await f.call("task.update", { id: created.task.id, expectedVersion: 1, draft: { ...original, schedule: { kind: "daily", startDate: "2027-01-01", endDate: null, times: ["20:00"] } } });
    f.time("2026-09-15T10:00:00.000Z");
    const first = await f.call("task.list", { overdue: true });
    expect(first.items).toEqual([]); expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) throw new Error("Missing history cursor");
    const second = await f.call("task.list", { overdue: true, cursor: first.nextCursor });
    expect(second.items.map(item => item.occurrence.localDate)).toEqual(["2001-01-01", "2001-01-02"]);
    expect(second.complete).toBe(true);
    expect(await f.call("task.list", { overdue: true, cursor: first.nextCursor })).toEqual(second);
  });
  it("jumps directly to a backdated once without using its creation date as a lower bound", async () => {
    const f = await fixture();
    await f.call("task.create", { draft: { ...draft(), schedule: { kind: "once", date: "2000-01-01", time: "08:00" } } });
    const first = await f.call("reminder.list", {});
    if (!first.nextCursor) throw new Error("Missing history cursor");
    const second = await f.call("reminder.list", { cursor: first.nextCursor });
    expect(second.items.map(item => item.occurrence.localDate)).toEqual(["2000-01-01"]);
    expect(second.complete).toBe(true);
  });
});
