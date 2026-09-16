import { OccurrenceSorter, emptyOccurrenceSort, readOccurrenceSort, sessionBytes } from "./occurrence-sort";
import type { OccurrenceSort } from "./occurrence-sort";
import { ListValidation, listFingerprint, nextListMidnight } from "./list-validation";
import { ListReadBatch } from "./list-read-batch";
import { listContexts } from "./list-contexts";
import { instant, integer, isOccurrenceDTO, isPersonalData, isPersonalPayload, isRecord, isUuid, localDate } from "@family-todo/contracts";
import type { OccurrenceDTO, PersonalActionMap, ResolvedSubject, Summary, TaskSummaryDTO } from "@family-todo/contracts";
import { addDays, familyTaskRights, localDateAt, previousSegmentDate, projectOccurrences } from "@family-todo/domain";
import type { CollaborativeTask, TaskListSource, FamilyContext, PersistedScheduleSegment } from "@family-todo/domain";
import type { Clock, FamilyStore } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { personalTaskSummary, taskDTO } from "./personal";
import { familyTaskDTO, familyTaskSummary, taskContext, taskMissing, verifyContext } from "./task-context";
import { legacySegment, overlayOccurrences, projectedDTO, projectionTask } from "./recurrence-projection";

type ListAction = "task.list" | "reminder.list" | "occurrence.list";
type Scope = { familyId: string | null; version: number; failed: boolean };
type Head = { order: string; occurrence: OccurrenceDTO };
// Persist only unconsumed IDs alongside the batch cursor; entities stay request-local.
const scanBatchSize = 20;
type Scan = { taskIds: string[]; segmentIds: string[]; scope: number; taskAfter: string | null; taskId: string | null; tasksDone: boolean; segmentAfter: string | null; segmentId: string | null; segmentsDone: boolean; slot: number };
type State = { nextInvalidationAt: string | null; actorId: string; fingerprint: string; asOf: string; expiresAt: string; revision: number; scopes: Scope[]; from: string; to: string; oldest: string; olderHint: string | null; afterOrder: string | null; top: Head[]; sort: OccurrenceSort; scan: Scan; summary: Summary };
function expired(): never { throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。"); }
function nullableString(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function emptyScan(): Scan { return { taskIds: [], segmentIds: [], scope: 0, taskAfter: null, taskId: null, tasksDone: false, segmentAfter: null, segmentId: null, segmentsDone: false, slot: 0 }; }
function pendingIds(v: unknown): string[] {
  if (v === undefined) return []; // Sessions created before batched scanning.
  if (!Array.isArray(v) || v.length > scanBatchSize || !v.every(isUuid)) expired();
  return v;
}
function readState(v: unknown): State {
  if (!isRecord(v) || v.kind !== "occurrence-list-v2" || !isUuid(v.actorId) || typeof v.fingerprint !== "string" || !instant(v.asOf) || !instant(v.expiresAt) || !integer(v.revision, 1)
    || !(v.olderHint === undefined || v.olderHint === null || localDate(v.olderHint)) || !localDate(v.from) || !localDate(v.to) || !localDate(v.oldest) || !nullableString(v.afterOrder)
    || !Array.isArray(v.scopes) || v.scopes.length > 11 || !Array.isArray(v.top) || v.top.length > 51 || !isRecord(v.scan) || !isRecord(v.summary)) expired();
  const scopes: Scope[] = [];
  for (const s of v.scopes) { if (!isRecord(s) || !(s.familyId === null || isUuid(s.familyId)) || !integer(s.version, 1) || typeof s.failed !== "boolean") expired(); scopes.push({ familyId: s.familyId, version: s.version, failed: s.failed }); }
  const top: Head[] = [];
  for (const h of v.top) { if (!isRecord(h) || typeof h.order !== "string" || !isOccurrenceDTO(h.occurrence)) expired(); top.push({ order: h.order, occurrence: h.occurrence }); }
  const s = v.scan, total = v.summary;
  if (!integer(s.scope) || s.scope > scopes.length || !nullableString(s.taskAfter) || !(s.taskId === null || isUuid(s.taskId)) || typeof s.tasksDone !== "boolean"
    || !nullableString(s.segmentAfter) || !(s.segmentId === null || isUuid(s.segmentId)) || typeof s.segmentsDone !== "boolean" || !integer(s.slot) || s.slot > 186
    || !integer(total.completed) || !integer(total.pending) || !integer(total.skipped) || !integer(total.denominator)) expired();
  return { nextInvalidationAt: instant(v.nextInvalidationAt) ? v.nextInvalidationAt : null, actorId: v.actorId, fingerprint: v.fingerprint, asOf: v.asOf, expiresAt: v.expiresAt, revision: v.revision, scopes, from: v.from, to: v.to, oldest: v.oldest, olderHint: v.olderHint === undefined ? older(v.from, 1) : typeof v.olderHint === "string" ? v.olderHint : null, afterOrder: v.afterOrder, top, sort: readOccurrenceSort(v.sort),
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
    const validation = new ListValidation(this.store, this.clock);
    const conditional = "conditional" in payload ? payload.conditional : undefined;
    const validationFingerprint = listFingerprint(this.store, action, payload, { subject, projectionOnly });
    if (!projectionOnly && action !== "occurrence.list") { const hit = await validation.reuse(conditional?.token, validationFingerprint); if (hit) return hit; }
    const now = this.clock.now().toISOString(); const today = localDateAt(now);
    let familyId: string | null | undefined; let taskId: string | undefined; let dateFrom = today; let dateTo = today; let overdue = false; let status: "pending" | "completed" | "skipped" | undefined;
    if (action === "task.list" && isPersonalPayload(action, payload)) { familyId = payload.familyId; dateFrom = payload.dateFrom ?? today; dateTo = payload.dateTo ?? today; overdue = payload.overdue ?? false; status = payload.status; }
    if (action === "occurrence.list" && isPersonalPayload(action, payload)) { taskId = payload.taskId; dateFrom = payload.dateFrom; dateTo = payload.dateTo; }
    const backlog = overdue || action === "reminder.list"; const includeDismissed = action === "reminder.list" && isPersonalPayload(action, payload) && payload.includeDismissed;
    const summaryView = action === "task.list" && isPersonalPayload(action, payload) && payload.view === "summary";
    const listSource = summaryView || projectionOnly;
    const fullTasks = new Map<string, CollaborativeTask>();
    const remember = (tasks: CollaborativeTask[]) => { for (const task of tasks) fullTasks.set(task.id, task); return tasks; };
    const readTasks = async (ids: string[]): Promise<TaskListSource[]> => listSource ? this.store.readListTasks(ids) : remember(await this.store.readTasks(ids));
    const readTask = async (id: string): Promise<TaskListSource | null> => {
      if (listSource) return this.store.readListTask(id);
      const task = await this.store.readTask(id); if (task) remember([task]); return task;
    };
    const limit = payload.limit ?? 20;
    const start = await this.store.transaction(async tx => { const actor = await tx.actor(); return { actor, scope: await tx.scope(actor.id) }; });
    const target = taskId ? await readTask(taskId) : null;
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
    const fingerprint = this.store.fingerprint({ sortAlgorithm: "immutable-merge-v2", candidateAlgorithm: this.store.candidateAlgorithm ?? "legacy", action, payload: { ...payload, cursor: undefined, conditional: undefined }, subject, projectionOnly });
    const to = backlog ? (overdue ? older(today, 1) : today) : dateTo;
    let state: State = { nextInvalidationAt: nextListMidnight(now), actorId: start.actor.id, fingerprint, asOf: now, expiresAt: new Date(Date.parse(now) + 900000).toISOString(), revision: start.scope.revision, scopes,
      from: backlog ? older(to, 30) : dateFrom, to, oldest: to, olderHint: null, afterOrder: null, top: [], sort: emptyOccurrenceSort(), scan: emptyScan(), summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } };
    if (payload.cursor) {
      state = readState(await this.store.readSession(payload.cursor));
      if (state.actorId !== start.actor.id || state.fingerprint !== fingerprint || state.revision !== start.scope.revision || state.expiresAt <= now
        || state.scopes.length !== scopes.length || state.scopes.some(s => !scopes.some(current => current.familyId === s.familyId && current.version === s.version && current.failed === s.failed))) expired();
    }
    const cache = new Map<string, { task: TaskListSource; context: FamilyContext | null }>();
    const reads = new ListReadBatch(this.store, start.actor.id);
    const reminderReceipts = reads.receipts;
    const actorHistory = projectionOnly || summaryView || action === "reminder.list";
    const prepare = async (task: TaskListSource, scope: Scope) => {
      if (task.lifecycle === "deleted" || task.createdAt > state.asOf) return null;
      if (!task.recurrence && (!task.date || (!backlog && (task.date < state.from || task.date > state.to)))) return null;
      let context: FamilyContext | null = null;
      if (scope.familyId) { if (task.collaboration?.familyId !== scope.familyId) return null; context = await taskContext(this.store, task, contexts.get(scope.familyId), actorHistory ? start.actor.id : undefined, reads.history.get(task.id)); if (context.family.version !== scope.version) expired(); if (!familyTaskRights(task, context, start.actor.id).canView) return null; }
      else if (task.collaboration || task.ownerUserId !== start.actor.id) return null;
      if (action === "reminder.list") {
        if (context) {
          await reads.prepare([task], context, actorHistory, true);
          const pref = reads.preferences.get(task.id);
          const allowed = Boolean(pref?.enabled && !pref.selfDisabled && pref.membershipId === familyTaskRights(task, context, start.actor.id).actor?.id);
          if (!allowed) return null;
        } else if (!task.reminderEnabled || task.reminderSelfDisabled) return null;
      }
      const entry = { task, context }; cache.set(task.id, entry); return entry;
    };
    if (target && !await prepare(target, scopes[0] ?? expired())) taskMissing();
    const prefetchedTasks = new Map<string, TaskListSource>();
    const prefetch = async (tasks: TaskListSource[], scope: Scope, project: boolean) => {
      const eligible = tasks.filter(task => task.lifecycle !== "deleted" && task.createdAt <= state.asOf && (task.collaboration?.familyId ?? null) === scope.familyId);
      await reads.prepare(eligible, scope.familyId ? contexts.get(scope.familyId) ?? null : null, actorHistory, action === "reminder.list");
      if (project) await reads.project(eligible, state.from, state.to, state.asOf, action === "reminder.list");
      for (const task of tasks) prefetchedTasks.set(task.id, task);
    };
    // Continued cursors retain IDs only; hydrate the remaining bounded batch once.
    const pendingScope = state.scopes[state.scan.scope];
    if (state.sort.stage === "scan" && pendingScope && !pendingScope.failed && this.store.remainingBudgetMs() > 4000) {
      const ids = [...new Set([...(state.scan.taskId ? [state.scan.taskId] : []), ...state.scan.taskIds])].slice(0, scanBatchSize);
      if (ids.length) await prefetch(await readTasks(ids), pendingScope, true);
    }
    const segments = new Map<string, PersistedScheduleSegment>();
    let work = 0;
    const hint = (date: string | null) => { if (date !== null && (state.olderHint === null || date > state.olderHint)) state.olderHint = date; };
    const sorter = new OccurrenceSorter(this.store, state, state.sort);
    // No ordering claim is made until every scope in this historical window is scanned.
    while (state.sort.stage === "scan" && state.scan.scope < state.scopes.length && work < 180 && (!projectionOnly || state.top.length < limit) && this.store.remainingBudgetMs() > 4000) {
      const scan = state.scan, scope = state.scopes[scan.scope]; if (!scope) expired();
      if (scope.failed || (!scan.taskId && scan.tasksDone && scan.taskIds.length === 0)) { state.scan = { ...emptyScan(), scope: scan.scope + 1 }; continue; }
      if (!scan.taskId) {
        if (scan.taskIds.length === 0) {
          const page = target ? { items: [target], after: null, more: false } : await (async () => {
            const candidateWindow = action === "task.list" && !projectionOnly && !backlog ? { from: state.from, to: state.to, backlog: false } : undefined;
            const query = { mode: "projection" as const, ...(candidateWindow ? { candidateWindow } : {}) };
            if (listSource) return this.store.scanListTasks(start.actor.id, scope.familyId, query, state.asOf, scan.taskAfter, scanBatchSize);
            const page = await this.store.scanTasks(start.actor.id, scope.familyId, query, state.asOf, scan.taskAfter, scanBatchSize);
            remember(page.items); return page;
          })();
          if ("olderHint" in page && typeof page.olderHint === "string") hint(page.olderHint);
          work += 2; scan.taskAfter = page.after; scan.tasksDone = !page.more;
          scan.taskIds = page.items.map(task => task.id);
          await prefetch(page.items, scope, true);
        }
        const id = scan.taskIds.shift(); if (!id) continue;
        const task = prefetchedTasks.get(id) ?? await readTask(id); if (!task) expired();
        prefetchedTasks.delete(id);
        const entry = await prepare(task, scope); if (!entry) continue;
        const earliest = task.date && task.date < localDateAt(task.createdAt) ? task.date : localDateAt(task.createdAt);
        if (earliest < state.oldest) state.oldest = earliest;
        scan.taskId = task.id; scan.segmentIds = []; scan.segmentAfter = null; scan.segmentId = null; scan.segmentsDone = false; scan.slot = 0;
      }
      const task = cache.get(scan.taskId)?.task ?? prefetchedTasks.get(scan.taskId) ?? await readTask(scan.taskId); work++;
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
      if (scan.segmentId && reads.segments.has(scan.segmentId) && reads.segments.get(scan.segmentId) === null) expired();
      let segment: PersistedScheduleSegment | null;
      if (!scan.segmentId) {
        if (scan.segmentIds.length === 0) {
          const currentSegment = task.recurrence ? reads.segments.get(task.recurrence.currentSegmentId) : null;
          if (task.recurrence && reads.segments.has(task.recurrence.currentSegmentId) && !currentSegment) expired();
          const page = task.recurrence ? await this.store.segments(task.id, scan.segmentAfter, scanBatchSize, { from: state.from, to: state.to, currentSegmentId: task.recurrence.currentSegmentId, ...(currentSegment ? { currentSegment } : {}) }) : { items: [legacySegment(task)], after: null, more: false };
          work += 2; scan.segmentAfter = page.after; scan.segmentsDone = !page.more;
          scan.segmentIds = page.items.map(segment => segment.id);
          for (const segment of page.items) segments.set(segment.id, segment);
        }
        const id = scan.segmentIds.shift(); if (!id) continue;
        segment = segments.get(id) ?? (task.recurrence ? await this.store.readSegment(id) : legacySegment(task));
        scan.segmentId = id; scan.slot = 0;
      } else { segment = segments.get(scan.segmentId) ?? reads.segments.get(scan.segmentId) ?? (task.recurrence ? await this.store.readSegment(scan.segmentId) : legacySegment(task)); work++; }
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
          batch = await overlayOccurrences(this.store, task, candidates.slice(batchStart, batchStart + count), reads.states);
          if (action === "reminder.list" && (task.recurrence || entry.context)) {
            const ids = batch.flatMap(occurrence => occurrence && occurrence.status === "pending" && occurrence.scheduledAt !== null && occurrence.scheduledAt <= state.asOf
              ? [task.recurrence ? this.store.deriveOccurrenceId(occurrence.identity) : task.occurrenceId] : []).filter(id => !reminderReceipts.has(id));
            const receipts = ids.length ? await this.store.readReminderReceipts(ids, start.actor.id) : [];
            for (const id of ids) reminderReceipts.set(id, null);
            for (const receipt of receipts) reminderReceipts.set(receipt.occurrenceId, receipt);
          }
        }
        const overlaid = batch[index - 1 - batchStart]; if (!overlaid) continue;
        if (state.nextInvalidationAt !== null) for (const boundary of [overlaid.eligibilityBoundary, overlaid.scheduledAt]) {
          if (boundary && boundary > state.asOf && boundary < state.nextInvalidationAt) state.nextInvalidationAt = boundary;
        }
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
          await sorter.add({ order, occurrence });
        }
      }
      if (exhausted) { segments.delete(segment.id); scan.segmentId = null; scan.slot = 0; }
    }
    const scanned = state.scan.scope === state.scopes.length;
    if (scanned && !projectionOnly && state.sort.stage === "scan" && this.store.remainingBudgetMs() > 4000) {
      const memory = await sorter.finishScan(); if (memory) state.top = memory;
    }
    if (!projectionOnly) await sorter.advance();
    const sortedPage = state.sort.stage === "output" && state.sort.final ? await sorter.page(limit) : null;
    const heads = sortedPage?.heads ?? (scanned || projectionOnly ? state.top.slice(0, limit) : []);
    // Hydration after scan/replay also batches the exact immutable head IDs.
    const missingHeadIds = [...new Set(heads.map(head => head.occurrence.taskId))].filter(id => !cache.has(id) && !prefetchedTasks.has(id));
    for (let offset = 0; offset < missingHeadIds.length && this.store.remainingBudgetMs() > 4000; offset += scanBatchSize) {
      const tasks = await readTasks(missingHeadIds.slice(offset, offset + scanBatchSize));
      for (const scope of state.scopes) {
        if (scope.failed) continue;
        await prefetch(tasks.filter(task => (task.collaboration?.familyId ?? null) === scope.familyId), scope, false);
      }
    }
    if (action === "reminder.list") for (let offset = 0; offset < heads.length && this.store.remainingBudgetMs() > 4000; offset += scanBatchSize) await reads.loadReceipts(heads.slice(offset, offset + scanBatchSize).map(head => head.occurrence.id));
    const items: unknown[] = []; const renderedTasks = new Map<string, TaskSummaryDTO>();
    for (const head of heads) {
      if (this.store.remainingBudgetMs() <= 4000) break;
      if (projectionOnly) {
        items.push(head.occurrence);
        state.summary[head.occurrence.status]++; if (head.occurrence.status !== "skipped") state.summary.denominator++;
        continue;
      }
      const task = cache.get(head.occurrence.taskId)?.task ?? prefetchedTasks.get(head.occurrence.taskId) ?? await readTask(head.occurrence.taskId); if (!task) expired();
      const scope = state.scopes.find(s => s.familyId === (task.collaboration?.familyId ?? null)); if (!scope) expired();
      const entry = cache.get(task.id) ?? await prepare(task, scope); if (!entry) expired();
      if (action === "occurrence.list") items.push(head.occurrence);
      else if (action === "task.list") {
        const dto: TaskSummaryDTO = renderedTasks.get(task.id) ?? (summaryView ? (entry.context ? familyTaskSummary(task, entry.context, start.actor.id) : personalTaskSummary(task)) : entry.context ? await this.store.transaction(async tx => { if (!entry.context) expired(); await verifyContext(tx, entry.context, start.actor.id); return familyTaskDTO(tx, fullTasks.get(task.id) ?? expired(), entry.context, start.actor.id); }) : taskDTO(fullTasks.get(task.id) ?? expired()));
        renderedTasks.set(task.id, dto); items.push({ task: dto, occurrence: head.occurrence });
      } else {
        const receipt = !task.recurrence && !entry.context ? task : reminderReceipts.has(head.occurrence.id) ? reminderReceipts.get(head.occurrence.id) : await this.store.transaction(tx => tx.reminderReceipt(head.occurrence.id, start.actor.id));
        const o = head.occurrence; items.push({ occurrence: { id: o.id, taskId: o.taskId, segmentId: o.segmentId, localDate: o.localDate, slot: o.slot }, title: task.title, familyId: entry.context?.family.id ?? null, familyName: entry.context?.family.name ?? null, subjectName: o.subjectName, scheduledAt: o.scheduledAt, readAt: receipt?.readAt ?? null, dismissedAt: receipt?.dismissedAt ?? null });
      }
      state.afterOrder = head.order;
      state.summary[head.occurrence.status]++; if (head.occurrence.status !== "skipped") state.summary.denominator++;
    }
    if (sortedPage && items.length) sorter.consume(sortedPage.positions[items.length - 1]);
    let complete = false;
    if (!sortedPage && (projectionOnly || scanned)) state.top = state.top.slice(items.length);
    if (scanned && (projectionOnly || state.sort.stage === "output")) {
      if (state.top.length > 0 || state.sort.final?.block) { /* Only rendered heads advance the immutable output position. */ }
      else if (backlog && state.olderHint !== null && state.from > "2000-01-01") {
        state.to = state.olderHint < state.from ? state.olderHint : older(state.from, 1); state.olderHint = null; state.from = older(state.to, 30);
        state.afterOrder = null; state.scan = emptyScan(); state.sort = emptyOccurrenceSort();
      } else complete = true;
    }
    await this.store.transaction(async tx => {
      const actor = await tx.actor(); if (actor.id !== state.actorId || (await tx.scope(actor.id)).revision !== state.revision) expired();
      for (const scope of state.scopes) { if (!scope.familyId || scope.failed) continue; const family = await tx.family(scope.familyId); const slot = await tx.slot(scope.familyId, actor.id); if (!family || family.version !== scope.version || !slot?.activeMembershipId || slot.activeMembershipId !== contexts.get(scope.familyId)?.members.find(member => member.userId === actor.id && member.status === "active")?.id) expired(); }
    });
    const checkpoint = { ...state, kind: "occurrence-list-v2" };
    if (sessionBytes(checkpoint) > 96 * 1024) throw new Error("Occurrence checkpoint exceeds byte budget.");
    const nextCursor = complete ? null : await this.store.saveSession(checkpoint);
    const families = [...contexts.values()].map(context => ({ familyId: context.family.id, version: context.family.version, membershipId: context.members.find(member => member.userId === start.actor.id && member.status === "active")?.id ?? "" }));
    const validator = conditional && complete && !projectionOnly && state.nextInvalidationAt && state.scopes.every(scope => !scope.failed)
      ? await validation.issue(validationFingerprint, { actorId: state.actorId, revision: state.revision, families, asOf: state.asOf, expiresAt: state.expiresAt, nextInvalidationAt: state.nextInvalidationAt }) : undefined;
    const base = { items, complete, nextCursor, asOf: state.asOf, ...(conditional ? { serverTime: this.clock.now().toISOString(), ...(validator ? { cache: validator } : {}) } : {}) };
    const result = action === "occurrence.list" ? base : { ...base, scopes: state.scopes.map(s => ({ familyId: s.familyId, status: s.failed ? "failed" : complete ? "ok" : "partial", ...(s.failed ? { errorCode: "TEMPORARILY_UNAVAILABLE" } : {}) })), summary: complete && state.scopes.every(s => !s.failed) ? state.summary : null };
    if (projectionOnly) {
      if (!isPersonalData("occurrence.list", base)) throw new Error("Invalid internal projection page.");
      return { ...base, failed: state.scopes.some(scope => scope.failed) };
    }
    if (!isPersonalData(action, result)) throw new Error("Invalid occurrence list result."); return result;
  }
  public async occurrences(payload: PersonalActionMap["occurrence.list"]["payload"]) { return this.execute("occurrence.list", payload); }
}
