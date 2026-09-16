import { isPersonalData, isPersonalPayload, PERSONAL_ACTIONS } from "@family-todo/contracts";
import type { OccurrenceDTO, OccurrenceRef, PersonalAction, PersonalActionMap, TaskSummaryDTO, TaskDTO } from "@family-todo/contracts";
import { occurrenceSlot, reminderDue, scheduledInstant, shanghaiDate } from "@family-todo/domain";
import type { PersonalTask, User } from "@family-todo/domain";
import type { Clock, PersonalQuery, PersonalStore, PersonalTransaction, QueryCheckpoint, UuidGenerator } from "@family-todo/ports";

import { ApplicationError } from "./errors";
import type { ActionHandler, ActionRouter } from "./router";

function missing(): never { throw new ApplicationError("NOT_FOUND", "事项不存在或你已无权查看。"); }
function invalid(message: string): never { throw new ApplicationError("INVALID_STATE", message); }
function version(actual: number, expected: number): void { if (actual !== expected) throw new ApplicationError("VERSION_CONFLICT", "事项已更新，请刷新后重试。草稿会为你保留。"); }
function occurrence(task: PersonalTask): OccurrenceDTO {
  return { id: task.occurrenceId, taskId: task.id, segmentId: task.segmentId, localDate: task.date, slot: occurrenceSlot(task),
    subject: { kind: "user", userId: task.ownerUserId }, subjectName: task.ownerName, version: task.occurrenceVersion,
    time: task.time, scheduledAt: scheduledInstant(task), status: task.status, actualCompletedAt: task.actualCompletedAt,
    recordedAt: task.recordedAt, operatorName: task.operatorName, canRecord: task.lifecycle === "active" };
}
export function personalTaskSummary(task: Omit<PersonalTask, "note">): TaskSummaryDTO {
  const active = task.lifecycle !== "deleted";
  return { id: task.id, version: task.version, title: task.title, familyId: null, familyName: null,
    ownerUserId: task.ownerUserId, ownerName: task.ownerName, createdByUserId: task.ownerUserId,
    subject: { kind: "user", userId: task.ownerUserId }, subjectName: task.ownerName,
    schedule: task.recurrence?.schedule ?? { kind: "once", date: task.date, time: task.time }, lifecycle: task.lifecycle,
    capabilities: { canEdit: active, canRecord: active, canShare: active, canDelete: active, canRestore: !active, canResume: task.lifecycle === "paused" && !task.recurrence?.stopped } };
}
export function taskDTO(task: PersonalTask): TaskDTO {
  return { ...personalTaskSummary(task), note: task.note, participants: [], createdAt: task.createdAt, updatedAt: task.updatedAt,
    myReminder: { enabled: task.reminderEnabled, selfDisabled: task.reminderSelfDisabled, version: task.reminderVersion } };
}
function checkRef(task: PersonalTask, ref: OccurrenceRef): void {
  if (ref.id !== task.occurrenceId || ref.taskId !== task.id || ref.segmentId !== task.segmentId || ref.localDate !== task.date || ref.slot !== occurrenceSlot(task)) missing();
}
async function owned(tx: PersonalTransaction, id: string, actor: User, deleted = false): Promise<PersonalTask> {
  const task = await tx.task(id);
  if (!task || task.ownerUserId !== actor.id || (!deleted && task.lifecycle !== "active")) missing();
  return task;
}
const READS = new Set<PersonalAction>(["task.get", "task.list", "task.recycleList", "task.history", "reminder.list"]);

export class PersonalService {
  public constructor(private readonly store: PersonalStore, private readonly clock: Clock, private readonly uuids: UuidGenerator) {}

