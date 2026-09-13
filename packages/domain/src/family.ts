import type { PersonalTask } from "./personal";

export type Family = {
  id: string; name: string; ownerMembershipId: string; version: number; authEpoch: number;
  taskCount: number; memberCount: number; virtualMemberCount: number; createdAt: string; updatedAt: string;
};
export type Membership = {
  id: string; familyId: string; userId: string; name: string; status: "active" | "left" | "removed";
  successorMembershipId: string | null; version: number; createdAt: string; updatedAt: string;
};
export type MembershipSlot = { familyId: string; userId: string; activeMembershipId: string | null };
export type VirtualMember = {
  id: string; familyId: string; name: string; status: "active" | "inactive"; version: number; createdAt: string; updatedAt: string;
};
export type Invitation = {
  id: string; familyId: string; tokenHash: string; createdBy: string; version: number;
  createdAt: string; updatedAt: string; expiresAt: string; revokedAt: string | null;
};
export type FamilyEvent = {
  id: string; familyId: string; kind: string; actorUserId: string; targetMembershipId: string | null;
  recordedAt: string; beforeVersion: number; afterVersion: number;
};
export type FamilySubject = { kind: "member"; membershipId: string } | { kind: "virtual"; virtualMemberId: string };
export type FamilyTaskContext = {
  familyId: string; creatorMembershipId: string; createdByUserId: string;
  ownerBinding: { kind: "membership"; membershipId: string } | { kind: "familyOwner" };
  subject: FamilySubject; subjectName: string;
  occurrenceSnapshot?: { subject: FamilySubject | { kind: "user"; userId: string }; subjectName: string };
  viewerMembershipIds: string[]; helperMembershipIds: string[];
};
/** The optional context preserves the schema-1 personal task layout. */
export type CollaborativeTask = PersonalTask & { collaboration?: FamilyTaskContext };
export type ReminderPreference = {
  taskId: string; userId: string; membershipId: string | null; enabled: boolean; selfDisabled: boolean; version: number;
};
export type ReminderReceipt = { occurrenceId: string; userId: string; readAt: string | null; dismissedAt: string | null; version: number };
/** Includes active members plus only the historical links needed by this operation. */
export type FamilyContext = { family: Family; members: Membership[]; virtualMembers: VirtualMember[] };

export function resolvedMember(context: FamilyContext, membershipId: string): Membership {
  const seen = new Set<string>();
  let id: string | null = membershipId;
  while (id !== null) {
    if (seen.has(id)) throw new Error("Cyclic membership succession.");
    seen.add(id);
    const member = context.members.find(candidate => candidate.id === id);
    if (!member || member.familyId !== context.family.id) throw new Error("Incomplete membership succession.");
    if (member.status === "active") return member;
    id = member.successorMembershipId;
  }
  throw new Error("Missing membership successor.");
}

export function familyTaskRights(task: CollaborativeTask, context: FamilyContext, userId: string) {
  const binding = task.collaboration;
  if (!binding || binding.familyId !== context.family.id) throw new Error("Mismatched task family.");
  const actor = context.members.find(member => member.userId === userId && member.status === "active");
  const owner = resolvedMember(context, binding.ownerBinding.kind === "familyOwner" ? context.family.ownerMembershipId : binding.ownerBinding.membershipId);
  const creator = resolvedMember(context, binding.creatorMembershipId);
  const subjectId = binding.subject.kind === "member" ? binding.subject.membershipId : null;
  const requiredIds = new Set([owner.id, creator.id, ...(subjectId === null ? [] : [subjectId])]);
  const manager = actor !== undefined && (owner.id === actor.id || creator.id === actor.id);
  const canView = actor !== undefined && (requiredIds.has(actor.id) || binding.viewerMembershipIds.includes(actor.id));
  const canRecord = canView && task.lifecycle === "active" && (manager || actor.id === subjectId || binding.helperMembershipIds.includes(actor.id));
  return { actor, owner, creator, requiredIds, manager, canView, canRecord };
}
