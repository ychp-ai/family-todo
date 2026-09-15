import { BatchViewers } from "./batch-viewers";
import { ProgressService } from "./progress";
import { RecurrenceService } from "./recurrence";
import { OccurrenceLists } from "./occurrence-lists";
import { resolveTaskSubject, setTaskAccess } from "./task-access";
import { isPersonalData, isPersonalPayload, PERSONAL_ACTIONS } from "@family-todo/contracts";
import type { PersonalAction } from "@family-todo/contracts";
import { familyTaskRights, scheduledInstant } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext, ReminderPreference, User } from "@family-todo/domain";
import type { Clock, FamilyReceipt, FamilyStore, FamilyTransaction, PersonalStore, UuidGenerator } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { PersonalService } from "./personal";
import type { ActionHandler, ActionRouter } from "./router";
import { checkTaskRef, familyTaskDTO, occurrenceDTO, taskContext, taskInvalid, taskMissing, taskVersion, verifyContext } from "./task-context";
import { CollaborativeLists } from "./collaborative-lists";

function writeId(action: PersonalAction, payload: unknown): string | null {
  if (!isPersonalPayload(action, payload)) return null;
  if ("id" in payload) return payload.id;
  if ("taskId" in payload) return payload.taskId;
  if ("occurrence" in payload && payload.occurrence) return payload.occurrence.taskId;
  return null;
}

