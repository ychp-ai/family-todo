import { describe, expect, it, vi } from "vitest";
import { isFullPersonalData as isPersonalData } from "./support/full-data";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { measureApi } from "../packages/infra-cloudbase/src/api-metrics";
import { listBatchFixture } from "./support/list-batch-fixture";

describe("bounded cross-task list physical operations", () => {
  for (const action of ["task.list", "reminder.list"] as const) it(`measures complete ${action} pagination excluding seed`, async () => {
    const f = await listBatchFixture();
    const logs: string[] = [], items: unknown[] = [], seenTaskIds: string[] = [];
    let cursor: string | undefined, complete = false, pages = 0, unusedPrefetchedTasks = 0;
    do {
      const payload = action === "task.list" ? { familyId: f.familyId, view: "summary" as const, dateFrom: "2026-09-16", dateTo: "2026-09-16", limit: 20, cursor } : { limit: 20, cursor };
      const requestId = f.generate(), store = f.store();
      const segmentReads = vi.spyOn(store, "readSegments"), controls = vi.spyOn(store, "controlBefore");
      const response = await measureApi({ apiVersion: 1, action, requestId, payload }, async () => ({ ok: true as const, requestId, data: await new OccurrenceLists(store, f.clock).execute(action, payload) }), log => logs.push(log), { detailedDatabase: true });
      const projectedTaskIds = new Set(controls.mock.calls.map(call => call[0]));
      unusedPrefetchedTasks += segmentReads.mock.calls.flatMap(call => call[0]).filter(pair => !projectedTaskIds.has(pair.taskId)).length;
      if (!response.ok || !isPersonalData(action, response.data)) throw new Error("Invalid page");
      if (action === "task.list" && isPersonalData("task.list", response.data)) seenTaskIds.push(...response.data.items.map(item => item.task.id));
      if (action === "reminder.list" && isPersonalData("reminder.list", response.data)) seenTaskIds.push(...response.data.items.map(item => item.occurrence.taskId));
      items.push(...response.data.items); complete = response.data.complete; cursor = response.data.nextCursor ?? undefined; pages++;
      expect(pages).toBeLessThan(20);
      if (complete) expect(response.data.summary).toEqual({ pending: 20, completed: 0, skipped: 0, denominator: 20 });
    } while (cursor);
    expect(complete).toBe(true); expect(items).toHaveLength(20); expect(seenTaskIds).toEqual(f.taskIds);
    const counters: Record<string, number> = {};
    const collections: Record<string, Record<string, number>> = {};
    for (const log of logs) {
      const metric = JSON.parse(log);
      for (const key of ["documentReads", "documentWrites", "queries", "returnedRows", "transactions"]) counters[key] = (counters[key] ?? 0) + metric[key];
      for (const [name, ops] of Object.entries(metric.databaseOperations)) for (const [op, count] of Object.entries(ops as Record<string, number>)) if (count) { const entry = collections[name] ??= {}; entry[op] = (entry[op] ?? 0) + count; }
    }
    expect(pages).toBe(action === "task.list" ? 1 : 2);
    expect(counters.documentWrites).toBe(action === "task.list" ? 0 : 1);
    expect(counters.documentReads).toBeLessThanOrEqual(action === "task.list" ? 13 : 23);
    expect(counters.queries).toBeLessThanOrEqual(action === "task.list" ? 46 : 83);
    expect(counters.transactions).toBe(action === "task.list" ? 3 : 4);
    expect(collections.occurrence_states?.query).toBeLessThanOrEqual(pages);
    expect(collections.historical_subject_access?.query).toBeLessThanOrEqual(action === "task.list" ? 1 : 3);
    expect(collections.schedule_segments?.documentRead ?? 0).toBe(0);
    expect(collections.reminder_preferences?.documentRead ?? 0).toBe(0);
    if (action === "reminder.list") {
      expect(collections.reminder_preferences?.query).toBeLessThanOrEqual(3);
      expect(collections.reminder_receipts?.query).toBeLessThanOrEqual(3);
    }
    expect(unusedPrefetchedTasks).toBeLessThanOrEqual(3);
    console.log(JSON.stringify({ action, pages, counters, collections, unusedPrefetchedTasks }));
  });
});
