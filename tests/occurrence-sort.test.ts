import { describe, expect, it } from "vitest";
import type { OccurrenceDTO } from "@family-todo/contracts";
import { OccurrenceSorter, emptyOccurrenceSort, readOccurrenceSort, sessionBytes } from "../packages/application/src/occurrence-sort";
import type { OccurrenceHead, OccurrenceSort } from "../packages/application/src/occurrence-sort";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fence = { actorId: uuid(1), fingerprint: "sort-test", asOf: "2026-09-16T00:00:00.000Z", expiresAt: "2026-09-16T00:15:00.000Z" };
function head(n: number, suffix = ""): OccurrenceHead {
  const occurrence: OccurrenceDTO = { id: uuid(n + 10), taskId: uuid(2), segmentId: uuid(3), localDate: "2026-09-16", slot: "08:00", time: "08:00", subject: { kind: "user", userId: uuid(1) }, subjectName: "家人", version: 0, scheduledAt: "2026-09-16T00:00:00.000Z", status: "pending", actualCompletedAt: null, recordedAt: null, operatorName: null, canRecord: true };
  return { order: String(n).padStart(6, "0") + suffix, occurrence };
}
function memory() {
  let sequence = 0, allowance = Infinity, failWrite = false;
  const rows = new Map<string, Record<string, unknown>>();
  const store = {
    remainingBudgetMs: () => allowance > 0 ? 8000 : 3500,
    async saveSession(value: Record<string, unknown>) {
      allowance--; if (failWrite) { failWrite = false; throw new Error("injected failed write"); }
      expect(sessionBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
      expect(sessionBytes(value)).toBeLessThan(128 * 1024); expect(value.expiresAt).toBe(fence.expiresAt);
      const key = `block-${sequence++}`; rows.set(key, structuredClone(value)); return key;
    },
    async readSession(key: string) { allowance--; return structuredClone(rows.get(key) ?? null); },
  };
  return { store, rows, budget: (value: number) => { allowance = value; }, fail: () => { failWrite = true; } };
}
function checkpoint(s: OccurrenceSort) {
  expect(sessionBytes(s)).toBeLessThan(96 * 1024);
  return readOccurrenceSort(JSON.parse(JSON.stringify(s)));
}
function productionState(sort: OccurrenceSort) {
  return { ...fence, sort, nextInvalidationAt: "2026-09-17T00:00:00.000Z", revision: 1,
    scopes: [{ familyId: uuid(4), version: 1, failed: false }], from: "2026-09-16", to: "2026-09-16", oldest: "2000-01-01", olderHint: null, afterOrder: null,
    top: [], scan: { taskIds: [uuid(2)], segmentIds: [uuid(3)], scope: 0, taskAfter: null, taskId: uuid(2), tasksDone: false, segmentAfter: null, segmentId: uuid(3), segmentsDone: false, slot: 0 },
    summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } };
}
function expectOnlySortFields(rows: Map<string, Record<string, unknown>>) {
  for (const row of rows.values()) {
    expect(["occurrence-sorted-block", "occurrence-sort-manifest"]).toContain(row.kind);
    expect(Object.keys(row).sort()).toEqual(["actorId", "fingerprint", "asOf", "expiresAt", "kind", "next", row.kind === "occurrence-sorted-block" ? "heads" : "runs"].sort());
  }
}
async function finish(m: ReturnType<typeof memory>, s: OccurrenceSort, fenceFor: (state: OccurrenceSort) => typeof fence = () => fence) {
  let state = s, turns = 0;
  while (state.stage === "merge") {
    m.budget(12); await new OccurrenceSorter(m.store, fenceFor(state), state).advance(); state = checkpoint(state);
    expect(++turns).toBeLessThan(500);
  }
  const result: OccurrenceHead[] = [];
  while (state.final?.block) {
    m.budget(Infinity); const sorter = new OccurrenceSorter(m.store, fenceFor(state), state), page = await sorter.page(20);
    result.push(...page.heads); sorter.consume(page.positions.at(-1)); state = checkpoint(state);
  }
  return result;
}
describe("bounded immutable merge mechanics", () => {
  it("serializes only defined block and manifest fields when passed the full mutable list state", async () => {
    const m = memory(), s = emptyOccurrenceSort(), sorter = new OccurrenceSorter(m.store, productionState(s), s);
    const expected = Array.from({ length: 801 }, (_, n) => head(n));
    for (const h of expected) await sorter.add(h);
    await sorter.finishScan();
    expect([...m.rows.values()].some(row => row.kind === "occurrence-sort-manifest")).toBe(true);
    expectOnlySortFields(m.rows);
    expect(await finish(m, checkpoint(s), productionState)).toEqual(expected);
    expectOnlySortFields(m.rows);
  });
  it("keeps near-64 KiB heads below the wire limit through full-state scan and merge wiring", async () => {
    const m = memory(), s = emptyOccurrenceSort(), sorter = new OccurrenceSorter(m.store, productionState(s), s);
    const suffix = ('中文😀"\\\n').repeat(4000);
    const padding = "x".repeat(64 * 1024 - sessionBytes([head(0, suffix)]));
    const expected = Array.from({ length: 17 }, (_, n) => head(n, suffix + padding));
    expect(Buffer.byteLength(JSON.stringify([expected[0]]))).toBe(64 * 1024);
    for (const h of expected) await sorter.add(h);
    await sorter.finishScan();
    expect(await finish(m, checkpoint(s), productionState)).toEqual(expected);
    expectOnlySortFields(m.rows);
    const blocks = [...m.rows.values()].filter(row => row.kind === "occurrence-sorted-block");
    const manifests = [...m.rows.values()].filter(row => row.kind === "occurrence-sort-manifest");
    expect(manifests.length).toBeGreaterThan(0);
    for (const row of blocks) expect(sessionBytes(row.heads)).toBe(64 * 1024);
    const maxBlockBytes = Math.max(...blocks.map(sessionBytes)), maxManifestBytes = Math.max(...manifests.map(sessionBytes));
    expect(maxBlockBytes).toBeLessThan(65 * 1024);
    expect(maxManifestBytes).toBeLessThan(1024);
    // The CloudBase adapter adds these two fields after checking the session payload.
    const maxStoredRowBytes = Math.max(...[...m.rows.values()].map(row => Buffer.byteLength(JSON.stringify({ ...row, schemaVersion: 2, purpose: "family" }))));
    expect(maxStoredRowBytes).toBeLessThan(128 * 1024);
    console.info("sort full-state wire bytes", { headArrayBytes: 64 * 1024, maxBlockBytes, maxManifestBytes, maxStoredRowBytes });
  });
  for (const count of [51, 200, 251, 901, 1000]) it(`sorts ${count} with four positions, chunked descriptors and interrupted merge passes`, async () => {
    const m = memory(), s = emptyOccurrenceSort(), sorter = new OccurrenceSorter(m.store, fence, s);
    const expected = Array.from({ length: count }, (_, n) => head(n));
    for (const h of [...expected].reverse()) await sorter.add(h);
    expect(await sorter.finishScan()).toBeNull();
    const original = structuredClone([...m.rows]);
    expect(await finish(m, checkpoint(s))).toEqual(expected);
    for (const [key, value] of original) expect(m.rows.get(key)).toEqual(value);
    if (count > 800) expect([...m.rows.values()].some(row => row.kind === "occurrence-sort-manifest")).toBe(true);
  });
  it("replays an interrupted merge without changing published blocks and retries a failed write", async () => {
    const m = memory(), s = emptyOccurrenceSort(), sorter = new OccurrenceSorter(m.store, fence, s);
    for (let n = 0; n < 401; n++) await sorter.add(head(n));
    await sorter.finishScan(); m.budget(8); await sorter.advance();
    const input = checkpoint(s), savedRows = structuredClone([...m.rows]);
    m.budget(Infinity); m.fail();
    await expect(new OccurrenceSorter(m.store, fence, checkpoint(input)).advance()).rejects.toThrow("injected failed write");
    const a = await finish(m, checkpoint(input)); const b = await finish(m, checkpoint(input)); expect(a).toEqual(b); expect(a).toHaveLength(401);
    for (const [key, value] of savedRows) expect(m.rows.get(key)).toEqual(value);
    for (const row of m.rows.values()) expect(row.expiresAt).toBe(fence.expiresAt);
  });
  it("counts Chinese, supplementary Unicode, and JSON escape bytes before spilling blocks", async () => {
    const m = memory(), s = emptyOccurrenceSort(), sorter = new OccurrenceSorter(m.store, fence, s);
    const suffix = ('中文😀"\\\n').repeat(1400), expected = Array.from({ length: 19 }, (_, n) => head(n, suffix));
    expect(sessionBytes(suffix)).toBe(Buffer.byteLength(JSON.stringify(suffix)));
    for (const h of [...expected].reverse()) { await sorter.add(h); checkpoint(s); }
    await sorter.finishScan(); expect(s.count).toBeGreaterThan(1);
    expect(await finish(m, checkpoint(s))).toEqual(expected);
    for (const row of m.rows.values()) if (row.heads) expect(sessionBytes(row.heads)).toBeLessThanOrEqual(64 * 1024);
  });
  it("advances output only for rendered entries across a block boundary", async () => {
    const m = memory(), s = emptyOccurrenceSort(), sorter = new OccurrenceSorter(m.store, fence, s);
    for (let n = 0; n < 101; n++) await sorter.add(head(n));
    await sorter.finishScan(); while (s.stage === "merge") { m.budget(Infinity); await new OccurrenceSorter(m.store, fence, s).advance(); }
    const input = checkpoint(s); m.budget(0);
    expect((await new OccurrenceSorter(m.store, fence, s).page(20)).heads).toEqual([]); expect(s).toEqual(input);
    m.budget(Infinity); const first = await sorter.page(20); sorter.consume(first.positions[6]);
    const rest = await finish(m, checkpoint(s)); expect(rest).toEqual(Array.from({ length: 94 }, (_, n) => head(n + 7)));
  });
});
