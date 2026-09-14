import type { AccessInput, TaskDraft } from "@family-todo/contracts";
import { familyTaskRights } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext, FamilySubject } from "@family-todo/domain";
import type { FamilyTransaction } from "@family-todo/ports";
import { taskInvalid, taskMissing } from "./task-context";

export function resolveTaskSubject(draft: TaskDraft, context: FamilyContext, actorId: string, old?: CollaborativeTask): { subject: FamilySubject; name: string } {
  const actor = context.members.find(member => member.userId === actorId && member.status === "active"); if (!actor) taskMissing();
  const chosen: FamilySubject = draft.subject.kind === "self" ? { kind: "member", membershipId: actor.id } : draft.subject;
  const previous = old?.collaboration;
  const unchanged = previous && JSON.stringify(previous.subject) === JSON.stringify(chosen);
  if (chosen.kind === "member") {
    const member = context.members.find(member => member.id === chosen.membershipId && member.status === "active");
    if (member) return { subject: chosen, name: member.name };
  } else {
    const member = context.virtualMembers.find(member => member.id === chosen.virtualMemberId && member.status === "active");
    if (member) return { subject: chosen, name: member.name };
  }
  if (unchanged) return { subject: chosen, name: previous.subjectName };
  taskInvalid("执行人已不在当前家庭，请重新选择。");
}
export async function setTaskAccess(tx: FamilyTransaction, task: CollaborativeTask, context: FamilyContext, actorId: string, access: AccessInput): Promise<void> {
  const binding = task.collaboration; if (!binding) taskMissing();
  const rights = familyTaskRights(task, context, actorId); if (!rights.actor) taskMissing();
  const active = context.members.filter(member => member.status === "active"); const activeIds = new Set(active.map(member => member.id));
  const viewers = new Set([...access.viewerMembershipIds, ...rights.requiredIds].filter(id => activeIds.has(id)));
  if (access.viewerMembershipIds.some(id => !activeIds.has(id)) || [...access.helperMembershipIds, ...access.reminderMembershipIds].some(id => !activeIds.has(id) || !viewers.has(id))) taskInvalid("共享、代记和提醒只能选择本家庭当前可见的真实成员。");
  for (const member of active) {
    const existing = await tx.preference(task.id, member.userId);
    const currentEnabled = Boolean(existing?.enabled && !existing.selfDisabled && existing.membershipId === member.id);
    const desired = member.userId === actorId ? access.remindMe : access.reminderMembershipIds.includes(member.id);
    if (member.userId !== actorId && desired && existing?.selfDisabled) taskInvalid("该成员已自行关闭提醒，需本人开启。");
    const selfDisabled = member.userId === actorId && desired !== currentEnabled ? !desired : existing?.selfDisabled ?? (member.userId === actorId && !desired);
    const enabled = viewers.has(member.id) && desired && !selfDisabled;
    if (existing && existing.enabled === enabled && existing.selfDisabled === selfDisabled && existing.membershipId === member.id) continue;
    if (!existing && !enabled && !selfDisabled) continue;
    await tx.savePreference({ taskId: task.id, userId: member.userId, membershipId: member.id, enabled, selfDisabled, version: (existing?.version ?? 0) + 1 });
  }
  binding.viewerMembershipIds = [...access.viewerMembershipIds]; binding.helperMembershipIds = [...access.helperMembershipIds];
}

/** Batch adapter: append visibility only; caller owns version/receipt/event and transaction fencing. */
export function appendTaskViewers(task: CollaborativeTask, context: FamilyContext, actorId: string, membershipIds: readonly string[]): boolean {
  const binding = task.collaboration;
  if (!binding || binding.familyId !== context.family.id || task.lifecycle === "deleted") taskMissing();
  const rights = familyTaskRights(task, context, actorId);
  if (!rights.canView || !rights.manager) taskMissing();
  const active = new Set(context.members.filter(m => m.status === "active").map(m => m.id));
  if (membershipIds.some(id => !active.has(id))) taskInvalid("只能追加本家庭当前真实成员。");
  const existing = new Set(binding.viewerMembershipIds);
  for (const id of membershipIds) if (!rights.requiredIds.has(id)) existing.add(id);
  if (existing.size > 20) taskInvalid("可见成员超出家庭人数上限。");
  if (existing.size === binding.viewerMembershipIds.length) return false;
  binding.viewerMembershipIds = [...existing]; return true;
}
