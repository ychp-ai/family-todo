import { describe, expect, it, vi } from "vitest";
import { isFullPersonalData } from "./support/full-data";
import { OccurrenceSorter } from "../packages/application/src/occurrence-sort";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { measureApi } from "../packages/infra-cloudbase/src/api-metrics";
import { listBatchFixture } from "./support/list-batch-fixture";

const curves = [
  { count: 50, endDate: "2026-09-20", times: ["08:00"] },
  { count: 200, endDate: "2026-10-05", times: ["08:00"] },
  { count: 1000, endDate: "2026-10-10", times: ["08:00", "10:00", "12:00", "14:00"] },
];
describe("complete sorted occurrence pagination cost", () => {
  for (const curve of curves) it(`measures ${curve.count} occurrences including preparation and cleanup liability`, async () => {
    const f = await listBatchFixture({ tasks: 10, ...curve });
    const logs: string[] = [], keys: string[] = [], ids: string[] = [];
    let cursor: string | undefined, pages = 0, emptyPages = 0;
    let phase = "scan";
    const sessionPhases: Record<string, number> = {};
    const advance = OccurrenceSorter.prototype.advance, output = OccurrenceSorter.prototype.page;
    const advanceSpy = vi.spyOn(OccurrenceSorter.prototype, "advance").mockImplementation(async function (this: OccurrenceSorter) { phase = "merge"; try { return await advance.call(this); } finally { phase = "scan"; } });
    const outputSpy = vi.spyOn(OccurrenceSorter.prototype, "page").mockImplementation(async function (this: OccurrenceSorter, limit) { phase = "output"; try { return await output.call(this, limit); } finally { phase = "scan"; } });
    do {
      const payload = { familyId: f.familyId, view: "summary" as const, dateFrom: "2026-09-16", dateTo: curve.endDate, limit: 20, cursor };
      const requestId = f.generate(), store = f.store();
      const read = store.readSession.bind(store), save = store.saveSession.bind(store);
      vi.spyOn(store, "readSession").mockImplementation(async token => { const value = await read(token); const key = `${phase}/read/${String(value?.kind)}`; sessionPhases[key] = (sessionPhases[key] ?? 0) + 1; return value; });
      vi.spyOn(store, "saveSession").mockImplementation(async value => { const key = `${phase}/write/${String(value.kind)}`; sessionPhases[key] = (sessionPhases[key] ?? 0) + 1; return save(value); });
      const response = await measureApi({ apiVersion: 1, action: "task.list", requestId, payload }, async () => ({ ok: true as const, requestId, data: await new OccurrenceLists(store, f.clock).execute("task.list", payload) }), log => logs.push(log), { detailedDatabase: true });
      if (!response.ok || !isFullPersonalData("task.list", response.data)) throw new Error("Invalid page");
      const page = response.data; pages++; if (!page.items.length) emptyPages++;
      for (const { occurrence: o } of page.items) { keys.push(`${o.localDate}/${o.time}/${o.taskId}/${o.id}`); ids.push(o.id); }
      cursor = page.nextCursor ?? undefined;
      expect(pages).toBeLessThan(300);
      if (!cursor) { expect(page.complete).toBe(true); expect(page.summary).toEqual({ completed: 0, pending: curve.count, skipped: 0, denominator: curve.count }); }
    } while (cursor);
    advanceSpy.mockRestore(); outputSpy.mockRestore();
    expect(keys).toHaveLength(curve.count); expect(new Set(ids).size).toBe(curve.count); expect(keys).toEqual([...keys].sort());
    const expected: string[] = [];
    for (let day = new Date("2026-09-16"); day.toISOString().slice(0, 10) <= curve.endDate; day.setUTCDate(day.getUTCDate() + 1)) for (const time of curve.times) for (const taskId of f.taskIds) expected.push(`${day.toISOString().slice(0, 10)}/${time}/${taskId}`);
    expect(keys.map(key => key.slice(0, key.lastIndexOf("/")))).toEqual(expected.sort());
    const counters: Record<string, number> = {}, sessions: Record<string, number> = {};
    for (const log of logs) {
      const metric = JSON.parse(log);
      for (const key of ["documentReads", "documentWrites", "queries", "returnedRows", "transactions"]) counters[key] = (counters[key] ?? 0) + metric[key];
      for (const [op, count] of Object.entries(metric.databaseOperations.query_sessions ?? {})) sessions[op] = (sessions[op] ?? 0) + Number(count);
    }
    const cleanupDeletes = sessions.documentWrite ?? 0;
    const totalCallsIncludingDeletes = (counters.documentReads ?? 0) + (counters.documentWrites ?? 0) + (counters.queries ?? 0) + cleanupDeletes;
    // F1 has 100-row pages; with only this flow's expired rows this adds floor(W/100)+1 queries.
    const isolatedCleanupScanQueries = Math.floor(cleanupDeletes / 100) + 1;
    const baseline = { 50: 157, 200: 546, 1000: 4338 }[curve.count];
    expect(totalCallsIncludingDeletes).toBeLessThanOrEqual((baseline ?? 0) * 0.75);
    expect(sessions.documentRead).toBeLessThanOrEqual(curve.count === 1000 ? 210 : curve.count === 200 ? 35 : 4);
    expect(cleanupDeletes).toBeLessThanOrEqual(curve.count === 1000 ? 170 : curve.count === 200 ? 25 : 3);
    console.log(JSON.stringify({ count: curve.count, pages, emptyPages, counters, sessions, cleanupDeletes, totalCallsIncludingDeletes, isolatedCleanupScanQueries, isolatedTotal: totalCallsIncludingDeletes + isolatedCleanupScanQueries, sessionPhases }));
  }, 30000); // Whole 1000-result baseline spans 164 independent requests, not one 8-second invocation.
});

