import { instant, integer, isOccurrenceDTO, isPersonalData, isPersonalPayload, isRecord, isUuid, localDate } from "@family-todo/contracts";
import type { OccurrenceDTO, PersonalActionMap, ResolvedSubject, Summary, TaskDTO } from "@family-todo/contracts";
import { addDays, familyTaskRights, localDateAt, projectOccurrences } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext, PersistedScheduleSegment } from "@family-todo/domain";
import type { Clock, FamilyStore } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { taskDTO } from "./personal";
import { familyTaskDTO, taskContext, taskMissing, verifyContext } from "./task-context";
import { legacySegment, overlayOccurrence, projectedDTO, projectionTask } from "./recurrence-projection";

type ListAction = "task.list" | "reminder.list" | "occurrence.list";
type Scope = { familyId: string | null; version: number; failed: boolean };
type Head = { order: string; occurrence: OccurrenceDTO };
// Persist only unconsumed IDs alongside the batch cursor; entities stay request-local.
const scanBatchSize = 20;
type Scan = { taskIds: string[]; segmentIds: string[]; scope: number; taskAfter: string | null; taskId: string | null; tasksDone: boolean; segmentAfter: string | null; segmentId: string | null; segmentsDone: boolean; slot: number };
type State = { actorId: string; fingerprint: string; asOf: string; expiresAt: string; revision: number; scopes: Scope[]; from: string; to: string; oldest: string; afterOrder: string | null; top: Head[]; trimmed: boolean; scan: Scan; summary: Summary };
function expired(): never { throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。"); }
function nullableString(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function emptyScan(): Scan { return { taskIds: [], segmentIds: [], scope: 0, taskAfter: null, taskId: null, tasksDone: false, segmentAfter: null, segmentId: null, segmentsDone: false, slot: 0 }; }
function pendingIds(v: unknown): string[] {
  if (v === undefined) return []; // Sessions created before batched scanning.
  if (!Array.isArray(v) || v.length > scanBatchSize || !v.every(isUuid)) expired();
  return v;
}
function readState(v: unknown): State {
  if (!isRecord(v) || !isUuid(v.actorId) || typeof v.fingerprint !== "string" || !instant(v.asOf) || !instant(v.expiresAt) || !integer(v.revision, 1)
    || !localDate(v.from) || !localDate(v.to) || !localDate(v.oldest) || !nullableString(v.afterOrder)
    || typeof v.trimmed !== "boolean" || !Array.isArray(v.scopes) || v.scopes.length > 11 || !Array.isArray(v.top) || v.top.length > 51 || !isRecord(v.scan) || !isRecord(v.summary)) expired();
  const scopes: Scope[] = [];
  for (const s of v.scopes) { if (!isRecord(s) || !(s.familyId === null || isUuid(s.familyId)) || !integer(s.version, 1) || typeof s.failed !== "boolean") expired(); scopes.push({ familyId: s.familyId, version: s.version, failed: s.failed }); }
  const top: Head[] = [];
  for (const h of v.top) { if (!isRecord(h) || typeof h.order !== "string" || !isOccurrenceDTO(h.occurrence)) expired(); top.push({ order: h.order, occurrence: h.occurrence }); }
  const s = v.scan, total = v.summary;
  if (!integer(s.scope) || s.scope > scopes.length || !nullableString(s.taskAfter) || !(s.taskId === null || isUuid(s.taskId)) || typeof s.tasksDone !== "boolean"
    || !nullableString(s.segmentAfter) || !(s.segmentId === null || isUuid(s.segmentId)) || typeof s.segmentsDone !== "boolean" || !integer(s.slot) || s.slot > 186
    || !integer(total.completed) || !integer(total.pending) || !integer(total.skipped) || !integer(total.denominator)) expired();
  return { actorId: v.actorId, fingerprint: v.fingerprint, asOf: v.asOf, expiresAt: v.expiresAt, revision: v.revision, scopes, from: v.from, to: v.to, oldest: v.oldest, afterOrder: v.afterOrder, top, trimmed: v.trimmed,
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
  public async execute(action: ListAction, payload: unknown, subject?: ResolvedSubject): Promise<unknown> {
    if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查列表筛选条件。");
    const now = this.clock.now().toISOString(); const today = localDateAt(now);
    let familyId: string | null | undefined; let taskId: string | undefined; let dateFrom = today; let dateTo = today; let overdue = false; let status: "pending" | "completed" | "skipped" | undefined;
    if (action === "task.list" && isPersonalPayload(action, payload)) { familyId = payload.familyId; dateFrom = payload.dateFrom ?? today; dateTo = payload.dateTo ?? today; overdue = payload.overdue ?? false; status = payload.status; }
    if (action === "occurrence.list" && isPersonalPayload(action, payload)) { taskId = payload.taskId; dateFrom = payload.dateFrom; dateTo = payload.dateTo; }
    const backlog = overdue || action === "reminder.list"; const includeDismissed = action === "reminder.list" && isPersonalPayload(action, payload) && payload.includeDismissed;
    const limit = payload.limit ?? 20;
    const start = await this.store.transaction(async tx => { const actor = await tx.actor(); return { actor, scope: await tx.scope(actor.id) }; });
    const target = taskId ? await this.store.readTask(taskId) : null;
    if (taskId) { if (!target || target.lifecycle === "deleted") taskMissing(); familyId = target.collaboration?.familyId ?? null; }
    const families = familyId === null ? [] : await this.store.families(start.actor.id);
    if (familyId && !families.some(f => f.id === familyId)) taskMissing();
    const selected = familyId ? families.filter(f => f.id === familyId) : families;
    const scopes: Scope[] = familyId === undefined || familyId === null ? [{ familyId: null, version: start.scope.revision, failed: false }] : [];
    const contexts = new Map<string, FamilyContext>();
    for (const family of selected) {
      let context: FamilyContext | null = null;
      try { context = await this.store.context(family.id); } catch { /* Report independent family failure without leaking its cause. */ }
      if (context && !context.members.some(m => m.userId === start.actor.id && m.status === "active")) expired();
      if (context) contexts.set(family.id, context);
      scopes.push({ familyId: family.id, version: context?.family.version ?? family.version, failed: !context });
    }
    if (taskId && scopes.some(s => s.failed)) throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "家庭暂时无法加载，请稍后重试。", true);
    const fingerprint = this.store.fingerprint({ action, payload: { ...payload, cursor: undefined }, subject });
    const to = backlog ? (overdue ? older(today, 1) : today) : dateTo;
    let state: State = { actorId: start.actor.id, fingerprint, asOf: now, expiresAt: new Date(Date.parse(now) + 900000).toISOString(), revision: start.scope.revision, scopes,
      from: backlog ? older(to, 30) : dateFrom, to, oldest: to, afterOrder: null, top: [], trimmed: false, scan: emptyScan(), summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } };
    if (payload.cursor) {
      state = readState(await this.store.readSession(payload.cursor));
      if (state.actorId !== start.actor.id || state.fingerprint !== fingerprint || state.revision !== start.scope.revision || state.expiresAt <= now
        || state.scopes.length !== scopes.length || state.scopes.some(s => !scopes.some(current => current.familyId === s.familyId && current.version === s.version && current.failed === s.failed))) expired();
    }
    const cache = new Map<string, { task: CollaborativeTask; context: FamilyContext | null }>();
    const prepare = async (task: CollaborativeTask, scope: Scope) => {
      if (task.lifecycle === "deleted" || task.createdAt > state.asOf) return null;
      let context: FamilyContext | null = null;
      if (scope.familyId) { if (task.collaboration?.familyId !== scope.familyId) return null; context = await taskContext(this.store, task, contexts.get(scope.familyId)); if (context.family.version !== scope.version) expired(); if (!familyTaskRights(task, context, start.actor.id).canView) return null; }
      else if (task.collaboration || task.ownerUserId !== start.actor.id) return null;
      const entry = { task, context }; cache.set(task.id, entry); return entry;
    };
    if (target && !await prepare(target, scopes[0] ?? expired())) taskMissing();
    const prefetchedTasks = new Map<string, CollaborativeTask>();
    const segments = new Map<string, PersistedScheduleSegment>();
    let work = 0;
    // Retain only the smallest limit+1 candidates. No ordering claim is made until every stream in this window is scanned.
    while (state.scan.scope < state.scopes.length && work < 180 && this.store.remainingBudgetMs() > 4000) {
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
      if (!scan.segmentId && scan.segmentsDone && scan.segmentIds.length === 0) { scan.taskId = null; continue; }
      let segment: PersistedScheduleSegment | null;
      if (!scan.segmentId) {
        if (scan.segmentIds.length === 0) {
          const page = task.recurrence ? await this.store.segments(task.id, scan.segmentAfter, scanBatchSize) : { items: [legacySegment(task)], after: null, more: false };
          work += 2; scan.segmentAfter = page.after; scan.segmentsDone = !page.more;
          scan.segmentIds = page.items.map(segment => segment.id);
          for (const segment of page.items) segments.set(segment.id, segment);
        }
        const id = scan.segmentIds.shift(); if (!id) continue;
        segment = segments.get(id) ?? (task.recurrence ? await this.store.readSegment(id) : legacySegment(task));
        scan.segmentId = id; scan.slot = 0;
      } else { segment = segments.get(scan.segmentId) ?? (task.recurrence ? await this.store.readSegment(scan.segmentId) : legacySegment(task)); work++; }
      if (!segment || segment.taskId !== task.id) expired();
      let index = 0, exhausted = true;
      for (const candidate of projectOccurrences({ task: projectionTask(task), segments: [segment], controls: [], dateFrom: state.from, dateTo: state.to, now: state.asOf })) {
        if (index++ < scan.slot) continue;
        if (work + 4 > 180 || this.store.remainingBudgetMs() <= 4000) { exhausted = false; break; }
        scan.slot = index; work += 4;
        if (candidate.localDate === null) continue;
        const overlaid = await overlayOccurrence(this.store, task, candidate); if (!overlaid) continue;
        const occurrence = projectedDTO(this.store, task, entry.context, start.actor.id, overlaid);
        if (subject && this.store.fingerprint(subject) !== this.store.fingerprint(occurrence.subject)) continue;
        if ((backlog && occurrence.status !== "pending") || (status && occurrence.status !== status)) continue;
        if (action === "reminder.list") {
          if (!occurrence.scheduledAt || occurrence.scheduledAt > state.asOf) continue;
          const allowed = await this.store.transaction(async tx => {
            if (entry.context) {
              await verifyContext(tx, entry.context, start.actor.id);
              const rights = familyTaskRights(task, entry.context, start.actor.id); const pref = await tx.preference(task.id, start.actor.id);
              if (!pref?.enabled || pref.selfDisabled || pref.membershipId !== rights.actor?.id) return false;
            } else if (!task.reminderEnabled || task.reminderSelfDisabled) return false;
            const receipt = !task.recurrence && !entry.context ? task : await tx.reminderReceipt(occurrence.id, start.actor.id);
            return Boolean(includeDismissed || !receipt?.dismissedAt);
          });
          if (!allowed) continue;
        }
        const order = occurrenceOrder(occurrence); if (state.afterOrder && order <= state.afterOrder) continue;
        state.top.push({ order, occurrence }); state.top.sort((a, b) => a.order.localeCompare(b.order));
        if (state.top.length > limit + 1) { state.top.pop(); state.trimmed = true; }
      }
      if (exhausted) { segments.delete(segment.id); scan.segmentId = null; scan.slot = 0; }
    }
    const scanned = state.scan.scope === state.scopes.length;
    const heads = scanned ? state.top.slice(0, limit) : [];
    const items: unknown[] = []; const renderedTasks = new Map<string, TaskDTO>();
    for (const head of heads) {
      if (this.store.remainingBudgetMs() <= 4000) break;
      const task = cache.get(head.occurrence.taskId)?.task ?? await this.store.readTask(head.occurrence.taskId); if (!task) expired();
      const scope = state.scopes.find(s => s.familyId === (task.collaboration?.familyId ?? null)); if (!scope) expired();
      const entry = cache.get(task.id) ?? await prepare(task, scope); if (!entry) expired();
      if (action === "occurrence.list") items.push(head.occurrence);
      else {
        const dto: TaskDTO = renderedTasks.get(task.id) ?? (entry.context ? await this.store.transaction(async tx => { if (!entry.context) expired(); await verifyContext(tx, entry.context, start.actor.id); return familyTaskDTO(tx, task, entry.context, start.actor.id); }) : taskDTO(task)); renderedTasks.set(task.id, dto);
        if (action === "task.list") items.push({ task: dto, occurrence: head.occurrence });
        else {
          const receipt = !task.recurrence && !entry.context ? task : await this.store.transaction(tx => tx.reminderReceipt(head.occurrence.id, start.actor.id));
          const o = head.occurrence; items.push({ occurrence: { id: o.id, taskId: o.taskId, segmentId: o.segmentId, localDate: o.localDate, slot: o.slot }, title: dto.title, familyId: dto.familyId, familyName: dto.familyName, subjectName: o.subjectName, scheduledAt: o.scheduledAt, readAt: receipt?.readAt ?? null, dismissedAt: receipt?.dismissedAt ?? null });
        }
      }
      state.afterOrder = head.order;
      state.summary[head.occurrence.status]++; if (head.occurrence.status !== "skipped") state.summary.denominator++;
    }
    let complete = false;
    if (scanned) {
      state.top = state.top.slice(items.length);
      if (state.top.length > 0) { /* Retain hydrated-page remainder under the same completed window scan. */ }
      else if (state.trimmed) { state.trimmed = false; state.scan = emptyScan(); }
      else if (backlog && state.from > state.oldest && state.from > "2000-01-01") { state.to = older(state.from, 1); state.from = older(state.to, 30); state.afterOrder = null; state.scan = emptyScan(); }
      else complete = true;
    }
    await this.store.transaction(async tx => {
      const actor = await tx.actor(); if (actor.id !== state.actorId || (await tx.scope(actor.id)).revision !== state.revision) expired();
      for (const scope of state.scopes) { if (!scope.familyId || scope.failed) continue; const family = await tx.family(scope.familyId); const slot = await tx.slot(scope.familyId, actor.id); if (!family || family.version !== scope.version || !slot?.activeMembershipId) expired(); }
    });
    const nextCursor = complete ? null : await this.store.saveSession({ ...state });
    const base = { items, complete, nextCursor, asOf: state.asOf };
    const result = action === "occurrence.list" ? base : { ...base, scopes: state.scopes.map(s => ({ familyId: s.familyId, status: s.failed ? "failed" : complete ? "ok" : "partial", ...(s.failed ? { errorCode: "TEMPORARILY_UNAVAILABLE" } : {}) })), summary: complete && state.scopes.every(s => !s.failed) ? state.summary : null };
    if (!isPersonalData(action, result)) throw new Error("Invalid occurrence list result."); return result;
  }
  public async occurrences(payload: PersonalActionMap["occurrence.list"]["payload"]) { return this.execute("occurrence.list", payload); }
}
