import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRecord, isPersonalData } from "@family-todo/contracts";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { measureApi } from "../packages/infra-cloudbase/src/api-metrics";
import { readCollaborativeTask } from "../packages/infra-cloudbase/src/family-codecs";
import type { TaskDraft } from "@family-todo/contracts";
import { CollaborativeTaskService } from "../packages/application/src/collaborative-tasks";
import { BatchViewers } from "../packages/application/src/batch-viewers";
import { CloudBasePersonalStore, taskFields } from "../packages/infra-cloudbase/src/personal-store";
import { listBatchFixture } from "./support/list-batch-fixture";

async function run(f: Awaited<ReturnType<typeof listBatchFixture>>, indexed: boolean, action: "task.list" | "reminder.list", extra: Record<string, unknown> = {}) {
  const items: unknown[] = [], logs: Record<string, unknown>[] = [];
  let cursor: string | undefined, pages = 0, complete = false, summary: unknown;
  f.database.queryRows = [];
  do {
    const payload = action === "task.list" ? { familyId: f.familyId, view: "summary", dateFrom: "2026-09-16", dateTo: "2026-09-16", limit: 20, ...extra, cursor } : { limit: 20, ...extra, cursor };
    const result = await measureApi({ apiVersion: 1, action, requestId: f.generate(), payload }, async () => ({ ok: true as const, requestId: f.generate(), data: await new OccurrenceLists(f.store(indexed), f.clock).execute(action, payload) }), line => logs.push(JSON.parse(line)), { detailedDatabase: true });
    if (!result.ok || !isPersonalData(action, result.data) || !('items' in result.data)) throw new Error("Invalid complete flow");
    items.push(...result.data.items); cursor = result.data.nextCursor ?? undefined; complete = result.data.complete; summary = result.data.summary; pages++;
    expect(pages).toBeLessThan(300);
  } while (cursor);
  expect(complete).toBe(true);
  const counters: Record<string, number> = {};
  for (const log of logs) for (const key of ["documentReads", "documentWrites", "queries", "returnedRows", "transactions"]) if (typeof log[key] === "number") counters[key] = (counters[key] ?? 0) + log[key];
  const taskRows = f.database.queryRows.filter(q => q.collection === "tasks");
  return { items, summary, complete, cost: { pages, ...counters, taskQueries: taskRows.length, taskRows: taskRows.reduce((total, q) => total + q.rows.length, 0) } };
}

async function single(f: Awaited<ReturnType<typeof listBatchFixture>>, date: string, personal = false) {
  const original = await f.store().readTask(f.taskIds[0] ?? ""); if (!original) throw new Error("fixture");
  const { recurrence: _recurrence, collaboration, ...fields } = original;
  const task = { ...fields, id: f.generate(), candidateKind: "single" as const, date, time: "08:00", segmentId: f.generate(), occurrenceId: f.generate(), ...(personal ? {} : { collaboration }) };
  await f.store().transaction(tx => tx.saveTask(task));
  return task;
}

function report(value: unknown) { console.log(JSON.stringify(value)); if (process.env.TASK_CANDIDATE_REPORT) appendFileSync(process.env.TASK_CANDIDATE_REPORT, JSON.stringify(value) + "\n"); }