describe("sorted cursor fences and request budgets", () => {
  it("replays scan, merge and output cursors; resumes deadlines and rejects withdrawal, legacy, mismatch and expiry", async () => {
    const title = '中文"\\'.repeat(20);
    const f = await listBatchFixture({ tasks: 10, endDate: "2026-10-10", times: ["08:00", "10:00", "12:00", "14:00"], title });
    const payload = { familyId: f.familyId, view: "summary" as const, dateFrom: "2026-09-16", dateTo: "2026-10-10", limit: 20 };
    const execute = async (cursor?: string, store = f.store()) => {
      const result = await new OccurrenceLists(store, f.clock).execute("task.list", { ...payload, cursor });
      if (!isFullPersonalData("task.list", result)) throw new Error("Invalid full page"); return result;
    };
    const tested = new Set<string>(); let cursor: string | undefined, pages = 0, outputCursor: string | undefined;
    do {
      if (cursor) {
        const saved = await f.store().readSession(cursor);
        const stage = saved && typeof saved.sort === "object" && saved.sort !== null && "stage" in saved.sort ? String(saved.sort.stage) : "unknown";
        if (!tested.has(stage)) {
          tested.add(stage);
          const first = await execute(cursor), replay = await execute(cursor);
          expect({ ...replay, nextCursor: null }).toEqual({ ...first, nextCursor: null });
          expect(await f.store().readSession(cursor)).toEqual(saved);
          const slow = f.store(); let remaining = 8000;
          vi.spyOn(slow, "remainingBudgetMs").mockImplementation(() => remaining);
          if (stage === "output") {
            outputCursor = cursor;
            const hydrate = slow.readListTasks.bind(slow);
            vi.spyOn(slow, "readListTasks").mockImplementation(async ids => { const tasks = await hydrate(ids); remaining = 3500; return tasks; });
          } else remaining = 3500;
          const interrupted = await execute(cursor, slow);
          expect(interrupted.items).toEqual([]); expect(interrupted.complete).toBe(false); expect(interrupted.nextCursor).not.toBeNull();
          const resumed = await execute(interrupted.nextCursor ?? undefined);
          expect({ ...resumed, nextCursor: null }).toEqual({ ...first, nextCursor: null });
        }
      }
      const page = await execute(cursor); for (const item of page.items) expect(item.task.title).toBe(title);
      if (page.complete && cursor) { const replay = await execute(cursor); expect(replay).toEqual(page); }
      cursor = page.nextCursor ?? undefined; expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect([...tested].sort()).toEqual(["merge", "output", "scan"]);
    if (!outputCursor) throw new Error("Missing output cursor");
    const output = await f.store().readSession(outputCursor); if (!output) throw new Error("Missing checkpoint");
    for (const patch of [{ kind: "occurrence-list-v1" }, { actorId: f.generate() }, { fingerprint: "different" }, { expiresAt: "2026-09-16T11:59:59.000Z" }]) {
      const invalid = await f.store().saveSession({ ...output, ...patch });
      await expect(execute(invalid)).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    }
    // Withdrawal after immutable candidates were read must still fail the final transaction fence.
    const revoked = f.store(), hydrate = revoked.readListTasks.bind(revoked);
    vi.spyOn(revoked, "readListTasks").mockImplementation(async ids => {
      const tasks = await hydrate(ids);
      await f.store().transaction(async tx => { await tx.saveSlot({ familyId: f.familyId, userId: f.user.id, activeMembershipId: null }); });
      return tasks;
    });
    await expect(execute(outputCursor, revoked)).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    const sessions = [...f.database.documents.entries()].filter(([key]) => key.startsWith("query_sessions/"));
    for (const [, session] of sessions) {
      expect(Buffer.byteLength(JSON.stringify(session))).toBeLessThan(128 * 1024);
      if (session.kind === "occurrence-list-v2") expect(Buffer.byteLength(JSON.stringify(session))).toBeLessThan(96 * 1024);
      // Titles are hydrated at output and do not inflate sorting buffers.
      expect(JSON.stringify(session)).not.toContain(title);
    }
  }, 30000);
  it("keeps a complete single-page result in memory without writing runs or a checkpoint", async () => {
    const f = await listBatchFixture({ tasks: 10, endDate: "2026-09-20" });
    let cursor: string | undefined, saved = 0;
    do {
      const store = f.store(); const writes = vi.spyOn(store, "saveSession");
      const page = await new OccurrenceLists(store, f.clock).execute("task.list", { familyId: f.familyId, dateFrom: "2026-09-16", dateTo: "2026-09-20", view: "summary", limit: 50, cursor });
      if (!isFullPersonalData("task.list", page)) throw new Error("Invalid page");
      for (const [value] of writes.mock.calls) expect(value.kind).toBe("occurrence-list-v2");
      saved += writes.mock.calls.length;
      if (page.complete) { expect(page.items).toHaveLength(50); expect(writes).not.toHaveBeenCalled(); }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(saved).toBe(1); // One interrupted source scan checkpoint, no materialized runs.
  });
});
