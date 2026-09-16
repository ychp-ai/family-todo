import { AsyncLocalStorage } from "node:async_hooks";
import { isApiRequestEnvelope, isRecord, FAMILY_ACTIONS, PERSONAL_ACTIONS } from "@family-todo/contracts";
import type { ApiResponse } from "@family-todo/contracts";
import type { PersonalDatabase } from "./personal-store";
import type { IdentityTransaction } from "./identity-store";

type CounterName = "documentReads" | "documentWrites" | "queries" | "returnedRows" | "transactions" | "retries";
type Counters = Record<CounterName, number>;
type DatabaseOperation = "documentRead" | "documentWrite" | "query";
type DetailedDatabaseMetrics = Record<string, Record<DatabaseOperation, number>>;
interface MetricsContext extends Counters { databaseWaitCumulativeMs: number; detailedDatabase?: DetailedDatabaseMetrics }
export interface MeasureApiOptions { detailedDatabase?: boolean }

const storage = new AsyncLocalStorage<MetricsContext>();
const operations: readonly DatabaseOperation[] = ["documentRead", "documentWrite", "query"];
const safeCollections = ["identities", "users", "user_scopes", "tasks", "task_events", "idempotency_receipts", "query_sessions", "families", "memberships", "membership_slots", "virtual_members", "invitations", "family_events", "reminder_preferences", "reminder_receipts", "schedule_segments", "schedule_controls", "occurrence_states", "historical_subject_access", "other"] as const;
const safeCollectionSet: ReadonlySet<string> = new Set(safeCollections);

function detailedMetrics(): DetailedDatabaseMetrics {
  return Object.fromEntries(safeCollections.map(collection => [collection, Object.fromEntries(operations.map(operation => [operation, 0]))])) as DetailedDatabaseMetrics;
}
function safeCollection(collection: string): string { return safeCollectionSet.has(collection) ? collection : "other"; }
export function countMetric(name: CounterName, value = 1): void { const current = storage.getStore(); if (current) current[name] += value; }
function countDatabase(collection: string, operation: DatabaseOperation): void {
  const current = storage.getStore();
  const metrics = current?.detailedDatabase?.[safeCollection(collection)];
  if (metrics) metrics[operation] += 1;
}
async function waitForDatabase<T>(work: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await work(); }
  finally { const current = storage.getStore(); if (current) current.databaseWaitCumulativeMs += performance.now() - started; }
}
function rows(value: unknown): unknown { if (isRecord(value) && Array.isArray(value.data)) countMetric("returnedRows", value.data.length); return value; }

/** No identifiers, filters, collection names or document bodies are recorded. Context follows this invocation only. */
export function observeDatabase(db: PersonalDatabase): PersonalDatabase {
  type Collection = ReturnType<PersonalDatabase["collection"]>;
  type Query = ReturnType<Collection["where"]>;
  const query = (source: Query, collection: string): Query => ({
    field: fields => query(source.field(fields), collection),
    where: filter => query(source.where(filter), collection), orderBy: (field, direction) => query(source.orderBy(field, direction), collection), limit: count => query(source.limit(count), collection),
    get: async () => { countMetric("queries"); countDatabase(collection, "query"); return rows(await waitForDatabase(() => source.get())); }
  });
  const transaction = (tx: IdentityTransaction): IdentityTransaction => ({ collection: name => ({ doc: id => {
    const doc = tx.collection(name).doc(id);
    return { get: async () => { countMetric("documentReads"); countDatabase(name, "documentRead"); return waitForDatabase(() => doc.get()); }, set: async options => { countMetric("documentWrites"); countDatabase(name, "documentWrite"); return waitForDatabase(() => doc.set(options)); } };
  } }) });
  return {
    command: db.command,
    collection: name => {
      const source = db.collection(name);
      return { ...query(source, name), doc: id => {
        const doc = source.doc(id);
        return { get: async () => { countMetric("documentReads"); countDatabase(name, "documentRead"); return waitForDatabase(() => doc.get()); }, set: async options => { countMetric("documentWrites"); countDatabase(name, "documentWrite"); return waitForDatabase(() => doc.set(options)); } };
      } };
    },
    runTransaction: (work, retries) => { countMetric("transactions"); return db.runTransaction(tx => work(transaction(tx)), retries); }
  };
}

export async function measureApi(event: unknown, run: () => Promise<ApiResponse<unknown>>, emit: (value: string) => void = console.info, options: MeasureApiOptions = {}): Promise<ApiResponse<unknown>> {
  const context: MetricsContext = { documentReads: 0, documentWrites: 0, queries: 0, returnedRows: 0, transactions: 0, retries: 0, databaseWaitCumulativeMs: 0, ...(options.detailedDatabase ? { detailedDatabase: detailedMetrics() } : {}) };
  return storage.run(context, async () => {
    const started = performance.now(); const response = await run();
    const known = new Set<string>(["system.health", "identity.ensure", ...FAMILY_ACTIONS, ...PERSONAL_ACTIONS]);
    const action = isApiRequestEnvelope(event) && known.has(event.action) ? event.action : "unknown";
    try {
      const serializationStarted = performance.now(); const serializedResponse = JSON.stringify(response); const serializationMs = performance.now() - serializationStarted;
      const { detailedDatabase, databaseWaitCumulativeMs, ...counters } = context;
      const entry = { kind: "api.performance", action, requestId: response.requestId, ok: response.ok, code: response.ok ? null : response.error.code, durationMs: Math.round(performance.now() - started), responseBytes: Buffer.byteLength(serializedResponse), databaseWaitCumulativeMs: Math.round(databaseWaitCumulativeMs * 1000) / 1000, serializationMs: Math.round(serializationMs * 1000) / 1000, ...counters, ...(detailedDatabase ? { databaseOperations: detailedDatabase } : {}) };
      emit(JSON.stringify(entry));
    } catch { /* Keep the original API result even when serialization or logging fails. */ }
    return response;
  });
}
