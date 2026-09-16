import { describe, expect, it, vi } from "vitest";
import { isFullPersonalData as isPersonalData } from "./support/full-data";
import { isRecord, isTaskDTO } from "@family-todo/contracts";
import { OccurrenceLists } from "../packages/application/src/occurrence-lists";
import { measureApi } from "../packages/infra-cloudbase/src/api-metrics";
import { readCollaborativeTask, readTaskListSource } from "../packages/infra-cloudbase/src/family-codecs";
import { personalTaskSummary, taskDTO } from "../packages/application/src/personal";
import { summarizeTask } from "../packages/application/src/task-context";
import { listBatchFixture } from "./support/list-batch-fixture";

function validPage(progress: boolean, value: unknown): value is { items: unknown[]; nextCursor: string | null; complete: boolean; asOf: string } {
  if (!isRecord(value)) return false;
  const { failed, ...base } = value;
  return progress ? typeof failed === "boolean" && isPersonalData("occurrence.list", base) : isPersonalData("task.list", value);
}

async function fixture(tasks = 20) {
  const f = await listBatchFixture({ tasks });
  for (const [key, row] of f.database.documents) if (key.startsWith("tasks/")) row.note = "备注".repeat(500);
  f.database.queryRows = [];
  return f;
}

describe("validated database task list sources", () => {
  it("projects scans, exact ID batches and single reads while full entities still require note", async () => {
    const f = await fixture(), store = f.store(), id = f.taskIds[0];
    if (!id) throw new Error("Missing fixture task");
    const full = await store.readTask(id);
    const source = await store.readListTask(id);
    expect(source).toEqual(full && (({ note, ...rest }) => rest)(full));
    expect(source).not.toHaveProperty("note");
    const row = f.database.queryRows.at(-1)?.rows[0];
    expect(row).not.toHaveProperty("note");
    expect(readTaskListSource({ ...row, id })).toEqual(source);
    expect(() => readCollaborativeTask({ ...row, id })).toThrow();
    expect(() => readTaskListSource({ ...row, id: "bad" })).toThrow();
    expect(() => readTaskListSource({ ...row, id: undefined })).toThrow();
    for (const mutation of [
      { schemaVersion: 2 }, { version: undefined }, { createdAt: undefined },
      { date: null, time: "08:00" }, { date: "2026-02-30" }, { recurrence: {} }, { familyId: f.generate() }
    ]) {
      const original = f.database.documents.get(`tasks/${id}`);
      if (!original) throw new Error("Missing row");
      f.database.documents.set(`tasks/${id}`, { ...original, ...mutation });
      await expect(store.readListTasks([id])).rejects.toThrow();
      f.database.documents.set(`tasks/${id}`, original);
    }
    const page = await store.scanListTasks(f.user.id, f.familyId, { mode: "projection" }, f.clock.now().toISOString(), null, 3);
    const next = await store.scanListTasks(f.user.id, f.familyId, { mode: "projection" }, f.clock.now().toISOString(), page.after, 3);
    expect(page.items.map(task => task.id)).toEqual(f.taskIds.slice(0, 3));
    expect(next.items.map(task => task.id)).toEqual(f.taskIds.slice(3, 6));
    expect(f.database.queryRows.filter(query => query.collection === "tasks").every(query => query.rows.every(row => !("note" in row)))).toBe(true);
  });

  for (const limit of [3, 20]) for (const projectionOnly of [false, true]) it(`preserves ${projectionOnly ? "progress resume" : "summary run replay"} limit ${limit} output and operation counts with less row bytes`, async () => {
    async function run(project: boolean) {
      const f = await fixture(!projectionOnly && limit === 3 ? 60 : 20), pages: unknown[] = [], logs: string[] = [];
      let cursor: string | undefined;
      let resumed = 0, runs = 0;
      do {
        const store = f.store();
        if (!project) {
          store.readListTask = store.readTask.bind(store);
          store.readListTasks = store.readTasks.bind(store);
          store.scanListTasks = store.scanTasks.bind(store);
        }
        const batches = vi.spyOn(store, "readListTasks");
        const sessions = vi.spyOn(store, "readSession");
        const payload = { familyId: f.familyId, view: "summary" as const, dateFrom: "2026-09-16", dateTo: "2026-09-16", limit, cursor };
        const requestId = f.generate();
        const response = await measureApi({ apiVersion: 1, action: "task.list", requestId, payload }, async () => ({ ok: true as const, requestId, data: await new OccurrenceLists(store, f.clock).execute("task.list", payload, undefined, projectionOnly) }), log => logs.push(log));
        if (!response.ok || !validPage(projectionOnly, response.data)) throw new Error("Invalid result");
        const { nextCursor, ...page } = response.data;
        pages.push(page); cursor = nextCursor ?? undefined;
        if (pages.length > 1) resumed += batches.mock.calls.length;
        for (const result of sessions.mock.results) if ((await result.value)?.kind === "occurrence-sorted-block") runs++;
        expect(pages.length).toBeLessThan(30);
      } while (cursor);
      const taskRows = f.database.queryRows.filter(query => query.collection === "tasks");
      expect(taskRows.every(query => query.rows.every(row => ("note" in row) !== project))).toBe(true);
      const bytes = taskRows.reduce((total, query) => total + Buffer.byteLength(JSON.stringify(query.rows)), 0);
      const counters = logs.map(log => JSON.parse(log)).reduce((total, log) => ({ reads: total.reads + log.documentReads, queries: total.queries + log.queries, writes: total.writes + log.documentWrites, transactions: total.transactions + log.transactions }), { reads: 0, queries: 0, writes: 0, transactions: 0 });
      return { pages, bytes, counters, resumed, runs, outputBytes: Buffer.byteLength(JSON.stringify(pages)) };
    }
    const before = await run(false), after = await run(true);
    expect(after.pages).toEqual(before.pages);
    expect(after.counters).toEqual(before.counters);
    expect(after.bytes).toBeLessThan(before.bytes * 0.5);
    if (limit === 3) {
      expect(after.resumed).toBeGreaterThan(0);
      if (!projectionOnly) expect(after.runs).toBeGreaterThan(0);
    }
    console.log(JSON.stringify({ path: projectionOnly ? "progress" : "summary", limit, pages: after.pages.length, beforeBytes: before.bytes, afterBytes: after.bytes, outputBytes: after.outputBytes, counters: after.counters, resumed: after.resumed, runs: after.runs }));
  });

  it("retains full DTO notes and legacy personal completed/skipped summaries", async () => {
    const f = await fixture(), id = f.taskIds[0];
    if (!id) throw new Error("Missing task");
    const full = await new OccurrenceLists(f.store(), f.clock).execute("task.list", { familyId: f.familyId, dateFrom: "2026-09-16", dateTo: "2026-09-16", limit: 20 });
    if (!isPersonalData("task.list", full)) throw new Error("Invalid full list");
    const summary = await new OccurrenceLists(f.store(), f.clock).execute("task.list", { familyId: f.familyId, view: "summary", dateFrom: "2026-09-16", dateTo: "2026-09-16", limit: 20 });
    if (!isPersonalData("task.list", summary)) throw new Error("Invalid summary list");
    expect(summary.items.map(item => item.task)).toEqual(full.items.map(item => {
      if (!isTaskDTO(item.task)) throw new Error("Missing full task");
      const { note, participants, myReminder, createdAt, updatedAt, ...source } = item.task;
      return source;
    }));
    expect(full.items[0]?.task).toHaveProperty("note", "备注".repeat(500));
    for (const status of ["completed", "skipped"] as const) {
      const original = f.database.documents.get(`tasks/${id}`);
      if (!original) throw new Error("Missing row");
      const { collaboration, familyId, recurrence, ...legacy } = original;
      const row = { ...legacy, date: "2026-09-16", time: "08:00", status };
      f.database.documents.set(`tasks/${id}`, row);
      const personal = readCollaborativeTask({ ...row, id });
      expect(personalTaskSummary(personal)).toEqual(summarizeTask(taskDTO(personal)));
      for (const progress of [false, true]) {
        const result = await new OccurrenceLists(f.store(), f.clock).execute("task.list", { familyId: null, view: "summary", dateFrom: "2026-09-16", dateTo: "2026-09-16" }, undefined, progress);
        if (!validPage(progress, result)) throw new Error("Invalid legacy result");
        expect(result.items).toHaveLength(1);
        expect(JSON.stringify(result.items)).toContain(`"status":"${status}"`);
      }
    }
  });
});
