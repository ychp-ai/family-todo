import { instant, integer, isRecord, isResolvedSubject, isUuid, text } from "@family-todo/contracts";
import type { CollaborativeTask, Family, FamilyTaskContext, Invitation, Membership, MembershipSlot, ReminderPreference, ReminderReceipt, VirtualMember } from "@family-todo/domain";
import { readPersonalTask } from "./personal-store";

function bad(): never { throw new Error("Invalid collaboration storage record."); }
function base(v: unknown): v is Record<string, unknown> & { id: string; version: number; createdAt: string; updatedAt: string } {
  return isRecord(v) && isUuid(v.id) && integer(v.version, 1) && instant(v.createdAt) && instant(v.updatedAt);
}
function nullableId(v: unknown): v is string | null { return v === null || isUuid(v); }
function nullableInstant(v: unknown): v is string | null { return v === null || instant(v); }
function ids(v: unknown): v is string[] { return Array.isArray(v) && v.length <= 20 && v.every(isUuid) && new Set(v).size === v.length; }
export function readFamily(v: unknown): Family {
  if (!base(v) || !text(v.name, 1, 24) || !isUuid(v.ownerMembershipId) || !integer(v.authEpoch, 1)
    || !integer(v.taskCount) || v.taskCount > 500 || !integer(v.memberCount, 1) || v.memberCount > 20 || !integer(v.virtualMemberCount) || v.virtualMemberCount > 20) bad();
  return { id: v.id, name: v.name, ownerMembershipId: v.ownerMembershipId, version: v.version, authEpoch: v.authEpoch, taskCount: v.taskCount, memberCount: v.memberCount, virtualMemberCount: v.virtualMemberCount, createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function readMembership(v: unknown): Membership {
  if (!base(v) || !isUuid(v.familyId) || !isUuid(v.userId) || !text(v.name, 1, 12) || !["active", "left", "removed"].includes(String(v.status)) || !nullableId(v.successorMembershipId)) bad();
  if (v.status !== "active" && v.status !== "left" && v.status !== "removed") bad();
  if ((v.status === "active") !== (v.successorMembershipId === null)) bad();
  return { id: v.id, familyId: v.familyId, userId: v.userId, name: v.name, status: v.status, successorMembershipId: v.successorMembershipId, version: v.version, createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function readSlot(v: unknown): MembershipSlot {
  if (!isRecord(v) || !isUuid(v.familyId) || !isUuid(v.userId) || !nullableId(v.activeMembershipId)) bad();
  return { familyId: v.familyId, userId: v.userId, activeMembershipId: v.activeMembershipId };
}
export function readVirtual(v: unknown): VirtualMember {
  if (!base(v) || !isUuid(v.familyId) || !text(v.name, 1, 12) || (v.status !== "active" && v.status !== "inactive")) bad();
  return { id: v.id, familyId: v.familyId, name: v.name, status: v.status, version: v.version, createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function readInvitation(v: unknown): Invitation {
  if (!base(v) || !isUuid(v.familyId) || !isUuid(v.createdBy) || typeof v.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(v.tokenHash) || !instant(v.expiresAt) || !nullableInstant(v.revokedAt)) bad();
  return { id: v.id, familyId: v.familyId, tokenHash: v.tokenHash, createdBy: v.createdBy, version: v.version, createdAt: v.createdAt, updatedAt: v.updatedAt, expiresAt: v.expiresAt, revokedAt: v.revokedAt };
}
export function readPreference(v: unknown): ReminderPreference {
  if (!isRecord(v) || !isUuid(v.taskId) || !isUuid(v.userId) || !nullableId(v.membershipId) || typeof v.enabled !== "boolean" || typeof v.selfDisabled !== "boolean" || !integer(v.version, 1) || (v.enabled && v.selfDisabled)) bad();
  return { taskId: v.taskId, userId: v.userId, membershipId: v.membershipId, enabled: v.enabled, selfDisabled: v.selfDisabled, version: v.version };
}
export function readReminderReceipt(v: unknown): ReminderReceipt {
  if (!isRecord(v) || !isUuid(v.occurrenceId) || !isUuid(v.userId) || !nullableInstant(v.readAt) || !nullableInstant(v.dismissedAt) || !integer(v.version, 1)) bad();
  return { occurrenceId: v.occurrenceId, userId: v.userId, readAt: v.readAt, dismissedAt: v.dismissedAt, version: v.version };
}
function readTaskContext(v: unknown): FamilyTaskContext {
  if (!isRecord(v) || !isUuid(v.familyId) || !isUuid(v.creatorMembershipId) || !isUuid(v.createdByUserId) || !isRecord(v.ownerBinding) || !isRecord(v.subject) || !text(v.subjectName, 1, 12) || !ids(v.viewerMembershipIds) || !ids(v.helperMembershipIds)) bad();
  const owner = v.ownerBinding; const subject = v.subject;
  const ownerBinding = owner.kind === "familyOwner" ? { kind: "familyOwner" as const } : owner.kind === "membership" && isUuid(owner.membershipId) ? { kind: "membership" as const, membershipId: owner.membershipId } : bad();
  const resolvedSubject = subject.kind === "member" && isUuid(subject.membershipId) ? { kind: "member" as const, membershipId: subject.membershipId } : subject.kind === "virtual" && isUuid(subject.virtualMemberId) ? { kind: "virtual" as const, virtualMemberId: subject.virtualMemberId } : bad();
  const snapshot = v.occurrenceSnapshot;
  if (snapshot !== undefined && (!isRecord(snapshot) || !isResolvedSubject(snapshot.subject) || !text(snapshot.subjectName, 1, 12))) bad();
  const occurrenceSnapshot = isRecord(snapshot) && isResolvedSubject(snapshot.subject) && typeof snapshot.subjectName === "string" ? { subject: snapshot.subject, subjectName: snapshot.subjectName } : undefined;
  return { ...(occurrenceSnapshot ? { occurrenceSnapshot } : {}), familyId: v.familyId, creatorMembershipId: v.creatorMembershipId, createdByUserId: v.createdByUserId, ownerBinding, subject: resolvedSubject, subjectName: v.subjectName, viewerMembershipIds: v.viewerMembershipIds, helperMembershipIds: v.helperMembershipIds };
}
export function readCollaborativeTask(v: unknown): CollaborativeTask {
  const task = readPersonalTask(v);
  if (!isRecord(v)) bad();
  if (v.collaboration === undefined) return task;
  const collaboration = readTaskContext(v.collaboration);
  if (v.familyId !== collaboration.familyId) bad();
  return { ...task, collaboration };
}
