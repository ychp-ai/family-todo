import { integer, isOccurrenceDTO, isRecord } from "@family-todo/contracts";
import type { OccurrenceDTO } from "@family-todo/contracts";
import type { FamilyStore } from "@family-todo/ports";
import { ApplicationError } from "./errors";

export type OccurrenceHead = { order: string; occurrence: OccurrenceDTO };
type Position = { block: string | null; offset: number };
type Merge = { input: string | null; pending: string[]; sources: Position[]; output: string | null; buffer: OccurrenceHead[]; manifest: string | null; descriptors: string[]; count: number };
export type OccurrenceSort = { stage: "scan" | "merge" | "output"; buffer: OccurrenceHead[]; manifest: string | null; descriptors: string[]; count: number; direction: 1 | -1; merge: Merge | null; final: Position | null };
type Fence = { actorId: string; fingerprint: string; asOf: string; expiresAt: string };
const blockBytes = 64 * 1024, descriptorLimit = 16;
export function sessionBytes(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) { const code = character.codePointAt(0) ?? 0; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return bytes;
}
function expired(): never { throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。"); }
function token(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function descriptors(v: unknown): v is string[] { return Array.isArray(v) && v.length <= descriptorLimit && v.every(x => typeof x === "string"); }
function position(v: unknown): v is Position { return isRecord(v) && token(v.block) && integer(v.offset) && v.offset <= 50; }
function heads(v: unknown): v is OccurrenceHead[] { return Array.isArray(v) && v.length <= 50 && v.every(h => isRecord(h) && typeof h.order === "string" && isOccurrenceDTO(h.occurrence)) && sessionBytes(v) <= blockBytes; }
export function emptyOccurrenceSort(): OccurrenceSort { return { stage: "scan", buffer: [], manifest: null, descriptors: [], count: 0, direction: -1, merge: null, final: null }; }
export function readOccurrenceSort(v: unknown): OccurrenceSort {
  if (!isRecord(v) || !["scan", "merge", "output"].includes(String(v.stage)) || !heads(v.buffer) || !token(v.manifest) || !descriptors(v.descriptors) || !integer(v.count) || (v.direction !== 1 && v.direction !== -1) || !(v.final === null || position(v.final))) expired();
  const m = v.merge;
  if (m !== null && (!isRecord(m) || !token(m.input) || !descriptors(m.pending) || !Array.isArray(m.sources) || m.sources.length > 4 || !m.sources.every(position) || !token(m.output) || !heads(m.buffer) || !token(m.manifest) || !descriptors(m.descriptors) || !integer(m.count))) expired();
  // Fields have all been validated above, including nested buffers and positions.
  return v as OccurrenceSort;
}
/** Immutable external merge. A pass reads runs in one direction and prepends
 * reversed output blocks, producing runs in the opposite direction. No next
 * pointer is patched, so retries can only leave expiring, unreferenced blocks.
 * A one-run descending result receives a final reversal pass. */
export class OccurrenceSorter {
  private readonly blocks = new Map<string, { heads: OccurrenceHead[]; next: string | null }>();
  private operations = 0;
  public constructor(private readonly store: Pick<FamilyStore, "saveSession" | "readSession" | "remainingBudgetMs">, private readonly fence: Fence, public readonly state: OccurrenceSort) {}
  private available() { return this.operations < 48 && this.store.remainingBudgetMs() > 4000; }
  private async save(kind: string, value: Record<string, unknown>) {
    this.operations++;
    // Callers may pass the full mutable checkpoint; serialize only the fence schema.
    const { actorId, fingerprint, asOf, expiresAt } = this.fence;
    return this.store.saveSession({ actorId, fingerprint, asOf, expiresAt, kind, ...value });
  }
  private async read(id: string, kind: string) {
    this.operations++;
    const value = await this.store.readSession(id);
    if (!value || value.kind !== kind || value.actorId !== this.fence.actorId || value.fingerprint !== this.fence.fingerprint || value.asOf !== this.fence.asOf || value.expiresAt !== this.fence.expiresAt) expired();
    return value;
  }
  private async block(id: string) {
    let block = this.blocks.get(id);
    if (!block) {
      const value = await this.read(id, "occurrence-sorted-block");
      if (!heads(value.heads) || !value.heads.length || !token(value.next)) expired();
      block = { heads: value.heads, next: value.next }; this.blocks.set(id, block);
    }
    return block;
  }
  private async saveBlock(values: OccurrenceHead[], next: string | null) {
    const id = await this.save("occurrence-sorted-block", { heads: values, next });
    this.blocks.set(id, { heads: values, next }); return id;
  }
  private async manifest(values: string[], next: string | null) { return this.save("occurrence-sort-manifest", { runs: values, next }); }
  private fits(values: OccurrenceHead[]) { return values.length <= 50 && sessionBytes(values) <= blockBytes; }
  public async add(head: OccurrenceHead) {
    if (!this.fits([head])) throw new Error("Occurrence exceeds sorting block budget.");
    if (!this.fits([...this.state.buffer, head])) await this.flushScan();
    this.state.buffer.push(head);
  }
  private async flushScan() {
    const s = this.state; if (!s.buffer.length) return;
    s.buffer.sort((a, b) => b.order.localeCompare(a.order));
    s.descriptors.push(await this.saveBlock(s.buffer, null)); s.buffer = []; s.count++;
    if (s.descriptors.length === descriptorLimit) { s.manifest = await this.manifest(s.descriptors, s.manifest); s.descriptors = []; }
  }
  /** Returns an in-memory sorted window only when it never spilled. */
  public async finishScan(): Promise<OccurrenceHead[] | null> {
    const s = this.state;
    if (!s.count) { s.stage = "output"; const result = s.buffer.sort((a, b) => a.order.localeCompare(b.order)); s.buffer = []; return result; }
    await this.flushScan(); s.stage = "merge"; return null;
  }
  public async advance() {
    const s = this.state;
    while (s.stage === "merge" && this.available()) {
      if (!s.merge) {
        if (s.count === 1 && s.direction === 1 && s.descriptors.length === 1 && !s.manifest) { s.final = { block: s.descriptors[0] ?? expired(), offset: 0 }; s.descriptors = []; s.stage = "output"; break; }
        s.merge = { input: s.manifest, pending: s.descriptors, sources: [], output: null, buffer: [], manifest: null, descriptors: [], count: 0 };
      }
      const m = s.merge;
      if (!m.sources.length && !m.output && !m.buffer.length) {
        while (m.sources.length < 4 && (m.pending.length || m.input) && this.available()) {
          if (!m.pending.length && m.input) {
            const page = await this.read(m.input, "occurrence-sort-manifest");
            if (!descriptors(page.runs) || !token(page.next)) expired(); m.pending = page.runs; m.input = page.next;
          }
          const block = m.pending.pop(); if (block) m.sources.push({ block, offset: 0 });
        }
        // Never begin a smaller group because budget expired while loading descriptors.
        if (m.sources.length < 4 && (m.pending.length || m.input) && !this.available()) break;
      }
      if (!m.sources.length) {
        s.manifest = m.manifest; s.descriptors = m.descriptors; s.count = m.count; s.direction = s.direction === 1 ? -1 : 1; s.merge = null; continue;
      }
      // Resume a group that was interrupted while its manifest was being loaded.
      while (m.sources.length < 4 && !m.output && !m.buffer.length && (m.pending.length || m.input) && this.available()) {
        if (!m.pending.length && m.input) { const page = await this.read(m.input, "occurrence-sort-manifest"); if (!descriptors(page.runs) || !token(page.next)) expired(); m.pending = page.runs; m.input = page.next; }
        const block = m.pending.pop(); if (block) m.sources.push({ block, offset: 0 });
      }
      if (!this.available()) break;
      let chosen: Position | undefined, head: OccurrenceHead | undefined;
      for (const source of m.sources) {
        if (!source.block) continue;
        if (!this.available()) return;
        const block = await this.block(source.block), candidate = block.heads[source.offset]; if (!candidate) expired();
        if (!head || s.direction * candidate.order.localeCompare(head.order) < 0) { head = candidate; chosen = source; }
      }
      if (!this.available()) return;
      if (!head || !chosen) {
        if (m.buffer.length) { m.output = await this.saveBlock([...m.buffer].reverse(), m.output); m.buffer = []; }
        if (!m.output) expired(); m.descriptors.push(m.output); m.count++; m.output = null; m.sources = [];
        if (m.descriptors.length === descriptorLimit) { m.manifest = await this.manifest(m.descriptors, m.manifest); m.descriptors = []; }
        continue;
      }
      if (!this.fits([...m.buffer, head])) { m.output = await this.saveBlock([...m.buffer].reverse(), m.output); m.buffer = []; }
      m.buffer.push(head);
      const block = await this.block(chosen.block ?? expired()); chosen.offset++;
      if (chosen.offset === block.heads.length) { chosen.block = block.next; chosen.offset = 0; }
    }
  }
  public async page(limit: number): Promise<{ heads: OccurrenceHead[]; positions: Position[] }> {
    const result: OccurrenceHead[] = [], positions: Position[] = [];
    const cursor = this.state.final ? { ...this.state.final } : null;
    while (cursor?.block && result.length < limit && this.available()) {
      const block = await this.block(cursor.block), head = block.heads[cursor.offset]; if (!head) expired();
      if (!this.fits([...result, head])) break;
      result.push(head); cursor.offset++;
      if (cursor.offset === block.heads.length) { cursor.block = block.next; cursor.offset = 0; }
      positions.push({ ...cursor });
    }
    return { heads: result, positions };
  }
  public consume(position: Position | undefined) { if (position) this.state.final = { ...position }; }
}
