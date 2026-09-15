import { AsyncLocalStorage } from "node:async_hooks";
import { isApiRequestEnvelope, isRecord, FAMILY_ACTIONS, PERSONAL_ACTIONS } from "@family-todo/contracts";
import type { ApiResponse } from "@family-todo/contracts";
import type { PersonalDatabase } from "./personal-store";
import type { IdentityTransaction } from "./identity-store";

type Counters = { documentReads: number; documentWrites: number; queries: number; returnedRows: number; transactions: number; retries: number };
const storage = new AsyncLocalStorage<Counters>();
export function countMetric(name: keyof Counters, value = 1): void { const current = storage.getStore(); if (current) current[name] += value; }
function rows(value: unknown): unknown { if (isRecord(value) && Array.isArray(value.data)) countMetric("returnedRows", value.data.length); return value; }
/** No identifiers, queries or document bodies are recorded. Context follows this invocation only. */
export function observeDatabase(db: PersonalDatabase): PersonalDatabase {
  type Collection = ReturnType<PersonalDatabase["collection"]>;
  type Query = ReturnType<Collection["where"]>;
  const query = (source: Query): Query => ({
    where: filter => query(source.where(filter)), orderBy: (field, direction) => query(source.orderBy(field, direction)), limit: count => query(source.limit(count)),
    get: async () => { countMetric("queries"); return rows(await source.get()); }
  });
  const transaction = (tx: IdentityTransaction): IdentityTransaction => ({ collection: name => ({ doc: id => {
    const doc = tx.collection(name).doc(id);
    return { get: async () => { countMetric("documentReads"); return doc.get(); }, set: async options => { countMetric("documentWrites"); return doc.set(options); } };
  } }) });
  return {
    command: db.command,
    collection: name => {
      const source = db.collection(name);
      return { ...query(source), doc: id => {
        const doc = source.doc(id);
        return { get: async () => { countMetric("documentReads"); return doc.get(); }, set: async options => { countMetric("documentWrites"); return doc.set(options); } };
      } };
    },
    runTransaction: (work, retries) => { countMetric("transactions"); return db.runTransaction(tx => work(transaction(tx)), retries); }
  };
}
export async function measureApi(event: unknown, run: () => Promise<ApiResponse<unknown>>, emit: (value: string) => void = console.info): Promise<ApiResponse<unknown>> {
  const counters: Counters = { documentReads: 0, documentWrites: 0, queries: 0, returnedRows: 0, transactions: 0, retries: 0 };
  return storage.run(counters, async () => {
    const started = performance.now(); const response = await run();
    const known = new Set<string>(["system.health", "identity.ensure", ...FAMILY_ACTIONS, ...PERSONAL_ACTIONS]);
    const action = isApiRequestEnvelope(event) && known.has(event.action) ? event.action : "unknown";
    // Metrics are best effort; logging must never turn a committed write into a failed response.
    try { emit(JSON.stringify({ kind: "api.performance", action, requestId: response.requestId, ok: response.ok, code: response.ok ? null : response.error.code, durationMs: Math.round(performance.now() - started), responseBytes: Buffer.byteLength(JSON.stringify(response)), ...counters })); } catch { /* Keep the original API result. */ }
    return response;
  });
}
