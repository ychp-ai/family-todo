import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { exact, instant, integer, isRecord, isTaskEvent, isUuid, localDate, localTime } from "@family-todo/contracts";
import { scheduledInstant } from "@family-todo/domain";
import type { CollaborativeTask, PersonalEvent, PersonalScope, PersonalTask, User } from "@family-todo/domain";
import type { PersonalQuery, PersonalReceipt, PersonalStore, PersonalTransaction, QueryCheckpoint } from "@family-todo/ports";

import { readTaskRecurrence } from "./scheduling-codecs";
import { FamilyBudgetExceededError } from "@family-todo/ports";
import { budgetTransaction } from "./transaction-budget";
import { retryTransaction } from "./transaction-retry";
import { identityDocumentKey, readDocument, readUser } from "./identity-store";
import type { IdentityDocument, IdentityTransaction } from "./identity-store";
import type { WechatIdentity } from "./invocation-identity";

interface Query {
  field(fields: Record<string, boolean>): Query;
  where(filter: Record<string, unknown>): Query;
  orderBy(field: string, direction: "asc" | "desc"): Query;
  limit(count: number): Query;
  get(): unknown;
}
interface StorageDocument { get(): unknown; set(options: { data: Record<string, unknown> }): unknown; }
interface Collection extends Query { doc(id: string): StorageDocument }
interface QueryCondition { and(value: unknown): QueryCondition; }
interface Command { in(values: unknown[]): unknown; lt(value: unknown): unknown; lte(value: unknown): unknown; gt(value: unknown): unknown; gte(value: unknown): QueryCondition; }
export interface PersonalDatabase {
  collection(name: string): Collection;
  command: Command;
  runTransaction<T>(work: (tx: IdentityTransaction) => Promise<T>, retries: number): Promise<T>;
}
function malformed(): never { throw new Error("Invalid personal storage record."); }
function entityRecord(value: Record<string, unknown>, id: unknown): Record<string, unknown> {
  if (!isUuid(id) || (Object.hasOwn(value, "id") && value.id !== id)) malformed();
  return { ...value, id };
}
function entityFields<T extends { id: string }>(value: T): Omit<T, "id"> { const { id: _id, ...fields } = value; return fields; }
function nullableText(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function nullableInstant(v: unknown): v is string | null { return v === null || instant(v); }
export function readPersonalListSource(v: unknown): Omit<PersonalTask, "note"> {
  if (!isRecord(v) || !isUuid(v.id) || !isUuid(v.ownerUserId) || typeof v.ownerName !== "string" || typeof v.title !== "string" || !v.title.trim() || [...v.title].length > 80 || !integer(v.version,1) || !isUuid(v.segmentId) || !isUuid(v.occurrenceId)
    || !(v.date === null || localDate(v.date)) || !(v.time === null || localTime(v.time)) || (v.date === null && v.time !== null)
    || (v.lifecycle !== "active" && v.lifecycle !== "paused" && v.lifecycle !== "stopped" && v.lifecycle !== "deleted") || (v.status !== "pending" && v.status !== "completed" && v.status !== "skipped")
    || !integer(v.occurrenceVersion) || !nullableInstant(v.actualCompletedAt) || !nullableInstant(v.recordedAt) || !nullableText(v.operatorName)
    || typeof v.reminderEnabled !== "boolean" || typeof v.reminderSelfDisabled !== "boolean" || !integer(v.reminderVersion)
    || !nullableInstant(v.readAt) || !nullableInstant(v.dismissedAt) || !instant(v.createdAt) || !instant(v.updatedAt)) malformed();
  return {candidateKind: v.candidateSchema === 1 && (v.candidateKind === "single" || v.candidateKind === "history") ? v.candidateKind : v.recurrence === undefined ? "single" : "history",...(v.recurrence === undefined ? {} : { recurrence: readTaskRecurrence(v.recurrence) }),id:v.id,ownerUserId:v.ownerUserId,ownerName:v.ownerName,title:v.title,version:v.version,segmentId:v.segmentId,occurrenceId:v.occurrenceId,date:v.date,time:v.time,lifecycle:v.lifecycle,status:v.status,occurrenceVersion:v.occurrenceVersion,actualCompletedAt:v.actualCompletedAt,recordedAt:v.recordedAt,operatorName:v.operatorName,reminderEnabled:v.reminderEnabled,reminderSelfDisabled:v.reminderSelfDisabled,reminderVersion:v.reminderVersion,readAt:v.readAt,dismissedAt:v.dismissedAt,createdAt:v.createdAt,updatedAt:v.updatedAt};
}
export function readPersonalTask(v: unknown): PersonalTask {
  const source = readPersonalListSource(v);
  if (!isRecord(v) || typeof v.note !== "string" || [...v.note].length > 1000) malformed();
  return { ...source, note: v.note };
}
function readScope(v: unknown): PersonalScope {
  if (!isRecord(v) || v.schemaVersion !== 1 || !isUuid(v.userId) || !integer(v.revision,1) || !integer(v.personalTaskCount) || v.personalTaskCount > 500 || !integer(v.activeFamilyCount)) malformed();
  return {userId:v.userId,revision:v.revision,personalTaskCount:v.personalTaskCount,activeFamilyCount:v.activeFamilyCount};
}
function reverseTime(instantValue: string): string { return String(9999999999999-Date.parse(instantValue)).padStart(13,"0"); }
export function taskFields(task: CollaborativeTask): Record<string,unknown> {
  const schedule = task.recurrence?.schedule;
  const date = task.date ?? "9999-12-31";
  const indexedDate = (schedule?.kind === "once" ? schedule.date : task.date) ?? "9999-12-31";
  const time = schedule?.kind === "once" ? schedule.time : task.time;
  const window = Math.floor(Date.parse(date)/86400000/31);
  return {...entityFields(task),candidateSchema:1,scopeKey:task.collaboration ? `f/${task.collaboration.familyId}` : `p/${task.ownerUserId}`,candidateKind:task.candidateKind === "history" || (task.recurrence && (task.candidateKind !== "single" || task.recurrence.schedule.kind !== "once")) ? "history" : "single",schemaVersion:1,scheduledAt:scheduledInstant(task),candidateOrder:`${indexedDate}/${time ?? "99:99"}/${task.id}`,scheduleOrder:`${date}/${task.time ?? "99:99"}/${task.id}`,recentOrder:`${String(999999-window).padStart(6,"0")}/${date}/${task.time ?? "99:99"}/${task.id}`,createdOrder:`${reverseTime(task.createdAt)}/${task.id}`};
}
export class Transaction implements PersonalTransaction {
  public constructor(private readonly tx: IdentityTransaction, private readonly identity: WechatIdentity) {}
  protected doc(collection: string,id: string): IdentityDocument { return this.tx.collection(collection).doc(id); }
  public async actor(): Promise<User> {
    const mapping = readDocument(await this.doc("identities",identityDocumentKey(this.identity)).get());
    if (!mapping || mapping.schemaVersion !== 1 || mapping.provider !== this.identity.provider || mapping.appId !== this.identity.appId || mapping.subject !== this.identity.subject || !isUuid(mapping.userId)) malformed();
    const user = readDocument(await this.doc("users",mapping.userId).get());
    if (!user || user.schemaVersion !== 1 || user._id !== mapping.userId) malformed();
    return readUser({...user,id:user._id});
  }
  public async scope(userId: string): Promise<PersonalScope> { const scope = readScope(readDocument(await this.doc("user_scopes",userId).get())); if (scope.userId !== userId) malformed(); return scope; }
  public async saveScope(scope: PersonalScope): Promise<void> {
    // 更新而非覆盖身份阶段创建的元数据。
    const previous = readDocument(await this.doc("user_scopes",scope.userId).get()); if (!previous) malformed();
    const {_id,...fields} = previous;
    await this.doc("user_scopes",scope.userId).set({data:{...fields,...scope}});
  }
  public async task(id: string): Promise<PersonalTask | null> {
    const value = readDocument(await this.doc("tasks",id).get()); if (!value) return null;
    if (value.collaboration !== undefined) return null;
    if (value.schemaVersion !== 1 || value._id !== id) malformed();
    return readPersonalTask(entityRecord(value, value._id));
  }
  public async saveTask(task: PersonalTask): Promise<void> { await this.doc("tasks",task.id).set({data:taskFields(task)}); }
  private receiptKey(userId: string,requestId: string): string { return createHash("sha256").update(JSON.stringify([userId,requestId])).digest("hex"); }
  public async receipt(userId: string,requestId: string): Promise<PersonalReceipt | null> {
    const v = readDocument(await this.doc("idempotency_receipts",this.receiptKey(userId,requestId)).get()); if (!v) return null;
    if (v.schemaVersion !== 1 || v.userId !== userId || v.requestId !== requestId || typeof v.fingerprint !== "string" || !isUuid(v.taskId) || !("result" in v)) malformed();
    return {fingerprint:v.fingerprint,taskId:v.taskId,result:v.result};
  }
  public async saveReceipt(userId: string,requestId: string,receipt: PersonalReceipt): Promise<void> { await this.doc("idempotency_receipts",this.receiptKey(userId,requestId)).set({data:{schemaVersion:1,userId,requestId,...receipt}}); }
  public async addEvent(event: PersonalEvent): Promise<void> {
    const doc = this.doc("task_events",event.id); if (readDocument(await doc.get())) throw new Error("Event identifier collision.");
    await doc.set({data:{...entityFields(event),schemaVersion:1,eventOrder:`${reverseTime(event.recordedAt)}/${event.id}`}});
  }
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
function checkpoint(v: unknown): QueryCheckpoint | null {
  if (!isRecord(v) || !isUuid(v.actorId) || typeof v.fingerprint !== "string" || !integer(v.revision,1) || !instant(v.asOf) || !nullableText(v.after) || !instant(v.expiresAt) || !exact(v.summary,["completed","pending","skipped","denominator"])) return null;
  const s = v.summary;
  if (!integer(s.completed) || !integer(s.pending) || !integer(s.skipped) || !integer(s.denominator)) return null;
  return {actorId:v.actorId,fingerprint:v.fingerprint,revision:v.revision,asOf:v.asOf,after:v.after,expiresAt:v.expiresAt,summary:{completed:s.completed,pending:s.pending,skipped:s.skipped,denominator:s.denominator}};
}
export class CloudBasePersonalStore implements PersonalStore {
  private budget(minimum = 1): void { if (this.deadline - this.nowMs() < minimum) throw new FamilyBudgetExceededError(); }
  public constructor(private readonly db: PersonalDatabase,private readonly identity: WechatIdentity,private readonly cursorSecret: string, private readonly deadline = Date.now() + 8000, private readonly nowMs: () => number = Date.now) { if (cursorSecret.length < 32) throw new Error("Cursor secret unavailable."); }
  public transaction<T>(work: (tx: PersonalTransaction) => Promise<T>): Promise<T> {
    return retryTransaction(() => {
      this.budget(2000);
      return this.db.runTransaction(async tx => {
        const result = await work(new Transaction(budgetTransaction(tx, () => this.budget()), this.identity));
        this.budget(); return result;
      }, 0);
    }, { maxRetries: 2 });
  }
  public fingerprint(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
  public async scan(userId: string,query: PersonalQuery,asOf: string,after: string | null,limit: number) {
    this.budget();
    const command = this.db.command;
    const filter: Record<string,unknown> = query.mode === "history" ? {taskId:query.taskId} : {ownerUserId:userId,lifecycle:query.mode === "recycle" ? "deleted" : "active"};
    let order = query.mode === "history" ? "eventOrder" : query.mode === "recycle" || query.unscheduled ? "createdOrder" : query.overdueBefore || query.mode === "reminders" ? "recentOrder" : "scheduleOrder";
    if (query.status) filter.status = query.status;
    if (query.unscheduled) filter.date = null;
    if (query.overdueBefore) filter.date = command.gte("0001-01-01").and(command.lt(query.overdueBefore));
    if (query.dateFrom && query.dateTo) filter.date = command.gte(query.dateFrom).and(command.lte(query.dateTo));
    if (query.mode === "reminders") {
      filter.status = "pending"; filter.reminderEnabled = true; filter.scheduledAt = command.gte("0001-01-01T00:00:00.000Z").and(command.lte(asOf));
      if (!query.includeDismissed) filter.dismissedAt = null;
    }
    if (after) filter[order] = command.gt(after);
    const response = await this.db.collection(query.mode === "history" ? "task_events" : "tasks").where(filter).orderBy(order,"asc").limit(limit+1).get();
    this.budget();
    if (!isRecord(response) || !Array.isArray(response.data)) malformed();
    const rows: unknown[] = response.data; const more = rows.length > limit; const selected = rows.slice(0,limit);
    const tasks: PersonalTask[] = []; const events: PersonalEvent[] = []; let next = after;
    for (const row of selected) {
      if (!isRecord(row) || row.schemaVersion !== 1 || typeof row[order] !== "string") malformed();
      next = row[order];
      if (query.mode === "history") {
        const value = entityRecord(row, row._id);
        const event = {id:value.id,taskId:value.taskId,occurrenceId:value.occurrenceId,kind:value.kind,actorName:value.actorName,recordedAt:value.recordedAt,actualCompletedAt:value.actualCompletedAt,note:value.note};
        if (!isTaskEvent(event) || event.taskId !== query.taskId) malformed(); events.push(event);
      } else { if (row.collaboration !== undefined) continue; const task = readPersonalTask(entityRecord(row, row._id)); if (task.ownerUserId !== userId) malformed(); tasks.push(task); }
    }
    return {tasks,events,more,after:next};
  }
  private signature(id: string): string { return createHmac("sha256",this.cursorSecret).update(id).digest("base64url"); }
  public async saveCheckpoint(value: QueryCheckpoint): Promise<string> {
    this.budget();
    const id = randomBytes(24).toString("base64url");
    await this.db.collection("query_sessions").doc(id).set({data:{schemaVersion:1,...value}});
    this.budget();
    return `${id}.${this.signature(id)}`;
  }
  public async readCheckpoint(token: string): Promise<QueryCheckpoint | null> {
    if (!/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [id,signature] = token.split("."); if (!id || !signature) return null;
    const expected = this.signature(id); if (!timingSafeEqual(Buffer.from(expected),Buffer.from(signature))) return null;
    this.budget();
    const v = readDocument(await this.db.collection("query_sessions").doc(id).get());
    this.budget();
    return v?.schemaVersion === 1 ? checkpoint(v) : null;
  }
}
