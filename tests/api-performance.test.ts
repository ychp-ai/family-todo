import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isRecord } from "@family-todo/contracts";
import { countMetric, measureApi, observeDatabase } from "../packages/infra-cloudbase/src/api-metrics";
import { budgetTransaction } from "../packages/infra-cloudbase/src/transaction-budget";
import { MemoryPersonalDatabase } from "./support/personal-database";

describe("API performance infrastructure", () => {
  it("keeps physical counters isolated across concurrent requests and excludes request data", async () => {
    const logs: string[] = [];
    const first = randomUUID(), second = randomUUID();
    await Promise.all([first, second].map((requestId, index) => measureApi({ apiVersion: 1, action: "task.get", requestId, payload: { sensitive: "PRIVATE_VALUE" } }, async () => {
      const db = observeDatabase(new MemoryPersonalDatabase());
      for (let i = 0; i <= index; i++) await db.collection("tasks").doc("PRIVATE_VALUE").get();
      await db.collection("tasks").where({ ownerUserId: "PRIVATE_VALUE" }).limit(1).get();
      await db.runTransaction(async tx => { await tx.collection("tasks").doc(requestId).set({ data: { sensitive: "PRIVATE_VALUE" } }); }, 0);
      countMetric("retries", index);
      return { ok: true, requestId, data: { value: "PRIVATE_VALUE" } };
    }, value => logs.push(value))));
    const entries: unknown[] = logs.map(value => JSON.parse(value));
    expect(entries.find(v => isRecord(v) && v.requestId === first)).toMatchObject({ action: "task.get", documentReads: 1, documentWrites: 1, queries: 1, transactions: 1, retries: 0 });
    expect(entries.find(v => isRecord(v) && v.requestId === second)).toMatchObject({ documentReads: 2, documentWrites: 1, retries: 1 });
    expect(logs.join("")).not.toContain("PRIVATE_VALUE");
  });
  it("cannot change a committed response when logging fails", async () => {
    const response = { ok: true as const, requestId: randomUUID(), data: {} };
    expect(await measureApi({}, async () => response, () => { throw new Error("Logger unavailable"); })).toBe(response);
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
