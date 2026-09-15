import { instant, integer, isPersonalData, isPersonalPayload, isRecord, isUuid } from "@family-todo/contracts";
import type { PersonalActionMap, Summary, TaskDTO } from "@family-todo/contracts";
import { familyTaskRights, occurrenceSlot, scheduledInstant, shanghaiDate } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext } from "@family-todo/domain";
import type { Clock, FamilyStore, PersonalQuery } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { taskDTO as personalTaskDTO } from "./personal";
import { familyTaskDTO, occurrenceDTO, taskContext, taskMissing, verifyContext } from "./task-context";
import { nextProjected, overlayOccurrence, projectedDTO } from "./recurrence-projection";

type ListAction = "task.list" | "task.recycleList" | "reminder.list";
type Stream = { familyId: string | null; version: number; after: string | null; headId: string | null; done: boolean; failed: boolean };
type Checkpoint = { actorId: string; fingerprint: string; asOf: string; expiresAt: string; userRevision: number; streams: Stream[]; summary: Summary };
function expired(): never { throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。"); }
function nullableString(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function stream(v: unknown): v is Stream { return isRecord(v) && (v.familyId === null || isUuid(v.familyId)) && integer(v.version, 1) && nullableString(v.after) && (v.headId === null || isUuid(v.headId)) && typeof v.done === "boolean" && typeof v.failed === "boolean"; }
function readCheckpoint(v: unknown): Checkpoint {
  if (!isRecord(v) || !isUuid(v.actorId) || typeof v.fingerprint !== "string" || !instant(v.asOf) || !instant(v.expiresAt) || !integer(v.userRevision, 1)
    || !Array.isArray(v.streams) || v.streams.length > 11 || !v.streams.every(stream) || !isRecord(v.summary)) expired();
  const s = v.summary; if (!integer(s.completed) || !integer(s.pending) || !integer(s.skipped) || !integer(s.denominator)) expired();
  if (new Set(v.streams.map(s => s.familyId)).size !== v.streams.length) expired();
  return { actorId: v.actorId, fingerprint: v.fingerprint, asOf: v.asOf, expiresAt: v.expiresAt, userRevision: v.userRevision, streams: v.streams,
    summary: { completed: s.completed, pending: s.pending, skipped: s.skipped, denominator: s.denominator } };
}
function order(task: CollaborativeTask, query: PersonalQuery): string {
  if (query.mode === "recycle" || query.unscheduled) return `${String(9999999999999 - Date.parse(task.createdAt)).padStart(13, "0")}/${task.id}`;
  const date = task.date ?? "9999-12-31"; const base = `${date}/${task.time ?? "99:99"}/${task.id}`;
  if (query.mode === "reminders" || query.overdueBefore) return `${String(999999 - Math.floor(Date.parse(date) / 86400000 / 31)).padStart(6, "0")}/${base}`;
  return base;
}

export class CollaborativeLists {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock) {}
  public async execute(action: ListAction, payload: unknown): Promise<unknown> {
    if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查列表筛选条件。");
    const now = this.clock.now().toISOString(); const today = shanghaiDate(new Date(now));
    let query: PersonalQuery; let requestedFamily: string | null | undefined; let limit = 20; let cursor: string | undefined;
    if (action === "task.list" && isPersonalPayload(action, payload)) {
      query = { mode: "tasks", ...(payload.status ? { status: payload.status } : {}), ...(payload.overdue ? { overdueBefore: today, status: "pending" } : payload.unscheduled ? { unscheduled: true } : { dateFrom: payload.dateFrom ?? today, dateTo: payload.dateTo ?? today }) };
      requestedFamily = payload.familyId; limit = payload.limit ?? 20; cursor = payload.cursor;
    } else if (action === "task.recycleList" && isPersonalPayload(action, payload)) {
      query = { mode: "recycle" }; requestedFamily = payload.familyId; limit = payload.limit ?? 20; cursor = payload.cursor;
    } else if (action === "reminder.list" && isPersonalPayload(action, payload)) {
      query = { mode: "reminders", includeDismissed: payload.includeDismissed ?? false }; limit = payload.limit ?? 20; cursor = payload.cursor;
    } else throw new Error("Invalid list action.");
    const start = await this.store.transaction(async tx => { const actor = await tx.actor(); return { actor, scope: await tx.scope(actor.id) }; });
    const families = requestedFamily === null ? [] : await this.store.families(start.actor.id);
    if (requestedFamily && !families.some(family => family.id === requestedFamily)) taskMissing();
    const selected = requestedFamily ? families.filter(family => family.id === requestedFamily) : families;
    const streams: Stream[] = requestedFamily === undefined || requestedFamily === null ? [{ familyId: null, version: start.scope.revision, after: null, headId: null, done: false, failed: false }] : [];
    const contexts = new Map<string, FamilyContext>();
    for (const family of selected) {
      let context: FamilyContext | null = null;
      try { context = await this.store.context(family.id); } catch { /* A verified family may fail independently; expose a stable scope failure only. */ }
      if (context && !context.members.some(member => member.userId === start.actor.id && member.status === "active")) expired();
      if (context) contexts.set(family.id, context);
      streams.push({ familyId: family.id, version: context?.family.version ?? family.version, after: null, headId: null, done: !context, failed: !context });
    }
    const fingerprint = this.store.fingerprint({ action, payload: { ...payload, cursor: undefined } });
    let checkpoint: Checkpoint = { actorId: start.actor.id, fingerprint, asOf: now, expiresAt: new Date(Date.parse(now) + 15 * 60000).toISOString(), userRevision: start.scope.revision, streams, summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } };
    if (cursor) {
      checkpoint = readCheckpoint(await this.store.readSession(cursor));
      if (checkpoint.actorId !== start.actor.id || checkpoint.fingerprint !== fingerprint || checkpoint.userRevision !== start.scope.revision || checkpoint.expiresAt <= now
        || checkpoint.streams.length !== streams.length || checkpoint.streams.some(saved => !streams.some(current => current.familyId === saved.familyId && current.version === saved.version && current.failed === saved.failed))) expired();
    }
    if (action === "task.recycleList" && checkpoint.streams.some(scope => scope.failed)) {
      throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "部分家庭暂时无法加载，请稍后重试。", true);
    }
    // A continuation keeps the original Shanghai day even when the next request crosses midnight.
    if (action === "task.list" && isPersonalPayload(action, payload)) {
      const snapshotDay = shanghaiDate(new Date(checkpoint.asOf));
      if (payload.overdue) query.overdueBefore = snapshotDay;
      else if (!payload.unscheduled) {
        query.dateFrom = payload.dateFrom ?? snapshotDay;
        query.dateTo = payload.dateTo ?? snapshotDay;
      }
    }
    const cache = new Map<string, { task: CollaborativeTask; context: FamilyContext | null }>();
    async function unavailable(): Promise<never> { throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "部分家庭暂时无法加载，请稍后重试。", true); }
    const prepare = async (task: CollaborativeTask, scope: Stream) => {
      if (query.unscheduled && task.recurrence && (task.recurrence.schedule.kind !== "once" || task.recurrence.schedule.date !== null)) return false;
      if (scope.familyId === null) {
        if (task.collaboration || task.ownerUserId !== start.actor.id) taskMissing();
        if (query.mode === "reminders" && (!task.reminderEnabled || task.reminderSelfDisabled || (!query.includeDismissed && task.dismissedAt !== null))) return false;
        cache.set(task.id, { task, context: null }); return true;
      }
      if (task.collaboration?.familyId !== scope.familyId) taskMissing();
      const context = await taskContext(this.store, task, contexts.get(scope.familyId));
      if (context.family.version !== scope.version) expired();
      const rights = familyTaskRights(task, context, start.actor.id);
      if (!rights.canView || (query.mode === "recycle" && !rights.manager)) return false;
      if (query.mode === "reminders") {
        const allowed = await this.store.transaction(async tx => {
          await verifyContext(tx, context, start.actor.id);
          const preference = await tx.preference(task.id, start.actor.id); const receipt = await tx.reminderReceipt(task.occurrenceId, start.actor.id);
          return Boolean(preference?.enabled && !preference.selfDisabled && preference.membershipId === rights.actor?.id && (query.includeDismissed || !receipt?.dismissedAt));
        });
        if (!allowed) return false;
      }
      cache.set(task.id, { task, context }); return true;
    };
    for (const scope of checkpoint.streams) {
      if (scope.headId) {
        const task = await this.store.readTask(scope.headId); if (!task || !await prepare(task, scope)) expired();
      }
    }
    const items: unknown[] = []; let candidateReads = 0;
    while (items.length < limit) {
      let ready = true;
      for (const scope of checkpoint.streams) {
        while (!scope.headId && !scope.done) {
          // Each one-row stream fetch may read one lookahead row as well.
          if (candidateReads + 2 > 200 || this.store.remainingBudgetMs() <= 4000) { ready = false; break; }
          const page = await this.store.scanTasks(start.actor.id, scope.familyId, query, checkpoint.asOf, scope.after, 1); candidateReads += 2;
          scope.after = page.after; scope.done = !page.more;
          const task = page.items[0]; if (task && await prepare(task, scope)) scope.headId = task.id;
        }
      }
      if (!ready) break;
      const heads = checkpoint.streams.filter(scope => scope.headId !== null);
      if (!heads.length) break;
      heads.sort((left, right) => {
        const l = left.headId ? cache.get(left.headId)?.task : null; const r = right.headId ? cache.get(right.headId)?.task : null;
        if (!l || !r) throw new Error("Missing sorted stream head."); return order(l, query).localeCompare(order(r, query));
      });
      const chosen = heads[0]; const entry = chosen?.headId ? cache.get(chosen.headId) : null; if (!chosen || !entry) return unavailable();
      const { task, context } = entry; let dto: TaskDTO;
      if (context) dto = await this.store.transaction(async tx => { await verifyContext(tx, context, start.actor.id); return familyTaskDTO(tx, task, context, start.actor.id); });
      else dto = personalTaskDTO(task);
      if (action === "task.list") {
        let occurrence = occurrenceDTO(task, dto.capabilities.canRecord);
        if (task.recurrence) {
          const segment = await this.store.readSegment(task.recurrence.currentSegmentId);
          if (!segment || segment.taskId !== task.id) expired();
          const candidate = nextProjected(task, segment, checkpoint.asOf, 1)[0];
          const projected = candidate ? await overlayOccurrence(this.store, task, candidate) : null;
          if (!projected) expired();
          occurrence = projectedDTO(this.store, task, context, start.actor.id, projected);
        }
        items.push({ task: dto, occurrence });
      }
      else if (action === "task.recycleList") items.push(dto);
      else {
        const receipt = context ? await this.store.transaction(tx => tx.reminderReceipt(task.occurrenceId, start.actor.id)) : { readAt: task.readAt, dismissedAt: task.dismissedAt };
        items.push({ occurrence: { id: task.occurrenceId, taskId: task.id, segmentId: task.segmentId, localDate: task.date, slot: occurrenceSlot(task) }, title: task.title, familyId: dto.familyId, familyName: dto.familyName, subjectName: dto.subjectName, scheduledAt: scheduledInstant(task), readAt: receipt?.readAt ?? null, dismissedAt: receipt?.dismissedAt ?? null });
      }
      checkpoint.summary[task.status]++; if (task.status !== "skipped") checkpoint.summary.denominator++;
      cache.delete(task.id); chosen.headId = null;
    }
    await this.store.transaction(async tx => {
      const actor = await tx.actor(); if (actor.id !== checkpoint.actorId) taskMissing();
      if ((await tx.scope(actor.id)).revision !== checkpoint.userRevision) expired();
      for (const scope of checkpoint.streams) {
        if (scope.familyId === null || scope.failed) continue;
        const family = await tx.family(scope.familyId); const slot = await tx.slot(scope.familyId, actor.id);
        if (!family || !slot?.activeMembershipId || family.version !== scope.version) expired();
      }
    });
    const complete = checkpoint.streams.every(scope => scope.done && !scope.headId);
    const nextCursor = complete ? null : await this.store.saveSession({ ...checkpoint });
    const base = { items, complete, nextCursor, asOf: checkpoint.asOf };
    const result = action === "task.recycleList" ? base : { ...base, scopes: checkpoint.streams.map(scope => ({ familyId: scope.familyId, status: scope.failed ? "failed" : scope.done && !scope.headId ? "ok" : "partial", ...(scope.failed ? { errorCode: "TEMPORARILY_UNAVAILABLE" } : {}) })), summary: complete && checkpoint.streams.every(scope => !scope.failed) ? checkpoint.summary : null };
    if (!isPersonalData(action, result)) throw new Error("Invalid collaborative list result."); return result;
  }
  public async history(payload: PersonalActionMap["task.history"]["payload"], context: FamilyContext | null): Promise<unknown> {
    const now = this.clock.now().toISOString();
    const actor = await this.store.transaction(async tx => {
      const user = await tx.actor(); if (context) await verifyContext(tx, context, user.id); const task = await tx.task(payload.taskId);
      if (!task || task.lifecycle === "deleted" || (context ? !familyTaskRights(task, context, user.id).canView : Boolean(task.collaboration) || task.ownerUserId !== user.id)) taskMissing(); return { ...user, revision: (await tx.scope(user.id)).revision };
    });
    const fingerprint = this.store.fingerprint({ action: "task.history", payload: { ...payload, cursor: undefined } });
    let after: string | null = null; let asOf = now; let expiresAt = new Date(Date.parse(now) + 15 * 60000).toISOString();
    if (payload.cursor) {
      const saved = await this.store.readSession(payload.cursor);
      if (!saved || saved.actorId !== actor.id || saved.fingerprint !== fingerprint || saved.familyVersion !== (context?.family.version ?? null) || saved.familyId !== (context?.family.id ?? null) || saved.revision !== actor.revision || !instant(saved.asOf) || !instant(saved.expiresAt) || saved.expiresAt <= now || !nullableString(saved.after)) expired();
      after = saved.after; asOf = saved.asOf; expiresAt = saved.expiresAt;
    }
    const page = await this.store.events(payload.taskId, after, payload.limit ?? 20);
    await this.store.transaction(async tx => { if (context) await verifyContext(tx, context, actor.id); if ((await tx.scope(actor.id)).revision !== actor.revision) expired(); });
    const nextCursor = page.more ? await this.store.saveSession({ actorId: actor.id, fingerprint, familyVersion: context?.family.version ?? null, familyId: context?.family.id ?? null, revision: actor.revision, after: page.after, asOf, expiresAt }) : null;
    return { items: page.items, nextCursor, complete: !page.more, asOf };
  }
}
