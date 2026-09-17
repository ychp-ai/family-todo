import type { OccurrenceDTO, OccurrenceRef, TaskDTO, TaskSummaryDTO } from "@family-todo/contracts";
import { familyTaskRights, occurrenceSlot, scheduledInstant } from "@family-todo/domain";
import type { CollaborativeTask, TaskListSource, FamilyContext, Membership, ReminderPreference } from "@family-todo/domain";
import type { FamilyStore, FamilyTransaction } from "@family-todo/ports";
import { ApplicationError } from "./errors";

export function taskMissing(): never { throw new ApplicationError("NOT_FOUND", "事项不存在或你已无权查看。"); }
export function taskInvalid(message: string): never { throw new ApplicationError("INVALID_STATE", message); }
export function taskVersion(actual: number, expected: number): void { if (actual !== expected) throw new ApplicationError("VERSION_CONFLICT", "家人刚刚更新了这件事，请刷新后重试。草稿会为你保留。"); }
export function checkTaskRef(task: CollaborativeTask, ref: OccurrenceRef): void {
  if (ref.id !== task.occurrenceId || ref.taskId !== task.id || ref.segmentId !== task.segmentId || ref.localDate !== task.date || ref.slot !== occurrenceSlot(task)) taskMissing();
}
export async function taskContext(store: FamilyStore, task: TaskListSource, roster?: FamilyContext, actorId?: string, historicalMembershipIds?: string[]): Promise<FamilyContext> {
  const binding = task.collaboration; if (!binding) taskMissing();
  const ids = [binding.creatorMembershipId, ...(binding.ownerBinding.kind === "membership" ? [binding.ownerBinding.membershipId] : [])];
  // Only reuse a roster containing both active bindings. Historical successor chains
  // still use the store's validated loader; each task gets its own historical metadata.
  const base = roster?.family.id === binding.familyId && ids.every(id => roster.members.some(member => member.id === id && member.status === "active"))
    ? roster : await store.context(binding.familyId, ids);
  if (!base) taskMissing();
  const context: FamilyContext = { family: base.family, members: base.members, virtualMembers: base.virtualMembers };
  if (task.recurrence) {
    context.historicalTaskId = task.id;
    // The validated roster bounds this fan-out to at most 20 active members.
    const members = context.members.filter(member => member.status === "active" && (actorId === undefined || member.userId === actorId));
    context.historicalSubjectMembershipIds = historicalMembershipIds ?? await store.historicalSubjects(task.id, members.map(member => member.id));
  }
  return context;
}
export async function verifyContext(tx: FamilyTransaction, context: FamilyContext, actorId: string): Promise<Membership> {
  const family = await tx.family(context.family.id); if (!family) taskMissing();
  taskVersion(family.version, context.family.version);
  const slot = await tx.slot(family.id, actorId);
  const actor = context.members.find(member => member.id === slot?.activeMembershipId && member.userId === actorId && member.status === "active");
  if (!actor) taskMissing(); return actor;
}
export function occurrenceDTO(task: CollaborativeTask, canRecord: boolean): OccurrenceDTO {
  return { id: task.occurrenceId, taskId: task.id, segmentId: task.segmentId, localDate: task.date, slot: occurrenceSlot(task),
    subject: task.collaboration?.occurrenceSnapshot?.subject ?? task.collaboration?.subject ?? { kind: "user", userId: task.ownerUserId }, subjectName: task.collaboration?.occurrenceSnapshot?.subjectName ?? task.collaboration?.subjectName ?? task.ownerName,
    version: task.occurrenceVersion, time: task.time, scheduledAt: scheduledInstant(task), status: task.status,
    actualCompletedAt: task.actualCompletedAt, recordedAt: task.recordedAt, operatorName: task.operatorName, canRecord };
}
export async function familyTaskDTO(tx: FamilyTransaction, task: CollaborativeTask, context: FamilyContext, actorId: string): Promise<TaskDTO> {
  const binding = task.collaboration; if (!binding) taskMissing();
  const rights = familyTaskRights(task, context, actorId); if (!rights.canView) taskMissing();
  const preferences = new Map<string, ReminderPreference | null>();
  for (const member of context.members.filter(member => member.status === "active")) {
    if (rights.manager || member.userId === actorId) preferences.set(member.userId, await tx.preference(task.id, member.userId));
  }
  const mine = preferences.get(actorId);
  const mineEnabled = Boolean(mine?.enabled && !mine.selfDisabled && mine.membershipId === rights.actor?.id);
  const participants: TaskDTO["participants"] = [];
  for (const member of context.members.filter(member => member.status === "active")) {
    const canView = rights.requiredIds.has(member.id) || binding.viewerMembershipIds.includes(member.id);
    if (!rights.manager && !canView) continue;
    const preference = preferences.get(member.userId);
    participants.push({ membershipId: member.id, name: member.name, canView, canHelp: canView && binding.helperMembershipIds.includes(member.id), requiredViewer: rights.requiredIds.has(member.id), isCreatorManager: rights.creator.id === member.id,
      ...(rights.manager || member.userId === actorId ? { receivesReminder: canView && Boolean(preference?.enabled && !preference.selfDisabled && preference.membershipId === member.id), reminderSelfDisabled: preference?.selfDisabled ?? false } : {}) });
  }
  return { ...familyTaskSummary(task, context, actorId), note: task.note, participants,
    myReminder: { enabled: mineEnabled, selfDisabled: mine?.selfDisabled ?? false, version: mine?.version ?? 0 },
    createdAt: task.createdAt, updatedAt: task.updatedAt };
}

export function familyTaskSummary(task: TaskListSource, context: FamilyContext, actorId: string): TaskSummaryDTO {
  const binding = task.collaboration; if (!binding) taskMissing();
  const rights = familyTaskRights(task, context, actorId); if (!rights.canView) taskMissing();
  const active = task.lifecycle !== "deleted";
  const subjectName = binding.subject.kind === "member" ? context.members.find(member => binding.subject.kind === "member" && member.id === binding.subject.membershipId)?.name : context.virtualMembers.find(member => binding.subject.kind === "virtual" && member.id === binding.subject.virtualMemberId)?.name;
  return { id: task.id, version: task.version, title: task.title, familyId: context.family.id, familyName: context.family.name,
    ownerUserId: rights.owner.userId, ownerName: rights.owner.name, createdByUserId: binding.createdByUserId,
    subject: binding.subject, subjectName: subjectName ?? binding.subjectName, schedule: task.recurrence?.schedule ?? { kind: "once", date: task.date, time: task.time }, lifecycle: task.lifecycle,
    capabilities: { canEdit: active && rights.manager, canRecord: rights.canRecord, canShare: active && rights.manager, canDelete: active && rights.manager, canRestore: !active && rights.manager, canResume: rights.manager && task.lifecycle === "paused" && !task.recurrence?.stopped } };
}

export function summarizeTask(task: TaskDTO): TaskSummaryDTO {
  const { note, participants, myReminder, createdAt, updatedAt, ...summary } = task;
  return summary;
}