  public async execute(action: PersonalAction, payload: unknown, requestId: string): Promise<unknown> {
    if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查事项内容、日期和参数。当前支持个人一次性事项。");
    // This legacy service remains deliberately personal-only; family actions use the collaboration service.
    if ("draft" in payload && payload.draft.familyId !== null) throw new ApplicationError("VALIDATION_ERROR", "家庭事项需要通过协作服务处理。");
    const now = this.clock.now().toISOString();
    let result: unknown;
    if (action === "task.get" && isPersonalPayload(action,payload)) {
      result = await this.store.transaction(async tx => {
        const actor = await tx.actor(); const task = await owned(tx,payload.id,actor);
        if (payload.occurrence) checkRef(task,payload.occurrence);
        return { task: taskDTO(task), occurrence: occurrence(task) };
      });
    } else if (READS.has(action)) result = await this.list(action,payload,now);
    else result = await this.write(action,payload,requestId,now);
    if (!isPersonalData(action,result)) throw new Error("Invalid personal action result.");
    return result;
  }

  private async write(action: PersonalAction, payload: unknown, requestId: string, now: string): Promise<unknown> {
    const fingerprint = this.store.fingerprint({action,payload});
    // 固定候选 ID，SDK 的事务重跑不改变一次逻辑操作的标识。
    const taskId = this.uuids.generate(); const segmentId = this.uuids.generate(); const occurrenceId = this.uuids.generate(); const eventId = this.uuids.generate();
    return this.store.transaction(async tx => {
      const actor = await tx.actor();
      const previous = await tx.receipt(actor.id,requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作，请重新发起。");
        await owned(tx,previous.taskId,actor,true);
        return previous.result;
      }
      const scope = await tx.scope(actor.id);
      let task: PersonalTask; let result: unknown; let kind = ""; let eventNote = "";
      if (action === "task.create" && isPersonalPayload(action,payload)) {
        if (scope.personalTaskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "个人事项已达 500 条，请先整理。");
        if (await tx.task(taskId)) throw new Error("Task identifier collision.");
        const draft = payload.draft; if (draft.schedule.kind !== "once") invalid("周期事项需要通过日程服务处理。");
        task = { id: taskId, ownerUserId: actor.id, ownerName: actor.displayName, title: draft.title.trim(), note: draft.note,
          version: 1, segmentId, occurrenceId, date: draft.schedule.date, time: draft.schedule.time, lifecycle: "active",
          status: "pending", occurrenceVersion: 0, actualCompletedAt: null, recordedAt: null, operatorName: null,
          reminderEnabled: draft.access.remindMe, reminderSelfDisabled: !draft.access.remindMe, reminderVersion: 1,
          readAt: null, dismissedAt: null, createdAt: now, updatedAt: now };
        scope.personalTaskCount++; kind = "task.created";
        result = {task:taskDTO(task),nextOccurrences:[occurrence(task)]};
      } else if (action === "task.update" && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.id,actor); version(task.version,payload.expectedVersion);
        const draft = payload.draft; if (draft.schedule.kind !== "once") invalid("周期事项需要通过日程服务处理。"); const scheduleChanged = task.date !== draft.schedule.date || task.time !== draft.schedule.time;
        if (scheduleChanged && task.status !== "pending") invalid("请先撤销完成或跳过记录，再修改日期时间。");
        task.title = draft.title.trim(); task.note = draft.note;
        if (scheduleChanged) { task.date = draft.schedule.date; task.time = draft.schedule.time; task.segmentId = segmentId; task.occurrenceId = occurrenceId; task.occurrenceVersion = 0; task.readAt = null; task.dismissedAt = null; }
        if (task.reminderEnabled !== draft.access.remindMe) { task.reminderEnabled = draft.access.remindMe; task.reminderSelfDisabled = !draft.access.remindMe; task.reminderVersion++; }
        task.version++; task.updatedAt = now; kind = "task.updated";
        result = {task:taskDTO(task),nextOccurrences:[occurrence(task)]};
      } else if (action === "task.setAccess" && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.id,actor); version(task.version,payload.expectedVersion);
        if (payload.access.viewerMembershipIds.length || payload.access.helperMembershipIds.length || payload.access.reminderMembershipIds.length) invalid("请先将事项归属家庭，再选择共享成员。");
        if (task.reminderEnabled !== payload.access.remindMe) { task.reminderEnabled = payload.access.remindMe; task.reminderSelfDisabled = !payload.access.remindMe; task.reminderVersion++; }
        task.version++; task.updatedAt = now; kind = "task.accessChanged"; result = {task:taskDTO(task)};
      } else if ((action === "task.delete" || action === "task.restore") && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.id,actor,true); version(task.version,payload.expectedVersion);
        if (action === "task.delete") { if (task.lifecycle !== "active") invalid("事项已在回收站。"); task.lifecycle = "deleted"; scope.personalTaskCount--; kind = "task.deleted"; }
        else { if (task.lifecycle !== "deleted") invalid("事项已恢复。"); if (scope.personalTaskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "个人事项已达 500 条，请先整理。"); task.lifecycle = "active"; scope.personalTaskCount++; kind = "task.restored"; }
        task.version++; task.updatedAt = now;
        result = action === "task.delete" ? {id:task.id,version:task.version,deleted:true} : {task:taskDTO(task),removedParticipantCount:0};
      } else if (action === "occurrence.record" && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.occurrence.taskId,actor); checkRef(task,payload.occurrence); version(task.occurrenceVersion,payload.expectedVersion);
        if (task.status !== "pending") invalid("该次已有记录，请先撤销。");
        const actual = payload.status === "completed" ? payload.actualCompletedAt ?? now : null;
        if (actual !== null && actual > now) invalid("实际完成时间不能晚于现在。");
        task.status = payload.status; task.actualCompletedAt = actual; task.recordedAt = now; task.operatorName = actor.displayName;
        task.occurrenceVersion++; task.version++; task.updatedAt = now; kind = `occurrence.${payload.status}`; eventNote = payload.note ?? "";
        result = {occurrence:occurrence(task),taskVersion:task.version};
      } else if (action === "occurrence.undo" && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.occurrence.taskId,actor); checkRef(task,payload.occurrence); version(task.occurrenceVersion,payload.expectedVersion);
        if (task.status === "pending") invalid("该次尚无可撤销记录。");
        task.status = "pending"; task.actualCompletedAt = null; task.recordedAt = now; task.operatorName = actor.displayName;
        task.occurrenceVersion++; task.version++; task.updatedAt = now; kind = "occurrence.undone";
        result = {occurrence:occurrence(task),taskVersion:task.version};
      } else if (action === "reminder.setMine" && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.taskId,actor); version(task.reminderVersion,payload.expectedVersion);
        task.reminderEnabled = payload.enabled; task.reminderSelfDisabled = !payload.enabled; task.reminderVersion++; task.version++; task.updatedAt = now;
        kind = "task.accessChanged"; result = {preference:taskDTO(task).myReminder};
      } else if ((action === "reminder.markRead" || action === "reminder.dismiss") && isPersonalPayload(action,payload)) {
        task = await owned(tx,payload.occurrence.taskId,actor); checkRef(task,payload.occurrence);
        if (!reminderDue(task,now)) missing();
        if (action === "reminder.markRead") task.readAt ??= now; else task.dismissedAt ??= now;
        task.updatedAt = now;
        result = action === "reminder.markRead" ? {occurrenceId:task.occurrenceId,read:true} : {occurrenceId:task.occurrenceId,dismissed:true};
      } else throw new Error("Unsupported write action.");
      if (scope.personalTaskCount < 0) throw new Error("Invalid task quota.");
      scope.revision++;
      await tx.saveTask(task); await tx.saveScope(scope);
      if (kind) await tx.addEvent({ id:eventId,taskId:task.id,occurrenceId:kind.startsWith("occurrence.") ? task.occurrenceId : null,kind,actorUserId:actor.id,actorName:actor.displayName,recordedAt:now,actualCompletedAt:kind === "occurrence.completed" ? task.actualCompletedAt : null,note:eventNote });
      await tx.saveReceipt(actor.id,requestId,{fingerprint,taskId:task.id,result});
      return result;
    });
  }

  private async list(action: PersonalAction, payload: unknown, now: string): Promise<unknown> {
    let query: PersonalQuery; let limit = 20; let cursor: string | undefined;
    if (action === "task.list" && isPersonalPayload(action,payload)) {
      if (payload.familyId) missing();
      const today = shanghaiDate(new Date(now));
      query = {mode:"tasks",...(payload.status ? {status:payload.status} : {}),
        ...(payload.overdue ? {overdueBefore:today,status:"pending"} : payload.unscheduled ? {unscheduled:true} : {dateFrom:payload.dateFrom ?? today,dateTo:payload.dateTo ?? today})};
      limit = payload.limit ?? 20; cursor = payload.cursor;
    } else if (action === "task.recycleList" && isPersonalPayload(action,payload)) {
      if (payload.familyId) missing(); query = {mode:"recycle"}; limit = payload.limit ?? 20; cursor = payload.cursor;
    } else if (action === "task.history" && isPersonalPayload(action,payload)) {
      query = {mode:"history",taskId:payload.taskId}; limit = payload.limit ?? 20; cursor = payload.cursor;
    } else if (action === "reminder.list" && isPersonalPayload(action,payload)) {
      query = {mode:"reminders",includeDismissed:payload.includeDismissed ?? false}; limit = payload.limit ?? 20; cursor = payload.cursor;
    } else throw new Error("Unsupported list action.");
    const start = await this.store.transaction(async tx => {
      const actor = await tx.actor(); if (query.taskId) await owned(tx,query.taskId,actor);
      return {actor,scope:await tx.scope(actor.id)};
    });
    const fingerprint = this.store.fingerprint({action,payload:{...payload,cursor:undefined}});
    let checkpoint: QueryCheckpoint = {actorId:start.actor.id,fingerprint,revision:start.scope.revision,asOf:now,after:null,summary:{completed:0,pending:0,skipped:0,denominator:0},expiresAt:new Date(Date.parse(now)+15*60000).toISOString()};
    if (cursor) {
      const saved = await this.store.readCheckpoint(cursor);
      if (!saved || saved.actorId !== start.actor.id || saved.fingerprint !== fingerprint || saved.revision !== start.scope.revision || saved.expiresAt <= now) throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。");
      checkpoint = saved;
    }
    const scanned = await this.store.scan(start.actor.id,query,checkpoint.asOf,checkpoint.after,limit);
    const end = await this.store.transaction(async tx => { const actor = await tx.actor(); if (actor.id !== start.actor.id) missing(); if (query.taskId) await owned(tx,query.taskId,actor); return tx.scope(actor.id); });
    if (end.revision !== checkpoint.revision) throw new ApplicationError("CURSOR_EXPIRED", "列表已更新，请重新加载。");
    for (const task of scanned.tasks) { checkpoint.summary[task.status]++; if (task.status !== "skipped") checkpoint.summary.denominator++; }
    checkpoint.after = scanned.after;
    const nextCursor = scanned.more ? await this.store.saveCheckpoint(checkpoint) : null;
    const base = {nextCursor,complete:!scanned.more,asOf:checkpoint.asOf};
    if (action === "task.history") return {...base,items:scanned.events};
    if (action === "task.recycleList") return {...base,items:scanned.tasks.map(taskDTO)};
    const aggregate = {...base,scopes:[{familyId:null,status:"ok"}],summary:scanned.more ? null : checkpoint.summary};
    if (action === "reminder.list") return {...aggregate,items:scanned.tasks.map(task => ({occurrence: {id:task.occurrenceId,taskId:task.id,segmentId:task.segmentId,localDate:task.date,slot:occurrenceSlot(task)},title:task.title,familyId:null,familyName:null,subjectName:task.ownerName,scheduledAt:scheduledInstant(task),readAt:task.readAt,dismissedAt:task.dismissedAt}))};
    return {...aggregate,items:scanned.tasks.map(task => ({task:taskDTO(task),occurrence:occurrence(task)}))};
  }
}

export function registerPersonalHandlers(router: ActionRouter, resolveStore: () => Promise<PersonalStore>, clock: Clock, uuids: UuidGenerator): void {
  for (const action of PERSONAL_ACTIONS) {
    const handler: ActionHandler = {action,async handle(payload,context) {
      if (!isPersonalPayload(action,payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查事项内容、日期和参数。当前支持个人一次性事项。");
      return new PersonalService(await resolveStore(),clock,uuids).execute(action,payload,context.requestId);
    }};
    router.register(handler);
  }
}
