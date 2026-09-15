import { listContexts } from "./list-contexts";
import { instant, integer, isOccurrenceDTO, isPersonalData, isPersonalPayload, isRecord, isUuid, localDate } from "@family-todo/contracts";
import type { OccurrenceDTO, PersonalActionMap, ResolvedSubject, Summary, TaskSummaryDTO } from "@family-todo/contracts";
import { addDays, familyTaskRights, localDateAt, previousSegmentDate, projectOccurrences } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext, PersistedScheduleSegment, ReminderReceipt } from "@family-todo/domain";
import type { Clock, FamilyStore } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { taskDTO } from "./personal";
import { familyTaskDTO, familyTaskSummary, summarizeTask, taskContext, taskMissing, verifyContext } from "./task-context";
import { legacySegment, overlayOccurrences, projectedDTO, projectionTask } from "./recurrence-projection";

type ListAction = "task.list" | "reminder.list" | "occurrence.list";
type Scope = { familyId: string | null; version: number; failed: boolean };
type Head = { order: string; occurrence: OccurrenceDTO };
// Persist only unconsumed IDs alongside the batch cursor; entities stay request-local.
const scanBatchSize = 20;
type Scan = { taskIds: string[]; segmentIds: string[]; scope: number; taskAfter: string | null; taskId: string | null; tasksDone: boolean; segmentAfter: string | null; segmentId: string | null; segmentsDone: boolean; slot: number };
type State = { actorId: string; fingerprint: string; asOf: string; expiresAt: string; revision: number; scopes: Scope[]; from: string; to: string; oldest: string; olderHint: string | null; afterOrder: string | null; top: Head[]; trimmed: boolean; runs: string | null; runAfter: string | null; replayRuns: boolean; buffer: Head[]; scan: Scan; summary: Summary };
function expired(): never { throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。"); }
function nullableString(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function emptyScan(): Scan { return { taskIds: [], segmentIds: [], scope: 0, taskAfter: null, taskId: null, tasksDone: false, segmentAfter: null, segmentId: null, segmentsDone: false, slot: 0 }; }
function pendingIds(v: unknown): string[] {
  if (v === undefined) return []; // Sessions created before batched scanning.
  if (!Array.isArray(v) || v.length > scanBatchSize || !v.every(isUuid)) expired();
  return v;
}
function readHeads(value: unknown, limit: number): Head[] {
  if (!Array.isArray(value) || value.length > limit) expired();
  const heads: Head[] = [];
  for (const head of value) {
    if (!isRecord(head) || typeof head.order !== "string" || !isOccurrenceDTO(head.occurrence)) expired();
    heads.push({ order: head.order, occurrence: head.occurrence });
  }
  return heads;
}
function readState(v: unknown): State {
  if (!isRecord(v) || !isUuid(v.actorId) || typeof v.fingerprint !== "string" || !instant(v.asOf) || !instant(v.expiresAt) || !integer(v.revision, 1)
    || !(v.olderHint === undefined || v.olderHint === null || localDate(v.olderHint)) || !localDate(v.from) || !localDate(v.to) || !localDate(v.oldest) || !nullableString(v.afterOrder)
    || typeof v.trimmed !== "boolean" || !Array.isArray(v.scopes) || v.scopes.length > 11 || !Array.isArray(v.top) || v.top.length > 51 || !isRecord(v.scan) || !isRecord(v.summary)) expired();
  const scopes: Scope[] = [];
  for (const s of v.scopes) { if (!isRecord(s) || !(s.familyId === null || isUuid(s.familyId)) || !integer(s.version, 1) || typeof s.failed !== "boolean") expired(); scopes.push({ familyId: s.familyId, version: s.version, failed: s.failed }); }
  const top: Head[] = [];
  for (const h of v.top) { if (!isRecord(h) || typeof h.order !== "string" || !isOccurrenceDTO(h.occurrence)) expired(); top.push({ order: h.order, occurrence: h.occurrence }); }
  if (!(v.runs === undefined || nullableString(v.runs)) || !(v.runAfter === undefined || nullableString(v.runAfter)) || !(v.replayRuns === undefined || typeof v.replayRuns === "boolean")) expired();
  const runs = typeof v.runs === "string" ? v.runs : null, runAfter = typeof v.runAfter === "string" ? v.runAfter : null;
  const s = v.scan, total = v.summary;
  if (!integer(s.scope) || s.scope > scopes.length || !nullableString(s.taskAfter) || !(s.taskId === null || isUuid(s.taskId)) || typeof s.tasksDone !== "boolean"
    || !nullableString(s.segmentAfter) || !(s.segmentId === null || isUuid(s.segmentId)) || typeof s.segmentsDone !== "boolean" || !integer(s.slot) || s.slot > 186
    || !integer(total.completed) || !integer(total.pending) || !integer(total.skipped) || !integer(total.denominator)) expired();
  return { actorId: v.actorId, fingerprint: v.fingerprint, asOf: v.asOf, expiresAt: v.expiresAt, revision: v.revision, scopes, from: v.from, to: v.to, oldest: v.oldest, olderHint: v.olderHint === undefined ? older(v.from, 1) : typeof v.olderHint === "string" ? v.olderHint : null, afterOrder: v.afterOrder, top, trimmed: v.trimmed, runs, runAfter, replayRuns: v.replayRuns === true, buffer: readHeads(v.buffer ?? [], 50),
    scan: { taskIds: pendingIds(s.taskIds), segmentIds: pendingIds(s.segmentIds), scope: s.scope, taskAfter: s.taskAfter, taskId: s.taskId, tasksDone: s.tasksDone, segmentAfter: s.segmentAfter, segmentId: s.segmentId, segmentsDone: s.segmentsDone, slot: s.slot },
    summary: { completed: total.completed, pending: total.pending, skipped: total.skipped, denominator: total.denominator } };
}
function older(date: string, days: number): string { return date <= addDays("2000-01-01", days) ? "2000-01-01" : addDays(date, -days); }
function occurrenceOrder(o: OccurrenceDTO): string { return `${o.localDate ?? "9999-12-31"}/${o.time ?? "99:99"}/${o.taskId}/${o.id}`; }
/** Reusable visible occurrence stream. Every continuation freezes asOf and fences all scope revisions.
 * It returns an empty partial page when a finite scan budget is exhausted. Summaries are unknown until complete.
 * The optional subject is part of the cursor fingerprint, and matches the occurrence's historical subject.
 */
export class OccurrenceLists {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock) {}
  public async execute(action: ListAction, payload: unknown, subject?: ResolvedSubject, projectionOnly = false): Promise<unknown> {
    if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查列表筛选条件。");
    const now = this.clock.now().toISOString(); const today = localDateAt(now);
    let familyId: string | null | undefined; let taskId: string | undefined; let dateFrom = today; let dateTo = today; let overdue = false; let status: "pending" | "completed" | "skipped" | undefined;
    if (action === "task.list" && isPersonalPayload(action, payload)) { familyId = payload.familyId; dateFrom = payload.dateFrom ?? today; dateTo = payload.dateTo ?? today; overdue = payload.overdue ?? false; status = payload.status; }
    if (action === "occurrence.list" && isPersonalPayload(action, payload)) { taskId = payload.taskId; dateFrom = payload.dateFrom; dateTo = payload.dateTo; }
    const backlog = overdue || action === "reminder.list"; const includeDismissed = action === "reminder.list" && isPersonalPayload(action, payload) && payload.includeDismissed;
    const summaryView = action === "task.list" && isPersonalPayload(action, payload) && payload.view === "summary";
    const limit = payload.limit ?? 20;
    const start = await this.store.transaction(async tx => { const actor = await tx.actor(); return { actor, scope: await tx.scope(actor.id) }; });
    const target = taskId ? await this.store.readTask(taskId) : null;
    if (taskId) { if (!target || target.lifecycle === "deleted") taskMissing(); familyId = target.collaboration?.familyId ?? null; }
    const selected = await listContexts(this.store, start.actor.id, familyId);
    const scopes: Scope[] = familyId === undefined || familyId === null ? [{ familyId: null, version: start.scope.revision, failed: false }] : [];
    const contexts = new Map<string, FamilyContext>();
    for (const { family, context } of selected) {
      if (context && !context.members.some(m => m.userId === start.actor.id && m.status === "active")) expired();
      if (context) contexts.set(family.id, context);
      scopes.push({ familyId: family.id, version: context?.family.version ?? family.version, failed: !context });
    }
    if (taskId && scopes.some(s => s.failed)) throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "家庭暂时无法加载，请稍后重试。", true);
    const fingerprint = this.store.fingerprint({ action, payload: { ...payload, cursor: undefined }, subject, projectionOnly });
    const to = backlog ? (overdue ? older(today, 1) : today) : dateTo;
    let state: State = { actorId: start.actor.id, fingerprint, asOf: now, expiresAt: new Date(Date.parse(now) + 900000).toISOString(), revision: start.scope.revision, scopes,
      from: backlog ? older(to, 30) : dateFrom, to, oldest: to, olderHint: null, afterOrder: null, top: [], trimmed: false, runs: null, runAfter: null, replayRuns: false, buffer: [], scan: emptyScan(), summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } };
    if (payload.cursor) {
      state = readState(await this.store.readSession(payload.cursor));
      if (state.actorId !== start.actor.id || state.fingerprint !== fingerprint || state.revision !== start.scope.revision || state.expiresAt <= now
        || state.scopes.length !== scopes.length || state.scopes.some(s => !scopes.some(current => current.familyId === s.familyId && current.version === s.version && current.failed === s.failed))) expired();
    }
    const cache = new Map<string, { task: CollaborativeTask; context: FamilyContext | null }>();
    const reminderReceipts = new Map<string, ReminderReceipt | null>();
    const prepare = async (task: CollaborativeTask, scope: Scope) => {
      if (task.lifecycle === "deleted" || task.createdAt > state.asOf) return null;
      if (!task.recurrence && (!task.date || (!backlog && (task.date < state.from || task.date > state.to)))) return null;
      let context: FamilyContext | null = null;
      if (scope.familyId) { if (task.collaboration?.familyId !== scope.familyId) return null; context = await taskContext(this.store, task, contexts.get(scope.familyId), projectionOnly || summaryView || action === "reminder.list" ? start.actor.id : undefined); if (context.family.version !== scope.version) expired(); if (!familyTaskRights(task, context, start.actor.id).canView) return null; }
      else if (task.collaboration || task.ownerUserId !== start.actor.id) return null;
      if (action === "reminder.list") {
        if (context) {
          const currentContext = context;
          const allowed = await this.store.transaction(async tx => {
            await verifyContext(tx, currentContext, start.actor.id);
            const pref = await tx.preference(task.id, start.actor.id);
            return Boolean(pref?.enabled && !pref.selfDisabled && pref.membershipId === familyTaskRights(task, currentContext, start.actor.id).actor?.id);
          });
          if (!allowed) return null;
        } else if (!task.reminderEnabled || task.reminderSelfDisabled) return null;
      }
      const entry = { task, context }; cache.set(task.id, entry); return entry;
    };
    if (target && !await prepare(target, scopes[0] ?? expired())) taskMissing();
    const prefetchedTasks = new Map<string, CollaborativeTask>();
    const segments = new Map<string, PersistedScheduleSegment>();
    let work = 0;
    const hint = (date: string | null) => { if (date !== null && (state.olderHint === null || date > state.olderHint)) state.olderHint = date; };
    const retain = (head: Head) => {
      if (state.afterOrder && head.order <= state.afterOrder) return;
      state.top.push(head); state.top.sort((a, b) => a.order.localeCompare(b.order));
      if (state.top.length > limit + 1) { state.top.pop(); state.trimmed = true; }
    };
    const flush = async () => {
      if (!state.buffer.length) return;
      state.runs = await this.store.saveSession({ kind: "occurrence-run", actorId: state.actorId, fingerprint: state.fingerprint, asOf: state.asOf, expiresAt: state.expiresAt, next: state.runs, heads: state.buffer });
      state.buffer = []; work += 2;
    };
    // Spool bounded immutable runs once, so later pages never repeat source projection and state reads.
    while (state.replayRuns && state.runAfter && work < 180 && this.store.remainingBudgetMs() > 4000) {
      const run = await this.store.readSession(state.runAfter); work += 10;
      if (!run || run.kind !== "occurrence-run" || run.actorId !== state.actorId || run.fingerprint !== state.fingerprint || run.asOf !== state.asOf || run.expiresAt !== state.expiresAt || !nullableString(run.next)) expired();
      for (const head of readHeads(run.heads, 50)) retain(head);
      state.runAfter = run.next;
    }
    // Retain only the smallest limit+1 candidates. No ordering claim is made until every stream in this window is scanned.
    while (!state.replayRuns && state.scan.scope < state.scopes.length && work < 180 && (!projectionOnly || state.top.length < limit) && this.store.remainingBudgetMs() > 4000) {
      const scan = state.scan, scope = state.scopes[scan.scope]; if (!scope) expired();
      if (scope.failed || (!scan.taskId && scan.tasksDone && scan.taskIds.length === 0)) { state.scan = { ...emptyScan(), scope: scan.scope + 1 }; continue; }
      if (!scan.taskId) {
        if (scan.taskIds.length === 0) {
          const page = target ? { items: [target], after: null, more: false } : await this.store.scanTasks(start.actor.id, scope.familyId, { mode: "projection" }, state.asOf, scan.taskAfter, scanBatchSize);
          work += 2; scan.taskAfter = page.after; scan.tasksDone = !page.more;
          scan.taskIds = page.items.map(task => task.id);
          for (const task of page.items) prefetchedTasks.set(task.id, task);
        }
        const id = scan.taskIds.shift(); if (!id) continue;
        const task = prefetchedTasks.get(id) ?? await this.store.readTask(id); if (!task) expired();
        prefetchedTasks.delete(id);
        const entry = await prepare(task, scope); if (!entry) continue;
        const earliest = task.date && task.date < localDateAt(task.createdAt) ? task.date : localDateAt(task.createdAt);
        if (earliest < state.oldest) state.oldest = earliest;
        scan.taskId = task.id; scan.segmentIds = []; scan.segmentAfter = null; scan.segmentId = null; scan.segmentsDone = false; scan.slot = 0;
      }
      const task = cache.get(scan.taskId)?.task ?? await this.store.readTask(scan.taskId); work++;
      if (!task) expired();
      const entry = cache.get(task.id) ?? await prepare(task, scope); if (!entry) expired();
      if (!scan.segmentId && scan.segmentsDone && scan.segmentIds.length === 0) {
        // No historical lookup is needed if any visible segment already reaches the next day.
        if (backlog && task.recurrence && state.from > "2000-01-01" && state.olderHint !== older(state.from, 1)) {
          const end = await this.store.previousSegmentEnd(task.id, state.from); work += 2;
          if (end !== null) hint(localDateAt(end));
        }
        scan.taskId = null; continue;
      }
      let segment: PersistedScheduleSegment | null;
      if (!scan.segmentId) {
        if (scan.segmentIds.length === 0) {
          const page = task.recurrence ? await this.store.segments(task.id, scan.segmentAfter, scanBatchSize, { from: state.from, to: state.to, currentSegmentId: task.recurrence.currentSegmentId }) : { items: [legacySegment(task)], after: null, more: false };
          work += 2; scan.segmentAfter = page.after; scan.segmentsDone = !page.more;
          scan.segmentIds = page.items.map(segment => segment.id);
          for (const segment of page.items) segments.set(segment.id, segment);
        }
        const id = scan.segmentIds.shift(); if (!id) continue;
        segment = segments.get(id) ?? (task.recurrence ? await this.store.readSegment(id) : legacySegment(task));
        scan.segmentId = id; scan.slot = 0;
      } else { segment = segments.get(scan.segmentId) ?? (task.recurrence ? await this.store.readSegment(scan.segmentId) : legacySegment(task)); work++; }
      if (!segment || segment.taskId !== task.id) expired();
      if (backlog) hint(previousSegmentDate(segment, state.from, projectionTask(task).activeOnceSegmentId));
      let index = 0, exhausted = true;
      const candidates = [...projectOccurrences({ task: projectionTask(task), segments: [segment], controls: [], dateFrom: state.from, dateTo: state.to, now: state.asOf })];
      let batch: Awaited<ReturnType<typeof overlayOccurrences>> = []; let batchStart = -1;
      for (const candidate of candidates) {
        if (index++ < scan.slot) continue;
        if (work + 4 > 180 || (projectionOnly && state.top.length >= limit) || this.store.remainingBudgetMs() <= 4000) { exhausted = false; break; }
        scan.slot = index; work += 4;
        if (candidate.localDate === null) continue;
        if (batchStart < 0 || index - 1 >= batchStart + batch.length) {
          batchStart = index - 1;
          const count = Math.min(20, Math.floor((180 - work) / 4) + 1, projectionOnly ? limit - state.top.length : 20);
          batch = await overlayOccurrences(this.store, task, candidates.slice(batchStart, batchStart + count));
          if (action === "reminder.list" && (task.recurrence || entry.context)) {
            const ids = batch.flatMap(occurrence => occurrence && occurrence.status === "pending" && occurrence.scheduledAt !== null && occurrence.scheduledAt <= state.asOf
              ? [task.recurrence ? this.store.deriveOccurrenceId(occurrence.identity) : task.occurrenceId] : []).filter(id => !reminderReceipts.has(id));
            const receipts = await this.store.readReminderReceipts(ids, start.actor.id);
            for (const id of ids) reminderReceipts.set(id, null);
            for (const receipt of receipts) reminderReceipts.set(receipt.occurrenceId, receipt);
          }
        }
        const overlaid = batch[index - 1 - batchStart]; if (!overlaid) continue;
        const occurrence = projectedDTO(this.store, task, entry.context, start.actor.id, overlaid);
        if (subject && this.store.fingerprint(subject) !== this.store.fingerprint(occurrence.subject)) continue;
        if ((backlog && occurrence.status !== "pending") || (status && occurrence.status !== status)) continue;
        if (action === "reminder.list") {
          if (!occurrence.scheduledAt || occurrence.scheduledAt > state.asOf) continue;
          const receipt = !task.recurrence && !entry.context ? task : reminderReceipts.get(occurrence.id);
          if (!includeDismissed && receipt?.dismissedAt) continue;
        }
        const order = occurrenceOrder(occurrence); if (!projectionOnly && state.afterOrder && order <= state.afterOrder) continue;
        if (projectionOnly) state.top.push({ order, occurrence });
        else {
          const head = { order, occurrence }; retain(head); state.buffer.push(head);
          if (state.buffer.length === 50) await flush();
        }
      }
      if (exhausted) { segments.delete(segment.id); scan.segmentId = null; scan.slot = 0; }
    }
    const scanned = state.scan.scope === state.scopes.length && (!state.replayRuns || state.runAfter === null);
    if (scanned && !projectionOnly) { if (state.trimmed) await flush(); else state.buffer = []; }
    const heads = scanned || projectionOnly ? state.top.slice(0, limit) : [];
    const items: unknown[] = []; const renderedTasks = new Map<string, TaskSummaryDTO>();
    for (const head of heads) {
      if (this.store.remainingBudgetMs() <= 4000) break;
      if (projectionOnly) {
        items.push(head.occurrence);
        state.summary[head.occurrence.status]++; if (head.occurrence.status !== "skipped") state.summary.denominator++;
        continue;
      }
      const task = cache.get(head.occurrence.taskId)?.task ?? await this.store.readTask(head.occurrence.taskId); if (!task) expired();
      const scope = state.scopes.find(s => s.familyId === (task.collaboration?.familyId ?? null)); if (!scope) expired();
      const entry = cache.get(task.id) ?? await prepare(task, scope); if (!entry) expired();
      if (action === "occurrence.list") items.push(head.occurrence);
      else if (action === "task.list") {
        const dto: TaskSummaryDTO = renderedTasks.get(task.id) ?? (summaryView ? (entry.context ? familyTaskSummary(task, entry.context, start.actor.id) : summarizeTask(taskDTO(task))) : entry.context ? await this.store.transaction(async tx => { if (!entry.context) expired(); await verifyContext(tx, entry.context, start.actor.id); return familyTaskDTO(tx, task, entry.context, start.actor.id); }) : taskDTO(task));
        renderedTasks.set(task.id, dto); items.push({ task: dto, occurrence: head.occurrence });
      } else {
        const receipt = !task.recurrence && !entry.context ? task : reminderReceipts.has(head.occurrence.id) ? reminderReceipts.get(head.occurrence.id) : await this.store.transaction(tx => tx.reminderReceipt(head.occurrence.id, start.actor.id));
        const o = head.occurrence; items.push({ occurrence: { id: o.id, taskId: o.taskId, segmentId: o.segmentId, localDate: o.localDate, slot: o.slot }, title: task.title, familyId: entry.context?.family.id ?? null, familyName: entry.context?.family.name ?? null, subjectName: o.subjectName, scheduledAt: o.scheduledAt, readAt: receipt?.readAt ?? null, dismissedAt: receipt?.dismissedAt ?? null });
      }
      state.afterOrder = head.order;
      state.summary[head.occurrence.status]++; if (head.occurrence.status !== "skipped") state.summary.denominator++;
    }
    let complete = false;
    if (projectionOnly || scanned) state.top = state.top.slice(items.length);
    if (scanned) {
      if (state.top.length > 0) { /* Retain hydrated-page remainder under the same completed window scan. */ }
      else if (state.trimmed) {
        state.trimmed = false;
        if (state.runs) { state.replayRuns = true; state.runAfter = state.runs; }
        else state.scan = emptyScan(); // Legacy sessions have no materialized runs.
      }
      else if (backlog && state.olderHint !== null && state.from > "2000-01-01") { state.to = state.olderHint < state.from ? state.olderHint : older(state.from, 1); state.olderHint = null; state.from = older(state.to, 30); state.afterOrder = null; state.scan = emptyScan(); state.runs = null; state.runAfter = null; state.replayRuns = false; state.buffer = []; }
      else complete = true;
    }
    await this.store.transaction(async tx => {
      const actor = await tx.actor(); if (actor.id !== state.actorId || (await tx.scope(actor.id)).revision !== state.revision) expired();
      for (const scope of state.scopes) { if (!scope.familyId || scope.failed) continue; const family = await tx.family(scope.familyId); const slot = await tx.slot(scope.familyId, actor.id); if (!family || family.version !== scope.version || !slot?.activeMembershipId) expired(); }
    });
    const nextCursor = complete ? null : await this.store.saveSession({ ...state });
    const base = { items, complete, nextCursor, asOf: state.asOf };
    const result = action === "occurrence.list" ? base : { ...base, scopes: state.scopes.map(s => ({ familyId: s.familyId, status: s.failed ? "failed" : complete ? "ok" : "partial", ...(s.failed ? { errorCode: "TEMPORARILY_UNAVAILABLE" } : {}) })), summary: complete && state.scopes.every(s => !s.failed) ? state.summary : null };
    if (projectionOnly) {
      if (!isPersonalData("occurrence.list", base)) throw new Error("Invalid internal projection page.");
      return { ...base, failed: state.scopes.some(scope => scope.failed) };
    }
    if (!isPersonalData(action, result)) throw new Error("Invalid occurrence list result."); return result;
  }
  public async occurrences(payload: PersonalActionMap["occurrence.list"]["payload"]) { return this.execute("occurrence.list", payload); }
}