export class CollaborativeTaskService {
  private personal: Promise<PersonalService> | undefined;
  public constructor(private readonly store: FamilyStore, private readonly personalStore: PersonalStore | (() => Promise<PersonalStore>), private readonly clock: Clock, private readonly uuids: UuidGenerator) {

  }
  public async execute(action: PersonalAction, payload: unknown, requestId: string): Promise<unknown> {
    if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查事项内容、日期和参数。");
    if (action === "occurrence.list" || action === "reminder.list" || (action === "task.list" && isPersonalPayload(action, payload) && !payload.unscheduled)) return new OccurrenceLists(this.store, this.clock).execute(action, payload);
    if (action === "task.list" || action === "task.recycleList") return new CollaborativeLists(this.store, this.clock).execute(action, payload);
    if (action === "task.batchAddViewers") return new BatchViewers(this.store, this.clock, this.uuids).execute(payload, requestId);
    if (action === "progress.get") return new ProgressService(this.store, this.clock).execute(payload);
    const id = writeId(action, payload); let existing = id ? await this.store.readTask(id) : null;
    let dispatchPrior: { actor: User; receipt: FamilyReceipt | null } | undefined;
    // A lost personal-create response may be retried after that same task has joined a family.
    if (action === "task.create" || action === "task.update") {
      dispatchPrior = await this.store.transaction(async tx => { const actor = await tx.actor(); return { actor, receipt: await tx.receipt(actor.id, requestId) }; });
      const { receipt } = dispatchPrior;
      if (receipt && action === "task.update" && receipt.minimumConfirmation) {
        if (receipt.fingerprint !== this.store.fingerprint({ action, payload })) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作，请重新发起。");
        if (!isPersonalData("task.update", receipt.result) || !("accessLost" in receipt.result)) throw new Error("Invalid minimal update receipt.");
        return receipt.result;
      }
      if (receipt && action === "task.create") existing = await this.store.readTask(receipt.taskId);
    }
    const draft = "draft" in payload ? payload.draft : undefined;
    if (action === "task.previewSchedule" || action === "task.pause" || action === "task.resume" || action === "task.stop" || existing?.recurrence || (draft && draft.schedule.kind !== "once")) return new RecurrenceService(this.store, this.clock, this.uuids).execute(action, payload, requestId, existing, dispatchPrior);
    if (!existing?.collaboration && !draft?.familyId) {
      this.personal ??= Promise.resolve(typeof this.personalStore === "function" ? this.personalStore() : this.personalStore).then(store => new PersonalService(store, this.clock, this.uuids));
      return (await this.personal).execute(action, payload, requestId);
    }
    const context = existing?.collaboration ? await taskContext(this.store, existing) : draft?.familyId ? await this.store.context(draft.familyId) : null;
    if (!context) taskMissing();
    let result: unknown;
    if (action === "task.get" && isPersonalPayload(action, payload)) {
      result = await this.store.transaction(async tx => {
        const actor = await tx.actor(); await verifyContext(tx, context, actor.id);
        const task = await tx.task(payload.id); if (!task || task.lifecycle !== "active") taskMissing();
        if (payload.occurrence) checkTaskRef(task, payload.occurrence);
        const dto = await familyTaskDTO(tx, task, context, actor.id);
        return { task: dto, occurrence: occurrenceDTO(task, dto.capabilities.canRecord) };
      });
    } else if (action === "task.history" && isPersonalPayload(action, payload)) {
      return new CollaborativeLists(this.store, this.clock).history(payload, context);
    } else result = await this.write(action, payload, requestId, context, existing);
    if (!isPersonalData(action, result)) throw new Error("Invalid collaborative task result.");
    return result;
  }
  private async write(action: PersonalAction, payload: unknown, requestId: string, snapshot: FamilyContext, previousTask: CollaborativeTask | null): Promise<unknown> {
    const fingerprint = this.store.fingerprint({ action, payload });
    const candidateId = this.uuids.generate(); const segmentId = this.uuids.generate(); const occurrenceId = this.uuids.generate(); const eventId = this.uuids.generate();
    return this.store.transaction(async tx => {
      const now = this.clock.now().toISOString(); const actor = await tx.actor(); const receipt = await tx.receipt(actor.id, requestId);
      if (receipt && receipt.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作，请重新发起。");
      const context: FamilyContext = { ...snapshot, family: { ...snapshot.family } };
      const actorMember = await verifyContext(tx, context, actor.id);
      if (receipt) {
        const current = await tx.task(receipt.taskId); if (!current?.collaboration || current.collaboration.familyId !== context.family.id) taskMissing();
        const rights = familyTaskRights(current, context, actor.id);
        if (!rights.canView || ((action.startsWith("task.")) && !rights.manager)) taskMissing();
        return receipt.result;
      }
      let task: CollaborativeTask; let result: unknown; let kind = ""; let eventNote = ""; let scopeChanged = false;
      const scope = await tx.scope(actor.id);
      if (action === "task.create" && isPersonalPayload(action, payload)) {
        if (context.family.taskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "家庭事项已达 500 条，请先整理。");
        if (await tx.task(candidateId)) throw new Error("Task identifier collision.");
        const draft = payload.draft; if (draft.schedule.kind !== "once") taskInvalid("周期事项需要通过日程服务处理。"); const selected = resolveTaskSubject(draft, context, actor.id);
        task = { id: candidateId, ownerUserId: actor.id, ownerName: actor.displayName, title: draft.title.trim(), note: draft.note,
          version: 1, segmentId, occurrenceId, date: draft.schedule.date, time: draft.schedule.time, lifecycle: "active", status: "pending", occurrenceVersion: 0,
          actualCompletedAt: null, recordedAt: null, operatorName: null, reminderEnabled: false, reminderSelfDisabled: false, reminderVersion: 0,
          readAt: null, dismissedAt: null, createdAt: now, updatedAt: now,
          collaboration: { familyId: context.family.id, creatorMembershipId: actorMember.id, createdByUserId: actor.id, ownerBinding: selected.subject.kind === "virtual" ? { kind: "familyOwner" } : { kind: "membership", membershipId: actorMember.id }, subject: selected.subject, subjectName: selected.name, viewerMembershipIds: [], helperMembershipIds: [] } };
        await setTaskAccess(tx, task, context, actor.id, draft.access); context.family.taskCount++; kind = "task.created";
      } else {
        const id = writeId(action, payload); if (!id) taskMissing();
        const loaded = await tx.task(id); if (!loaded) taskMissing(); task = loaded;
        if (task.collaboration?.familyId !== context.family.id) {
          if (task.collaboration || task.ownerUserId !== actor.id || action !== "task.update" || task.lifecycle !== "active") taskMissing();
        }
        const promotion = !task.collaboration;
        const rights = task.collaboration ? familyTaskRights(task, context, actor.id) : null;
        if (rights && (!rights.canView || (task.lifecycle === "deleted" && !rights.manager))) taskMissing();
        if (action.startsWith("task.") && rights && !rights.manager) throw new ApplicationError("FORBIDDEN", "只有归属人或创建者可以管理这件事。");
        if (task.lifecycle !== "active" && action !== "task.restore") taskInvalid("事项已在回收站，请先恢复。");
        if (action === "task.update" && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion); const draft = payload.draft; if (draft.schedule.kind !== "once") taskInvalid("周期事项需要通过日程服务处理。");
          if (draft.familyId !== context.family.id) taskInvalid("已归属家庭的事项不能更换家庭。");
          const selected = resolveTaskSubject(draft, context, actor.id, task);
          const sameSubject = promotion
            ? selected.subject.kind === "member" && context.members.some(member => selected.subject.kind === "member" && member.id === selected.subject.membershipId && member.userId === task.ownerUserId)
            : JSON.stringify(task.collaboration?.subject) === JSON.stringify(selected.subject);
          const changed = task.date !== draft.schedule.date || task.time !== draft.schedule.time || !sameSubject;
          const originalOccurrence = occurrenceDTO(task, false);
          if (changed && task.status !== "pending") taskInvalid("请先撤销完成或跳过记录，再修改日期或执行人。");
          if (promotion) {
            if (!previousTask || context.family.taskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "家庭事项已达 500 条，请先整理。");
            task.collaboration = { familyId: context.family.id, creatorMembershipId: actorMember.id, createdByUserId: task.ownerUserId, ownerBinding: { kind: "membership", membershipId: actorMember.id }, subject: selected.subject, subjectName: selected.name, viewerMembershipIds: [], helperMembershipIds: [] };
            context.family.taskCount++; scope.personalTaskCount--; scopeChanged = true;
            if (!changed && (task.readAt || task.dismissedAt)) await tx.saveReminderReceipt({ occurrenceId: task.occurrenceId, userId: actor.id, readAt: task.readAt, dismissedAt: task.dismissedAt, version: 1 });
            // Preserve a personal user's explicit reminder choice when the same task joins a family.
            await tx.savePreference({ taskId: task.id, userId: actor.id, membershipId: actorMember.id, enabled: task.reminderEnabled, selfDisabled: task.reminderSelfDisabled, version: Math.max(1, task.reminderVersion) });
          }
          const binding = task.collaboration; if (!binding) taskMissing();
          binding.occurrenceSnapshot = changed ? { subject: selected.subject, subjectName: selected.name } : { subject: originalOccurrence.subject, subjectName: originalOccurrence.subjectName };
          binding.subject = selected.subject; binding.subjectName = selected.name;
          binding.ownerBinding = selected.subject.kind === "virtual" ? { kind: "familyOwner" } : { kind: "membership", membershipId: binding.creatorMembershipId };
          task.title = draft.title.trim(); task.note = draft.note;
          if (changed) { task.date = draft.schedule.date; task.time = draft.schedule.time; task.segmentId = segmentId; task.occurrenceId = occurrenceId; task.occurrenceVersion = 0; task.readAt = null; task.dismissedAt = null; }
          await setTaskAccess(tx, task, context, actor.id, draft.access); kind = "task.updated";
        } else if (action === "task.setAccess" && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion); await setTaskAccess(tx, task, context, actor.id, payload.access); kind = "task.accessChanged";
        } else if (action === "task.delete" && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion); task.lifecycle = "deleted"; context.family.taskCount--; kind = "task.deleted";
        } else if (action === "task.restore" && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion); if (task.lifecycle !== "deleted") taskInvalid("事项已恢复。");
          if (context.family.taskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "家庭事项已达 500 条，请先整理。");
          task.lifecycle = "active"; context.family.taskCount++; kind = "task.restored";
        } else if (action === "occurrence.record" && isPersonalPayload(action, payload)) {
          if (!rights?.canRecord) throw new ApplicationError("FORBIDDEN", "你当前只能查看这件事。");
          checkTaskRef(task, payload.occurrence); taskVersion(task.occurrenceVersion, payload.expectedVersion);
          if (task.status !== "pending") taskInvalid("该次已有记录，请先撤销。");
          const actual = payload.status === "completed" ? payload.actualCompletedAt ?? now : null;
          if (actual !== null && (actual > now || actual < task.createdAt)) taskInvalid("实际完成时间需在事项创建后，且不能晚于现在。");
          task.status = payload.status; task.actualCompletedAt = actual; task.recordedAt = now; task.operatorName = actorMember.name; task.occurrenceVersion++;
          kind = `occurrence.${payload.status}`; eventNote = payload.note ?? "";
        } else if (action === "occurrence.undo" && isPersonalPayload(action, payload)) {
          if (!rights?.canRecord) throw new ApplicationError("FORBIDDEN", "你当前只能查看这件事。");
          checkTaskRef(task, payload.occurrence); taskVersion(task.occurrenceVersion, payload.expectedVersion);
          if (task.status === "pending") taskInvalid("该次尚无可撤销记录。");
          task.status = "pending"; task.actualCompletedAt = null; task.recordedAt = now; task.operatorName = actorMember.name; task.occurrenceVersion++; kind = "occurrence.undone";
        } else if (action === "reminder.setMine" && isPersonalPayload(action, payload)) {
          const preference = await tx.preference(task.id, actor.id); taskVersion(preference?.version ?? 0, payload.expectedVersion);
          const updated: ReminderPreference = { taskId: task.id, userId: actor.id, membershipId: actorMember.id, enabled: payload.enabled, selfDisabled: !payload.enabled, version: (preference?.version ?? 0) + 1 };
          await tx.savePreference(updated); kind = "task.accessChanged";
        } else if ((action === "reminder.markRead" || action === "reminder.dismiss") && isPersonalPayload(action, payload)) {
          checkTaskRef(task, payload.occurrence); const preference = await tx.preference(task.id, actor.id); const scheduled = scheduledInstant(task);
          if (!preference?.enabled || preference.selfDisabled || preference.membershipId !== actorMember.id || task.status !== "pending" || !scheduled || scheduled > now) taskMissing();
          const receipt = await tx.reminderReceipt(task.occurrenceId, actor.id) ?? { occurrenceId: task.occurrenceId, userId: actor.id, readAt: null, dismissedAt: null, version: 0 };
          if (action === "reminder.markRead") receipt.readAt ??= now; else receipt.dismissedAt ??= now;
          receipt.version++; await tx.saveReminderReceipt(receipt);
        } else throw new Error("Unsupported collaborative action.");
        if (kind) task.version++;
        task.updatedAt = now;
      }
      let removedParticipantCount = 0;
      if (kind === "task.restored" && task.collaboration) {
        const active = new Set(context.members.filter(member => member.status === "active").map(member => member.id));
        removedParticipantCount = new Set([...task.collaboration.viewerMembershipIds, ...task.collaboration.helperMembershipIds].filter(id => !active.has(id))).size;
        task.collaboration.viewerMembershipIds = task.collaboration.viewerMembershipIds.filter(id => active.has(id));
        task.collaboration.helperMembershipIds = task.collaboration.helperMembershipIds.filter(id => active.has(id));
      }
      const receiptOnly = action === "reminder.markRead" || action === "reminder.dismiss";
      if (!receiptOnly) {
        context.family.version++; context.family.updatedAt = now;
        if (["task.created", "task.updated", "task.accessChanged", "task.deleted", "task.restored"].includes(kind)) context.family.authEpoch++;
        await tx.saveTask(task); await tx.saveFamily(context.family);
      } else scopeChanged = true;
      if (scopeChanged) { if (scope.personalTaskCount < 0) throw new Error("Invalid personal quota."); scope.revision++; await tx.saveScope(scope); }
      if (kind) await tx.addEvent({ id: eventId, taskId: task.id, occurrenceId: kind.startsWith("occurrence.") ? task.occurrenceId : null, kind, actorUserId: actor.id, actorName: actorMember.name, recordedAt: now, actualCompletedAt: kind === "occurrence.completed" ? task.actualCompletedAt : null, note: eventNote });
      if (action === "task.delete") result = { id: task.id, version: task.version, deleted: true };
      else if (action === "task.update" && !familyTaskRights(task, context, actor.id).canView) result = { id: task.id, version: task.version, updated: true, accessLost: true };
      else if (action === "reminder.markRead") result = { occurrenceId: task.occurrenceId, read: true };
      else if (action === "reminder.dismiss") result = { occurrenceId: task.occurrenceId, dismissed: true };
      else if (action === "occurrence.record" || action === "occurrence.undo") result = { occurrence: occurrenceDTO(task, familyTaskRights(task, context, actor.id).canRecord), taskVersion: task.version };
      else if (action === "reminder.setMine") {
        const preference = await tx.preference(task.id, actor.id);
        result = { preference: { enabled: Boolean(preference?.enabled && !preference.selfDisabled && preference.membershipId === actorMember.id), selfDisabled: preference?.selfDisabled ?? false, version: preference?.version ?? 0 } };
      } else {
        const dto = await familyTaskDTO(tx, task, context, actor.id);
        if (action === "task.restore") result = { task: dto, removedParticipantCount };
        else if (action === "task.setAccess") result = { task: dto };
        else result = { task: dto, nextOccurrences: [occurrenceDTO(task, dto.capabilities.canRecord)] };
      }
      await tx.saveReceipt(actor.id, requestId, { fingerprint, taskId: task.id, familyId: context.family.id, resourceKind: "task", ...(action === "task.update" && isPersonalData("task.update", result) && "accessLost" in result ? { minimumConfirmation: true } : {}), result });
      return result;
    });
  }
}
export function registerCollaborativeTaskHandlers(router: ActionRouter, resolveStore: () => Promise<FamilyStore>, resolvePersonalStore: () => Promise<PersonalStore>, clock: Clock, uuids: UuidGenerator): void {
  for (const action of PERSONAL_ACTIONS) {
    const handler: ActionHandler = { action, async handle(payload, context) {
      if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查事项内容、日期和参数。");
      return new CollaborativeTaskService(await resolveStore(), resolvePersonalStore, clock, uuids).execute(action, payload, context.requestId);
    } }; router.register(handler);
  }
}
