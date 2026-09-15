import { isPersonalData, isPersonalPayload } from "@family-todo/contracts";
import type { OccurrenceDTO, PersonalAction, TaskDTO, TaskDraft } from "@family-todo/contracts";
import { enumerateSlots, familyTaskRights, isValidActualCompletedAt, localDateAt, splitSchedule, transitionLifecycle } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext, PersistedOccurrenceState, PersistedScheduleSegment, ProjectedOccurrence, User } from "@family-todo/domain";
import type { Clock, FamilyReceipt, FamilyStore, FamilyTransaction, UuidGenerator } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { taskDTO } from "./personal";
import { resolveTaskSubject, setTaskAccess } from "./task-access";
import { familyTaskDTO, taskContext, taskInvalid, taskMissing, taskVersion, verifyContext } from "./task-context";
import { legacySegment, nextProjected, occurrenceCanRecord, overlayOccurrence, projectedDTO, resolveOccurrence } from "./recurrence-projection";
import { CollaborativeLists } from "./collaborative-lists";

function targetId(payload: unknown, action: PersonalAction): string | null {
  if (!isPersonalPayload(action, payload)) return null;
  return "id" in payload ? payload.id : "taskId" in payload ? payload.taskId : "occurrence" in payload && payload.occurrence ? payload.occurrence.taskId : null;
}
function visible(task: CollaborativeTask, context: FamilyContext | null, actorId: string, manager = false): void {
  if (context) {
    const rights = familyTaskRights(task, context, actorId);
    if (!rights.canView || (task.lifecycle === "deleted" && !rights.manager)) taskMissing();
    if (manager && !rights.manager) throw new ApplicationError("FORBIDDEN", "只有归属人或创建者可以管理这件事。");
  } else if (task.collaboration || task.ownerUserId !== actorId) taskMissing();
}
async function dto(tx: FamilyTransaction, task: CollaborativeTask, context: FamilyContext | null, actorId: string): Promise<TaskDTO> {
  return context ? familyTaskDTO(tx, task, context, actorId) : taskDTO(task);
}
function refreshHistory(task: CollaborativeTask, now: string): void {
  const recurrence = task.recurrence;
  if (recurrence?.firstEligibleAt && recurrence.firstEligibleAt <= now) {
    recurrence.hasHistory = true; recurrence.currentSubjectHasHistory = true;
  }
}
function setFirstEligible(task: CollaborativeTask, segment: PersistedScheduleSegment, now: string): void {
  if (!task.recurrence) return;
  const first = nextProjected(task, segment, now, 1)[0];
  task.recurrence.firstEligibleAt = first?.eligibilityBoundary ?? null;
}
export class RecurrenceService {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock, private readonly uuids: UuidGenerator) {}
  public async execute(action: PersonalAction, payload: unknown, requestId: string, snapshot?: CollaborativeTask | null, dispatchPrior?: { actor: User; receipt: FamilyReceipt | null }): Promise<unknown> {
    if (!isPersonalPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查日程参数。");
    if (action === "task.previewSchedule" && isPersonalPayload(action, payload)) return this.preview(payload, snapshot);
    let existing = snapshot === undefined ? (targetId(payload, action) ? await this.store.readTask(targetId(payload, action) ?? "") : null) : snapshot;
    const prior = dispatchPrior ?? await this.store.transaction(async tx => { const actor = await tx.actor(); return { actor, receipt: action === "task.get" || action === "task.history" ? null : await tx.receipt(actor.id, requestId) }; });
    const fingerprint = this.store.fingerprint({ action, payload });
    if (prior.receipt) {
      if (prior.receipt.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作，请重新发起。");
      existing = await this.store.readTask(prior.receipt.taskId);
      if (prior.receipt.minimumConfirmation) return prior.receipt.result;
      if (!existing) taskMissing();
      const replayTaskId = existing.id;
      const context = existing.collaboration ? await taskContext(this.store, existing) : null;
      return this.store.transaction(async tx => {
        if (context) await verifyContext(tx, context, prior.actor.id);
        const task = await tx.task(replayTaskId); if (!task) taskMissing(); visible(task, context, prior.actor.id);
        return prior.receipt?.result;
      });
    }
    const draft = "draft" in payload ? payload.draft : null;
    const context = existing?.collaboration ? await taskContext(this.store, existing) : draft?.familyId ? await this.store.context(draft.familyId) : null;
    if (draft?.familyId && !context) taskMissing();
    if (existing) visible(existing, context && existing.collaboration ? context : null, prior.actor.id);
    let occurrence: ProjectedOccurrence | null = null;
    if (existing && "occurrence" in payload && payload.occurrence) occurrence = await resolveOccurrence(this.store, existing, payload.occurrence, this.clock.now().toISOString());
    if (action === "task.get" && isPersonalPayload(action, payload)) {
      if (!existing || existing.lifecycle === "deleted") taskMissing();
      const segment = occurrence ? null : await this.currentSegment(existing);
      const next = segment ? nextProjected(existing, segment, this.clock.now().toISOString(), 1)[0] : null;
      const currentOccurrence = occurrence ?? (next ? await overlayOccurrence(this.store, existing, next) : null);
      return this.store.transaction(async tx => {
        if (context) await verifyContext(tx, context, prior.actor.id);
        const current = await tx.task(payload.id); if (!current) taskMissing(); taskVersion(current.version, existing.version); visible(current, context, prior.actor.id);
        return { task: await dto(tx, current, context, prior.actor.id), occurrence: currentOccurrence ? projectedDTO(this.store, current, context, prior.actor.id, currentOccurrence) : null };
      });
    }
    if (action === "task.history" && isPersonalPayload(action, payload)) return new CollaborativeLists(this.store, this.clock).history(payload, context);
    return this.write(action, payload, requestId, fingerprint, existing, context, occurrence);
  }
  private async currentSegment(task: CollaborativeTask): Promise<PersistedScheduleSegment> {
    if (!task.recurrence) return legacySegment(task);
    const segment = await this.store.readSegment(task.recurrence.currentSegmentId); if (!segment || segment.taskId !== task.id) throw new Error("Missing current schedule segment."); return segment;
  }
  private async preview(payload: { schedule: TaskDraft["schedule"]; taskId?: string }, snapshot?: CollaborativeTask | null): Promise<unknown> {
    const now = this.clock.now().toISOString();
    if (payload.taskId) {
      const task = snapshot === undefined ? await this.store.readTask(payload.taskId) : snapshot; if (!task) taskMissing();
      const context = task.collaboration ? await taskContext(this.store, task) : null;
      await this.store.transaction(async tx => { const actor = await tx.actor(); if (context) await verifyContext(tx, context, actor.id); const current = await tx.task(task.id); if (!current) taskMissing(); visible(current, context, actor.id, true); });
    }
    const id = this.uuids.generate(); const segmentId = this.uuids.generate();
    const task: CollaborativeTask = { id, ownerUserId: id, ownerName: "预览", title: "预览", note: "", version: 1, segmentId, occurrenceId: this.uuids.generate(), date: null, time: null, lifecycle: "active", status: "pending", occurrenceVersion: 0, actualCompletedAt: null, recordedAt: null, operatorName: null, reminderEnabled: false, reminderSelfDisabled: false, reminderVersion: 0, readAt: null, dismissedAt: null, createdAt: now, updatedAt: now };
    task.recurrence = { schedule: payload.schedule, currentSegmentId: segmentId, activeOnceSegmentId: payload.schedule.kind === "once" ? segmentId : null, stopped: false, priorLifecycle: null, enabledFrom: now, firstEligibleAt: null, hasHistory: false, currentSubjectHasHistory: false };
    const segment: PersistedScheduleSegment = { id: segmentId, taskId: id, schedule: payload.schedule, subject: { kind: "user", userId: id }, subjectNameSnapshot: "预览", effectiveFrom: now, effectiveUntil: null, allowCreationDay: !payload.taskId, createdByUserId: id };
    const nextOccurrences = nextProjected(task, segment, now).map(({ localDate, time, scheduledAt }) => ({ localDate, time, scheduledAt }));
    const schedule = payload.schedule;
    const excludedPastSlots = schedule.kind !== "once" && [...enumerateSlots(schedule, localDateAt(now), localDateAt(now))].some(slot => slot.scheduledAt !== null && slot.scheduledAt <= now);
    return { now, nextOccurrences, excludedPastSlots, explanation: excludedPastSlots ? "已过时刻不会补建，从下一有效安排开始。" : "按上海时间安排，未来次数到时后可记录。" };
  }
  private async write(action: PersonalAction, payload: unknown, requestId: string, fingerprint: string, existing: CollaborativeTask | null, snapshot: FamilyContext | null, candidate: ProjectedOccurrence | null): Promise<unknown> {
    const id = this.uuids.generate(), segmentId = this.uuids.generate(), eventId = this.uuids.generate(), controlId = this.uuids.generate();
    const oldSegment = existing ? await this.currentSegment(existing) : null;
    const result = await this.store.transaction(async tx => {
      const now = this.clock.now().toISOString(); const actor = await tx.actor(); const receipt = await tx.receipt(actor.id, requestId);
      if (receipt && receipt.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作，请重新发起。");
      const context = snapshot ? { ...snapshot, family: { ...snapshot.family } } : null;
      const member = context ? await verifyContext(tx, context, actor.id) : null;
      if (receipt) { const current = await tx.task(receipt.taskId); if (!current) taskMissing(); visible(current, context, actor.id); return receipt.result; }
      const scope = await tx.scope(actor.id); let scopeChanged = context === null; let task: CollaborativeTask; let segment: PersistedScheduleSegment;
      let eventKind = ""; let eventNote = ""; let outputOccurrence: OccurrenceDTO | null = null;
      if (action === "task.create" && isPersonalPayload(action, payload)) {
        if ((context?.family.taskCount ?? scope.personalTaskCount) >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "事项已达 500 条，请先整理。");
        if (await tx.task(id)) throw new Error("Task identifier collision.");
        const draft = payload.draft;
        if (!context && (draft.subject.kind !== "self" || draft.access.viewerMembershipIds.length || draft.access.helperMembershipIds.length || draft.access.reminderMembershipIds.length)) taskInvalid("请先选择所属家庭。");
        const selected = context ? resolveTaskSubject(draft, context, actor.id) : { subject: { kind: "user" as const, userId: actor.id }, name: actor.displayName };
        task = { id, ownerUserId: actor.id, ownerName: actor.displayName, title: draft.title.trim(), note: draft.note, version: 1, segmentId, occurrenceId: this.uuids.generate(), date: null, time: null, lifecycle: "active", status: "pending", occurrenceVersion: 0, actualCompletedAt: null, recordedAt: null, operatorName: null, reminderEnabled: draft.access.remindMe, reminderSelfDisabled: !draft.access.remindMe, reminderVersion: 1, readAt: null, dismissedAt: null, createdAt: now, updatedAt: now };
        if (context && member && selected.subject.kind !== "user") task.collaboration = { familyId: context.family.id, creatorMembershipId: member.id, createdByUserId: actor.id, ownerBinding: selected.subject.kind === "virtual" ? { kind: "familyOwner" } : { kind: "membership", membershipId: member.id }, subject: selected.subject, subjectName: selected.name, viewerMembershipIds: [], helperMembershipIds: [] };
        task.recurrence = { schedule: draft.schedule, currentSegmentId: segmentId, activeOnceSegmentId: draft.schedule.kind === "once" ? segmentId : null, stopped: false, priorLifecycle: null, enabledFrom: now, firstEligibleAt: null, hasHistory: false, currentSubjectHasHistory: false };
        segment = { id: segmentId, taskId: id, schedule: draft.schedule, subject: selected.subject, subjectNameSnapshot: selected.name, effectiveFrom: now, effectiveUntil: null, allowCreationDay: true, createdByUserId: actor.id };
        await tx.saveSegment(segment); setFirstEligible(task, segment, now);
        if (context) { await setTaskAccess(tx, task, context, actor.id, draft.access); context.family.taskCount++; } else scope.personalTaskCount++;
        eventKind = "task.created";
      } else {
        if (!existing || !oldSegment) taskMissing();
        const loaded = await tx.task(existing.id); if (!loaded) taskMissing(); task = loaded;
        taskVersion(task.version, existing.version); visible(task, task.collaboration ? context : null, actor.id, action.startsWith("task."));
        if (task.lifecycle === "deleted" && action !== "task.restore") taskInvalid("事项已在回收站，请先恢复。");
        segment = oldSegment; refreshHistory(task, now);
        if (action === "task.update" && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion); const draft = payload.draft;
          if (task.collaboration && draft.familyId !== task.collaboration.familyId) taskInvalid("已归属家庭的事项不能更换家庭。");
          if (!context && (draft.subject.kind !== "self" || draft.access.viewerMembershipIds.length || draft.access.helperMembershipIds.length || draft.access.reminderMembershipIds.length)) taskInvalid("请先选择所属家庭。");
          const selected = context ? resolveTaskSubject(draft, context, actor.id, task) : { subject: { kind: "user" as const, userId: actor.id }, name: actor.displayName };
          const sameSubject = JSON.stringify(segment.subject) === JSON.stringify(selected.subject);
          const changed = this.store.fingerprint(segment.schedule) !== this.store.fingerprint(draft.schedule) || !sameSubject;
          if (changed && segment.schedule.kind === "once" && task.status !== "pending") taskInvalid("请先撤销完成或跳过记录，再修改安排。");
          if (changed && segment.schedule.kind !== "once" && draft.schedule.kind === "once" && (task.recurrence?.hasHistory || task.lifecycle !== "active" || task.recurrence?.stopped)) taskInvalid("已有应做次数或控制历史的周期不能改为一次性，请另建事项。");
          if (context && member && !task.collaboration && selected.subject.kind !== "user") {
            if (context.family.taskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "家庭事项已达 500 条，请先整理。");
            task.collaboration = { familyId: context.family.id, creatorMembershipId: member.id, createdByUserId: task.ownerUserId, ownerBinding: { kind: "membership", membershipId: member.id }, subject: selected.subject, subjectName: selected.name, viewerMembershipIds: [], helperMembershipIds: [] };
            context.family.taskCount++; scope.personalTaskCount--; scopeChanged = true;
            await tx.savePreference({ taskId: task.id, userId: actor.id, membershipId: member.id, enabled: task.reminderEnabled, selfDisabled: task.reminderSelfDisabled, version: Math.max(1, task.reminderVersion) });
          }
          if (!task.recurrence) {
            task.recurrence = { schedule: segment.schedule, currentSegmentId: segment.id, activeOnceSegmentId: segment.id, stopped: false, priorLifecycle: null, enabledFrom: now, firstEligibleAt: null, hasHistory: false, currentSubjectHasHistory: false };
            await tx.saveSegment(segment);
          }
          if (changed) {
            if (!sameSubject && segment.subject.kind === "member" && task.recurrence.currentSubjectHasHistory) {
              await tx.saveHistoricalSubjectAccess({ taskId: task.id, membershipId: segment.subject.membershipId });
              if (context) { context.historicalTaskId = task.id; context.historicalSubjectMembershipIds = [...new Set([...(context.historicalSubjectMembershipIds ?? []), segment.subject.membershipId])]; }
            }
            const split = splitSchedule(segment, { id: segmentId, schedule: draft.schedule, subject: selected.subject, subjectNameSnapshot: selected.name }, now);
            await tx.saveSegment({ ...split.previous, createdByUserId: segment.createdByUserId });
            segment = { ...split.next, createdByUserId: actor.id }; await tx.saveSegment(segment);
            task.recurrence.schedule = draft.schedule; task.recurrence.currentSegmentId = segment.id;
            task.recurrence.activeOnceSegmentId = draft.schedule.kind === "once" ? segment.id : null;
            if (!sameSubject) task.recurrence.currentSubjectHasHistory = false;
            task.segmentId = segment.id; task.date = draft.schedule.kind === "once" ? draft.schedule.date : null; task.time = draft.schedule.kind === "once" ? draft.schedule.time : null;
            setFirstEligible(task, segment, now);
          }
          task.title = draft.title.trim(); task.note = draft.note;
          if (task.collaboration && selected.subject.kind !== "user") {
            task.collaboration.subject = selected.subject; task.collaboration.subjectName = selected.name;
            task.collaboration.ownerBinding = selected.subject.kind === "virtual" ? { kind: "familyOwner" } : { kind: "membership", membershipId: task.collaboration.creatorMembershipId };
          }
          if (context) await setTaskAccess(tx, task, context, actor.id, draft.access);
          else if (task.reminderEnabled !== draft.access.remindMe) { task.reminderEnabled = draft.access.remindMe; task.reminderSelfDisabled = !draft.access.remindMe; task.reminderVersion++; }
          eventKind = "task.updated";
        } else if ((action === "task.pause" || action === "task.resume" || action === "task.stop" || action === "task.delete" || action === "task.restore") && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion); const recurrence = task.recurrence; if (!recurrence) taskInvalid("一次性事项不支持暂停或停止。");
          const kind = action === "task.pause" ? "pause" : action === "task.resume" ? "resume" : action === "task.stop" ? "stop" : action === "task.delete" ? "delete" : "restore";
          const transition = transitionLifecycle({ lifecycle: task.lifecycle, stopped: recurrence.stopped }, kind, recurrence.schedule.kind !== "once");
          if (!transition.ok) taskInvalid("当前状态不支持这项操作。");
          if (kind === "delete") { recurrence.priorLifecycle = task.lifecycle === "deleted" ? null : task.lifecycle; if (context) context.family.taskCount--; else scope.personalTaskCount--; }
          if (kind === "restore") { if ((context?.family.taskCount ?? scope.personalTaskCount) >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "事项已达 500 条，请先整理。"); if (context) context.family.taskCount++; else scope.personalTaskCount++; }
          task.lifecycle = transition.state.lifecycle; recurrence.stopped = transition.state.stopped;
          recurrence.hasHistory = true;
          if (kind === "resume") recurrence.enabledFrom = now;
          await tx.saveControl({ id: controlId, taskId: task.id, segmentId: segment.id, kind, effectiveAt: now, taskVersion: task.version + 1, enabled: task.lifecycle === "active", stopped: recurrence.stopped });
          setFirstEligible(task, segment, now); eventKind = kind === "pause" ? "task.paused" : kind === "resume" ? "task.resumed" : kind === "stop" ? "task.stopped" : kind === "delete" ? "task.deleted" : "task.restored";
        } else if ((action === "occurrence.record" || action === "occurrence.undo") && isPersonalPayload(action, payload)) {
          if (!candidate || !occurrenceCanRecord(task, context, actor.id, candidate)) {
            if (candidate && !candidate.canRecord) taskInvalid("未来次数尚未到时，不能提前记录。");
            throw new ApplicationError("FORBIDDEN", "你当前不能记录该次安排。");
          }
          const occurrenceId = this.store.deriveOccurrenceId(candidate.identity); const state = await tx.occurrenceState(occurrenceId);
          taskVersion(state?.version ?? 0, payload.expectedVersion);
          const status = state?.status ?? "pending";
          if (action === "occurrence.record" && status !== "pending") taskInvalid("该次已有记录，请先撤销。");
          if (action === "occurrence.undo" && status === "pending") taskInvalid("该次尚无可撤销记录。");
          const nextStatus = action === "occurrence.undo" ? "pending" : isPersonalPayload("occurrence.record", payload) ? payload.status : "pending";
          const actual = nextStatus === "completed" && isPersonalPayload("occurrence.record", payload) ? payload.actualCompletedAt ?? now : null;
          if (actual !== null && !isValidActualCompletedAt(candidate, actual, now, task.createdAt)) taskInvalid("请检查实际完成时间，不能晚于现在或早于本次允许的日期。");
          const updated: PersistedOccurrenceState = { id: occurrenceId, taskId: task.id, segmentId: candidate.segmentId, localDate: candidate.localDate, slot: candidate.slot, identityKey: candidate.identityKey, status: nextStatus, version: (state?.version ?? 0) + 1, actualCompletedAt: actual, recordedAt: now, operatorName: member?.name ?? actor.displayName, operatorUserId: actor.id };
          await tx.saveOccurrenceState(updated); outputOccurrence = projectedDTO(this.store, task, context, actor.id, { ...candidate, ...updated });
          if (task.recurrence) { task.recurrence.hasHistory = true; if (candidate.segmentId === task.recurrence.currentSegmentId) task.recurrence.currentSubjectHasHistory = true; }
          if (segment.schedule.kind === "once") task.status = nextStatus;
          eventKind = action === "occurrence.undo" ? "occurrence.undone" : `occurrence.${nextStatus}`;
          if (isPersonalPayload("occurrence.record", payload)) eventNote = payload.note ?? "";
        } else if (action === "task.setAccess" && isPersonalPayload(action, payload)) {
          taskVersion(task.version, payload.expectedVersion);
          if (context) await setTaskAccess(tx, task, context, actor.id, payload.access);
          else { if (payload.access.viewerMembershipIds.length || payload.access.helperMembershipIds.length || payload.access.reminderMembershipIds.length) taskInvalid("请先选择所属家庭。"); if (task.reminderEnabled !== payload.access.remindMe) { task.reminderEnabled = payload.access.remindMe; task.reminderSelfDisabled = !payload.access.remindMe; task.reminderVersion++; } }
          eventKind = "task.accessChanged";
        } else if (action === "reminder.setMine" && isPersonalPayload(action, payload)) {
          if (context && member) { const pref = await tx.preference(task.id, actor.id); taskVersion(pref?.version ?? 0, payload.expectedVersion); await tx.savePreference({ taskId: task.id, userId: actor.id, membershipId: member.id, enabled: payload.enabled, selfDisabled: !payload.enabled, version: (pref?.version ?? 0) + 1 }); }
          else { taskVersion(task.reminderVersion, payload.expectedVersion); task.reminderEnabled = payload.enabled; task.reminderSelfDisabled = !payload.enabled; task.reminderVersion++; }
          eventKind = "task.accessChanged";
        } else if ((action === "reminder.markRead" || action === "reminder.dismiss") && isPersonalPayload(action, payload)) {
          if (!candidate || candidate.status !== "pending" || !candidate.scheduledAt || candidate.scheduledAt > now) taskMissing();
          const pref = context ? await tx.preference(task.id, actor.id) : { enabled: task.reminderEnabled, selfDisabled: task.reminderSelfDisabled, membershipId: null };
          if (!pref?.enabled || pref.selfDisabled || (member && pref.membershipId !== member.id)) taskMissing();
          const occurrenceId = this.store.deriveOccurrenceId(candidate.identity);
          const reminder = await tx.reminderReceipt(occurrenceId, actor.id) ?? { occurrenceId, userId: actor.id, version: 0, readAt: null, dismissedAt: null };
          if (action === "reminder.markRead") reminder.readAt ??= now; else reminder.dismissedAt ??= now;
          reminder.version++; await tx.saveReminderReceipt(reminder);
        } else throw new Error("Unsupported recurrence action.");
        if (action !== "reminder.markRead" && action !== "reminder.dismiss") { task.version++; task.updatedAt = now; }
      }
      if (scope.personalTaskCount < 0) throw new Error("Invalid personal quota.");
      let removedParticipantCount = 0;
      if (action === "task.restore" && task.collaboration && context) {
        const active = new Set(context.members.filter(m => m.status === "active").map(m => m.id));
        removedParticipantCount = new Set([...task.collaboration.viewerMembershipIds, ...task.collaboration.helperMembershipIds].filter(id => !active.has(id))).size;
        task.collaboration.viewerMembershipIds = task.collaboration.viewerMembershipIds.filter(id => active.has(id)); task.collaboration.helperMembershipIds = task.collaboration.helperMembershipIds.filter(id => active.has(id));
      }
      if (action !== "reminder.markRead" && action !== "reminder.dismiss") await tx.saveTask(task);
      const receiptOnly = action === "reminder.markRead" || action === "reminder.dismiss";
      if (context && !receiptOnly) { context.family.version++; if (eventKind.startsWith("task.")) context.family.authEpoch++; context.family.updatedAt = now; await tx.saveFamily(context.family); }
      if (receiptOnly) scopeChanged = true;
      if (scopeChanged) { scope.revision++; await tx.saveScope(scope); }
      if (eventKind) await tx.addEvent({ id: eventId, taskId: task.id, occurrenceId: outputOccurrence?.id ?? null, kind: eventKind, actorUserId: actor.id, actorName: member?.name ?? actor.displayName, recordedAt: now, actualCompletedAt: outputOccurrence?.actualCompletedAt ?? null, note: eventNote });
      let result: unknown;
      if (action === "task.delete") result = { id: task.id, version: task.version, deleted: true };
      else if (action === "task.update" && context && !familyTaskRights(task, context, actor.id).canView) result = { id: task.id, version: task.version, updated: true, accessLost: true };
      else if (action === "reminder.markRead" || action === "reminder.dismiss") result = { occurrenceId: candidate ? this.store.deriveOccurrenceId(candidate.identity) : "", ...(action === "reminder.markRead" ? { read: true } : { dismissed: true }) };
      else if (outputOccurrence) result = { occurrence: outputOccurrence, taskVersion: task.version };
      else if (action === "reminder.setMine") {
        const preference = context ? await tx.preference(task.id, actor.id) : null;
        result = { preference: context ? {
          enabled: Boolean(preference?.enabled && !preference.selfDisabled && preference.membershipId === member?.id),
          selfDisabled: preference?.selfDisabled ?? false, version: preference?.version ?? 0
        } : { enabled: task.reminderEnabled && !task.reminderSelfDisabled, selfDisabled: task.reminderSelfDisabled, version: task.reminderVersion } };
      } else {
        const taskDto = await dto(tx, task, context, actor.id);
        if (action === "task.restore") result = { task: taskDto, removedParticipantCount };
        else if (action === "task.pause" || action === "task.stop" || action === "task.setAccess") result = { task: taskDto };
        else {
          const nextOccurrences: OccurrenceDTO[] = [];
          for (const occurrence of nextProjected(task, segment, now)) {
            const state = await tx.occurrenceState(this.store.deriveOccurrenceId(occurrence.identity));
            nextOccurrences.push(projectedDTO(this.store, task, context, actor.id, state ? { ...occurrence, ...state } : occurrence));
          }
          result = { task: taskDto, nextOccurrences };
        }
      }
      await tx.saveReceipt(actor.id, requestId, { fingerprint, taskId: task.id, ...(context ? { familyId: context.family.id, resourceKind: "task" as const } : {}), ...(isPersonalData("task.update", result) && "accessLost" in result ? { minimumConfirmation: true } : {}), result });
      return result;
    });
    if (!isPersonalData(action, result)) throw new Error("Invalid recurrence result."); return result;
  }
}
