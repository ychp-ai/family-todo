import { describe, expect, it, vi } from "vitest";
import { isFullPersonalData as isPersonalData } from "./support/full-data";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { ListReadBatch } from "../packages/application/src/list-read-batch";
import { listBatchFixture } from "./support/list-batch-fixture";

async function allTasks(f: Awaited<ReturnType<typeof listBatchFixture>>) {
  const tasks = await f.store().readTasks(f.taskIds);
  expect(tasks).toHaveLength(20); return tasks;
}

describe("request-local list batch behavior", () => {
  it("caches hits and misses for history, preferences, sparse states and receipts", async () => {
    const f = await listBatchFixture(), store = f.store(), tasks = await allTasks(f);
    const context = await store.context(f.familyId); if (!context) throw new Error("Missing family");
    const first = tasks[0]; if (!first) throw new Error("Missing task");
    for (const [key, row] of f.database.documents) if (key.startsWith("reminder_preferences/") && row.taskId === first.id) f.database.documents.delete(key);
    const prefs = vi.spyOn(store, "readPreferences"), history = vi.spyOn(store, "historicalSubjectPairs"), states = vi.spyOn(store, "readOccurrenceStates"), receipts = vi.spyOn(store, "readReminderReceipts"), segments = vi.spyOn(store, "readSegments");
    const reads = new ListReadBatch(store, f.user.id);
    for (let repeat = 0; repeat < 2; repeat++) {
      await reads.prepare(tasks, context, true, true);
      await reads.project(tasks, "2026-09-16", "2026-09-16", f.clock.now().toISOString(), true);
    }
    for (const spy of [prefs, history, states, receipts, segments]) expect(spy).toHaveBeenCalledTimes(1);
    expect(reads.preferences.get(first.id)).toBeNull(); expect(reads.history.get(first.id)).toEqual([]);
    expect([...reads.states.values()]).toEqual(Array(20).fill(null)); expect([...reads.receipts.values()]).toEqual(Array(20).fill(null));
    await expect(reads.prepare(tasks, null, true, true)).rejects.toThrow("scope");
  });
  it("does not expand state prefetch for a maximum date window on one task", async () => {
    const f = await listBatchFixture(), store = f.store(), tasks = await allTasks(f);
    const task = tasks[0]; if (!task?.recurrence) throw new Error("Missing recurrence");
    const segment = await store.readSegment(task.recurrence.currentSegmentId); if (!segment) throw new Error("Missing segment");
    await store.transaction(tx => tx.saveSegment({ ...segment, schedule: { kind: "daily", startDate: "2026-09-16", endDate: null, times: ["08:00", "20:00"] } }));
    const states = vi.spyOn(store, "readOccurrenceStates");
    await new ListReadBatch(store, f.user.id).project([task], "2026-09-16", "2026-10-16", f.clock.now().toISOString(), false);
    expect(states).not.toHaveBeenCalled();
  });
  it("keeps self-disabled and old-membership reminder preferences excluded", async () => {
    const f = await listBatchFixture(); const [first, second] = f.taskIds; if (!first || !second) throw new Error("Missing tasks");
    await f.store().transaction(async tx => {
      await tx.savePreference({ taskId: first, userId: f.user.id, membershipId: f.memberId, enabled: false, selfDisabled: true, version: 2 });
      await tx.savePreference({ taskId: second, userId: f.user.id, membershipId: f.generate(), enabled: true, selfDisabled: false, version: 2 });
    });
    const items: string[] = []; let cursor: string | undefined;
    do {
      const page = await new OccurrenceLists(f.store(), f.clock).execute("reminder.list", { limit: 20, cursor });
      if (!isPersonalData("reminder.list", page)) throw new Error("Invalid page");
      items.push(...page.items.map(item => item.occurrence.taskId)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(items).toEqual(f.taskIds.slice(2));
  });
  it("rejects a concurrent membership withdrawal at the final fence", async () => {
    const f = await listBatchFixture(), store = f.store();
    const original = store.readPreferences.bind(store);
    vi.spyOn(store, "readPreferences").mockImplementation(async (...args) => {
      const rows = await original(...args);
      await f.store().transaction(tx => tx.saveSlot({ familyId: f.familyId, userId: f.user.id, activeMembershipId: null }));
      return rows;
    });
    await expect(new OccurrenceLists(store, f.clock).execute("reminder.list", { limit: 20 })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
  it("rejects foreign segment ownership, preference keys, historical keys and duplicate rows", async () => {
    const f = await listBatchFixture(), store = f.store(), tasks = await allTasks(f);
    const task = tasks[0]; if (!task?.recurrence) throw new Error("Missing task");
    const segmentKey = `schedule_segments/${task.recurrence.currentSegmentId}`;
    const segment = f.database.documents.get(segmentKey); if (!segment) throw new Error("Missing segment");
    f.database.documents.set(segmentKey, { ...segment, taskId: f.generate() });
    await expect(store.readSegments([{ taskId: task.id, segmentId: task.recurrence.currentSegmentId }])).rejects.toThrow();
    const pref = [...f.database.documents.entries()].find(([key, row]) => key.startsWith("reminder_preferences/") && row.taskId === task.id); if (!pref) throw new Error("Missing preference");
    f.database.documents.set(pref[0], { ...pref[1], userId: f.generate() });
    await expect(store.readPreferences([task.id], f.user.id)).rejects.toThrow();
    await store.transaction(tx => tx.saveHistoricalSubjectAccess({ taskId: task.id, membershipId: f.memberId }));
    const history = [...f.database.documents.entries()].find(([key, row]) => key.startsWith("historical_subject_access/") && row.taskId === task.id); if (!history) throw new Error("Missing history");
    f.database.documents.set(history[0], { ...history[1], membershipId: f.generate() });
    await expect(store.historicalSubjectPairs([{ taskId: task.id, membershipId: f.memberId }])).rejects.toThrow();
    const original = f.database.collection.bind(f.database);
    vi.spyOn(f.database, "collection").mockImplementation(name => {
      const query = original(name);
      if (name === "tasks") vi.spyOn(query, "where").mockImplementation(() => {
        const result = original(name); vi.spyOn(result, "limit").mockReturnValue(result);
        const row = f.database.documents.get(`tasks/${task.id}`);
        vi.spyOn(result, "get").mockResolvedValue({ data: [row, row] }); return result;
      });
      return query;
    });
    await expect(store.readTasks(f.taskIds)).rejects.toThrow();
    await expect(store.readTasks(Array(21).fill(task.id))).rejects.toThrow();
    await expect(store.readPreferences(["invalid"], f.user.id)).rejects.toThrow();
  });
});