describe("indexed task candidates", () => {
  for (const outside of [0, 50, 200, 1000]) it(`preserves complete outputs and costs with ${outside} date-outside singles`, async () => {
    const f = await listBatchFixture();
    await single(f, "2026-09-16");
    for (let index = 0; index < outside; index++) await single(f, "2027-09-16");
    const off = await run(f, false, "task.list"), on = await run(f, true, "task.list"), rollback = await run(f, false, "task.list");
    expect({ ...on, cost: undefined }).toEqual({ ...off, cost: undefined });
    expect(rollback).toEqual(off);
    expect(on.cost.taskRows).toBeLessThan(50);
    const stored = f.database.documents.get(`tasks/${f.taskIds[0]}`); if (!stored) throw new Error("storage");
    const { candidateSchema: _schema, candidateKind: _kind, scopeKey: _scope, candidateOrder: _order, ...oldShape } = stored;
    const singleStored = [...f.database.documents.values()].find(row => row.candidateKind === "single"); if (!singleStored) throw new Error("single");
    const { candidateSchema: _singleSchema, candidateKind: _singleKind, scopeKey: _singleScope, candidateOrder: _singleOrder, ...singleOld } = singleStored;
    const singleMetadataBytes = Buffer.byteLength(JSON.stringify(singleStored), "utf8") - Buffer.byteLength(JSON.stringify(singleOld), "utf8");
    const metadataBytes = Buffer.byteLength(JSON.stringify(stored), "utf8") - Buffer.byteLength(JSON.stringify(oldShape), "utf8");
    const ids = on.items.map(item => isRecord(item) && isRecord(item.occurrence) ? item.occurrence.id : null);
    report({ fixture: "date-outside-singles", outside, metadataBytes, singleMetadataBytes, complete: on.complete, orderedIds: ids, summary: on.summary, baseline: off.cost, on: on.cost, off: rollback.cost, completeOutput: on.items } );
  }, 30000);
  it("jumps to ancient personal and family singles despite a zero personal count", async () => {
    const f = await listBatchFixture();
    const personal = await single(f, "2001-01-01", true), family = await single(f, "2002-02-02");
    // Legacy rows are backfilled conservatively without adding recurrence or changing occurrence IDs.
    for (const task of [personal, family]) { const row = f.database.documents.get(`tasks/${task.id}`); if (row) { delete row.recurrence; } }
    for (const action of ["task.list", "reminder.list"] as const) {
      const extra = action === "task.list" ? { familyId: undefined, dateFrom: undefined, dateTo: undefined, overdue: true } : {};
      const off = await run(f, false, action, extra), on = await run(f, true, action, extra);
      expect(on).toEqual(off);
      expect(JSON.stringify(on.items)).toContain(personal.occurrenceId);
      if (action === "task.list") expect(JSON.stringify(on.items)).toContain(family.occurrenceId);
      report({ fixture: "ancient-hints", action, orderedItems: on.items, summary: on.summary, baseline: off.cost, on: on.cost });
    }
  });
  it("keeps public progress.get complete output and every database count unchanged when enabled", async () => {
    const f = await listBatchFixture();
    await single(f, "2026-09-16");
    for (let index = 0; index < 50; index++) await single(f, "2027-09-16");
    const progress = async (indexed: boolean) => {
      const pages: unknown[] = [], costs: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const payload = { familyId: f.familyId, date: "2026-09-16", cursor };
        const service = new CollaborativeTaskService(f.store(indexed), new CloudBasePersonalStore(f.database, f.identity, "test-family-cursor-and-encryption-secret"), f.clock, { generate: f.generate });
        const response = await measureApi({ apiVersion: 1, action: "progress.get", requestId: f.generate(), payload }, async () => ({ ok: true as const, requestId: f.generate(), data: await service.execute("progress.get", payload, f.generate()) }), line => {
          const metric = JSON.parse(line);
          costs.push(Object.fromEntries(["documentReads", "documentWrites", "queries", "returnedRows", "transactions", "retries", "databaseOperations"].map(key => [key, metric[key]])));
        }, { detailedDatabase: true });
        if (!response.ok || !isPersonalData("progress.get", response.data)) throw new Error("Invalid progress response");
        cursor = response.data.nextCursor ?? undefined;
        pages.push({ ...response.data, nextCursor: Boolean(cursor) });
        expect(pages.length).toBeLessThan(100);
        if (!cursor) expect(response.data.complete).toBe(true);
      } while (cursor);
      return { pages, costs };
    };
    const off = await progress(false), on = await progress(true);
    expect(on.pages.at(-1)).toEqual(off.pages.at(-1));
    expect(on).toEqual(off);
    report({ fixture: "public-progress-excluded", off, on });
  });
  it("keeps sticky history in full and projected reads and atomically changes migration scope", async () => {
    const f = await listBatchFixture();
    const task = await f.store().readTask(f.taskIds[0] ?? ""); if (!task?.recurrence) throw new Error("fixture");
    expect(task.candidateKind).toBe("history");
    task.recurrence.schedule = { kind: "once", date: "2027-01-01", time: "08:00" };
    await f.store().transaction(tx => tx.saveTask(task));
    expect((await f.store().readListTask(task.id))?.candidateKind).toBe("history");
    expect((await f.store().readTask(task.id))?.candidateKind).toBe("history");
    const legacy: Record<string, unknown> = { ...taskFields(task), id: task.id, familyId: task.collaboration?.familyId }; delete legacy.candidateKind; delete legacy.candidateSchema;
    expect(readCollaborativeTask(legacy).candidateKind).toBe("history");
    const personal = await single(f, "2026-09-16", true);
    expect(f.database.documents.get(`tasks/${personal.id}`)?.scopeKey).toBe(`p/${f.user.id}`);
    await f.store().transaction(async tx => { const scope = await tx.scope(f.user.id); await tx.saveScope({ ...scope, personalTaskCount: 1 }); await tx.saveTask({ ...personal, candidateKind: "history" }); });
    const promoted = await new BatchViewers(f.store(), f.clock, { generate: f.generate }).execute({ items: [{ taskId: personal.id, expectedVersion: personal.version, targetFamilyId: f.familyId, viewerMembershipIds: [] }] }, f.generate());
    expect(promoted.results[0]?.status).toBe("succeeded");
    expect(f.database.documents.get(`tasks/${personal.id}`)?.scopeKey).toBe(`f/${f.familyId}`);
    expect((await f.store().readListTask(personal.id))?.candidateKind).toBe("history");
    expect((await f.store().scanListTasks(f.user.id, null, { mode: "projection" }, f.clock.now().toISOString(), null, 20)).items.some(t => t.id === personal.id)).toBe(false);
  });
  it("preserves once→daily→once, paused/stopped histories, and old ordering keys", async () => {
    const f = await listBatchFixture();
    const service = () => new CollaborativeTaskService(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date("2026-09-15T00:00:00.000Z") }, { generate: f.generate });
    const draft: TaskDraft = { title: "未来转换", note: "", familyId: f.familyId, subject: { kind: "self" }, schedule: { kind: "once", date: "2026-09-16", time: "08:00" }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } };
    const created = await service().execute("task.create", { draft }, f.generate());
    if (!isPersonalData("task.create", created)) throw new Error("create");
    const id = created.task.id;
    expect((await f.store().readTask(id))?.candidateKind).toBe("single");
    await service().execute("task.update", { id, expectedVersion: 1, draft: { ...draft, schedule: { kind: "daily", startDate: "2026-09-16", endDate: null, times: ["08:00"] } } }, f.generate());
    expect((await f.store().readListTask(id))?.candidateKind).toBe("history");
    await service().execute("task.update", { id, expectedVersion: 2, draft }, f.generate());
    expect((await f.store().readTask(id))?.candidateKind).toBe("history");
    // Conservative branch includes paused/stopped history; projection controls retain the original semantics.
    const liveService = new CollaborativeTaskService(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-cursor-and-encryption-secret"), f.clock, { generate: f.generate });
    await liveService.execute("task.pause", { id: f.taskIds[0], expectedVersion: 1 }, f.generate());
    await liveService.execute("task.stop", { id: f.taskIds[1], expectedVersion: 1 }, f.generate());
    const off = await run(f, false, "task.list"), on = await run(f, true, "task.list");
    expect(on.items).toEqual(off.items); expect(on.summary).toEqual(off.summary);
    const task = await f.store().readTask(id); if (!task) throw new Error("task");
    const fields = taskFields({ ...task, date: null, time: null });
    expect(fields.scheduleOrder).toBe(`9999-12-31/99:99/${id}`);
    expect(fields.candidateOrder).toBe(`2026-09-16/08:00/${id}`);
    // Current-once exception must still return dates before creation for conservative history tasks.
    if (!task.recurrence) throw new Error("recurrence");
    task.recurrence.schedule = { kind: "once", date: "2003-03-03", time: "08:00" };
    const segment = await f.store().readSegment(task.recurrence.currentSegmentId); if (!segment) throw new Error("segment");
    await f.store().transaction(async tx => { await tx.saveSegment({ ...segment, schedule: task.recurrence?.schedule ?? segment.schedule }); await tx.saveTask(task); });
    const earlierOff = await run(f, false, "task.list", { dateFrom: "2003-03-03", dateTo: "2003-03-03" });
    const earlierOn = await run(f, true, "task.list", { dateFrom: "2003-03-03", dateTo: "2003-03-03" });
    expect(earlierOn.items).toEqual(earlierOff.items); expect(earlierOn.items).toHaveLength(1);
  });
  it("replays immutable indexed continuation cursors with the same ordered output", async () => {
    const f = await listBatchFixture();
    const payload = { familyId: f.familyId, view: "summary", dateFrom: "2026-09-16", dateTo: "2026-09-16", limit: 1 };
    const first = await new OccurrenceLists(f.store(true), f.clock).execute("task.list", payload);
    if (!isPersonalData("task.list", first) || !("nextCursor" in first) || !first.nextCursor) throw new Error("cursor");
    const results = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await new OccurrenceLists(f.store(true), f.clock).execute("task.list", { ...payload, cursor: first.nextCursor });
      if (!isPersonalData("task.list", result) || !("items" in result)) throw new Error("page");
      results.push({ items: result.items, complete: result.complete, summary: result.summary });
    }
    expect(results[0]).toEqual(results[1]);
  });
  it("expires cursors when switching algorithms and leaves management scans unchanged", async () => {
    const f = await listBatchFixture();
    const payload = { familyId: f.familyId, dateFrom: "2026-09-16", dateTo: "2026-09-16", limit: 1 };
    const first = await new OccurrenceLists(f.store(), f.clock).execute("task.list", payload);
    if (!isPersonalData("task.list", first) || !('nextCursor' in first) || !first.nextCursor) throw new Error("cursor");
    await expect(new OccurrenceLists(f.store(true), f.clock).execute("task.list", { ...payload, cursor: first.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    expect(await f.store(true).scanTasks(f.user.id, f.familyId, { mode: "tasks" }, f.clock.now().toISOString(), null, 20)).toEqual(await f.store(false).scanTasks(f.user.id, f.familyId, { mode: "tasks" }, f.clock.now().toISOString(), null, 20));
  });
});
