import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isRecord } from "@family-todo/contracts";
import { countMetric, measureApi, observeDatabase } from "../packages/infra-cloudbase/src/api-metrics";
import type { PersonalDatabase } from "../packages/infra-cloudbase/src/personal-store";
import { budgetTransaction } from "../packages/infra-cloudbase/src/transaction-budget";
import { MemoryPersonalDatabase } from "./support/personal-database";

describe("API performance infrastructure", () => {
  it("forwards inclusion fields without counting them as physical operations", async () => {
    const memory = new MemoryPersonalDatabase();
    memory.documents.set("tasks/task", { _id: "task", title: "visible", note: "PRIVATE_VALUE" });
    const fields = { _id: true, title: true };
    const direct = await memory.collection("tasks").field(fields).where({ _id: "task" }).orderBy("_id", "asc").limit(20).get();
    expect(direct).toEqual({ data: [{ _id: "task", title: "visible" }] });
    const logs: string[] = [], requestId = randomUUID();
    await measureApi({ apiVersion: 1, action: "task.list", requestId, payload: {} }, async () => {
      const result = await observeDatabase(memory).collection("tasks").field(fields).where({ _id: "task" }).orderBy("_id", "asc").limit(20).get();
      expect(result).toEqual(direct);
      return { ok: true, requestId, data: {} };
    }, log => logs.push(log), { detailedDatabase: true });
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ queries: 1, documentReads: 0, documentWrites: 0, returnedRows: 1, databaseOperations: { tasks: { query: 1 } } });
  });
  it("keeps physical counters isolated across concurrent requests and excludes request data", async () => {
    const logs: string[] = [];
    const first = randomUUID(), second = randomUUID();
    await Promise.all([first, second].map((requestId, index) => measureApi({ apiVersion: 1, action: "task.get", requestId, payload: { sensitive: "PRIVATE_VALUE" } }, async () => {
      const db = observeDatabase(new MemoryPersonalDatabase());
      const collection = index === 0 ? "tasks" : "schedule_segments";
      for (let i = 0; i <= index; i++) await db.collection(collection).doc("PRIVATE_VALUE").get();
      await db.collection("tasks").where({ ownerUserId: "PRIVATE_VALUE" }).limit(1).get();
      await db.runTransaction(async tx => { await tx.collection("tasks").doc(requestId).set({ data: { sensitive: "PRIVATE_VALUE" } }); }, 0);
      countMetric("retries", index);
      return { ok: true, requestId, data: { value: "PRIVATE_VALUE" } };
    }, value => logs.push(value), { detailedDatabase: true })));
    const entries: unknown[] = logs.map(value => JSON.parse(value));
    expect(entries.find(v => isRecord(v) && v.requestId === first)).toMatchObject({ action: "task.get", documentReads: 1, documentWrites: 1, queries: 1, transactions: 1, retries: 0 });
    expect(entries.find(v => isRecord(v) && v.requestId === second)).toMatchObject({ documentReads: 2, documentWrites: 1, retries: 1 });
    expect(entries.find(v => isRecord(v) && v.requestId === first)).toMatchObject({ databaseOperations: { tasks: { documentRead: 1 }, schedule_segments: { documentRead: 0 } } });
    expect(entries.find(v => isRecord(v) && v.requestId === second)).toMatchObject({ databaseOperations: { tasks: { documentRead: 0 }, schedule_segments: { documentRead: 2 } } });
    expect(logs.join("")).not.toContain("PRIVATE_VALUE");
  });
  it("cannot change a committed response when logging fails", async () => {
    const response = { ok: true as const, requestId: randomUUID(), data: {} };
    expect(await measureApi({}, async () => response, () => { throw new Error("Logger unavailable"); })).toBe(response);
  });
  it("cannot change a committed response when response metrics cannot be serialized", async () => {
    const response = { ok: true as const, requestId: randomUUID(), data: { value: 1n } };
    const emit = vi.fn();
    expect(await measureApi({}, async () => response, emit)).toBe(response);
    expect(emit).not.toHaveBeenCalled();
  });
  it("keeps safe database operation categories disabled by default", async () => {
    const logs: string[] = [];
    const requestId = randomUUID();
    await measureApi({ apiVersion: 1, action: "task.get", requestId, payload: {} }, async () => {
      const db = observeDatabase(new MemoryPersonalDatabase());
      await db.collection("tasks").doc("task").get();
      return { ok: true, requestId, data: {} };
    }, value => logs.push(value));
    expect(JSON.parse(logs[0] ?? "{}")).not.toHaveProperty("databaseOperations");
  });
  it("aggregates detailed operations into fixed safe categories and reports cumulative database wait", async () => {
    const logs: string[] = [];
    const requestId = randomUUID();
    await measureApi({ apiVersion: 1, action: "task.get", requestId, payload: {} }, async () => {
      const db = observeDatabase(new MemoryPersonalDatabase());
      await Promise.all([
        db.collection("tasks").where({ privateField: "PRIVATE_VALUE" }).get(),
        db.collection("tenant_PRIVATE_VALUE").doc("PRIVATE_VALUE").get()
      ]);
      await db.collection("query_sessions").doc("session").set({ data: {} });
      return { ok: true, requestId, data: {} };
    }, value => logs.push(value), { detailedDatabase: true });
    const entry = JSON.parse(logs[0] ?? "{}");
    expect(entry).toMatchObject({ databaseOperations: { tasks: { query: 1 }, query_sessions: { documentWrite: 1 }, other: { documentRead: 1 } } });
    expect(entry.databaseWaitCumulativeMs).toBeTypeOf("number");
    expect(entry.serializationMs).toBeTypeOf("number");
    expect(logs[0]).not.toContain("PRIVATE_VALUE");
    expect(logs[0]).not.toContain("tenant_");
  });
  it("adds parallel database waits rather than reporting their wall clock duration", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const second = new Promise<void>(resolve => { releaseSecond = resolve; });
    const memory = new MemoryPersonalDatabase();
    const database: PersonalDatabase = {
      command: memory.command,
      collection: name => {
        const query = {
          field: (_fields: Record<string, boolean>) => query,
          where: (_filter: Record<string, unknown>) => query,
          orderBy: (_field: string, _direction: "asc" | "desc") => query,
          limit: (_count: number) => query,
          get: async () => ({ data: [] }),
          doc: (_id: string) => ({
            get: async () => { await (name === "tasks" ? first : second); return { data: null }; },
            set: async (_options: { data: Record<string, unknown> }) => undefined
          })
        };
        return query;
      },
      runTransaction: memory.runTransaction.bind(memory)
    };
    const times = [0, 10, 20, 60, 80, 90, 95, 100];
    const now = vi.spyOn(performance, "now").mockImplementation(() => times.shift() ?? 100);
    const logs: string[] = [];
    const requestId = randomUUID();
    try {
      const measured = measureApi({ apiVersion: 1, action: "task.get", requestId, payload: {} }, async () => {
        const db = observeDatabase(database);
        await Promise.all([db.collection("tasks").doc("first").get(), db.collection("schedule_segments").doc("second").get()]);
        return { ok: true, requestId, data: {} };
      }, value => logs.push(value), { detailedDatabase: true });
      await Promise.resolve();
      releaseFirst?.(); await Promise.resolve();
      releaseSecond?.();
      await measured;
    } finally { now.mockRestore(); }
    const entry = JSON.parse(logs[0] ?? "{}");
    expect(entry.databaseWaitCumulativeMs).toBe(110);
    expect(entry.durationMs).toBe(100);
  });
  it("caches transaction reads without sharing mutable values, including read after write", async () => {
    const get = vi.fn(async () => ({ data: { nested: { count: 1 } } }));
    const set = vi.fn(async () => undefined);
    const budget = vi.fn();
    const tx = budgetTransaction({ collection: () => ({ doc: () => ({ get, set }) }) }, budget);
    const doc = tx.collection("tasks").doc("task");
    const first: unknown = await doc.get();
    if (!isRecord(first) || !isRecord(first.data) || !isRecord(first.data.nested)) throw new Error("Invalid fixture");
    first.data.nested.count = 99;
    expect(await doc.get()).toEqual({ data: { nested: { count: 1 } } });
    await doc.set({ data: { nested: { count: 2 } } });
    expect(await doc.get()).toEqual({ data: { _id: "task", nested: { count: 2 } } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(budget).toHaveBeenCalled();
  });
});
