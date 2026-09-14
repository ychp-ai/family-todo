import { isUuid } from "./api";
import { exact, instant, integer, nullable, opaque, page, pageInput, text } from "./personal";
import type { Page, PageInput, WriteRef } from "./personal";

export type FamilySummary = { id: string; name: string; ownerName: string; myMembershipId: string; myRole: "owner" | "member"; version: number };
export type FamilyDTO = { id: string; name: string; version: number; myMembershipId: string; ownerMembershipId: string; authEpoch: number };
export type MemberDTO = { id: string; familyId: string; name: string; status: "active" | "left" | "removed"; role: "owner" | "member"; version: number; isMe: boolean };
export type VirtualDTO = { id: string; familyId: string; name: string; status: "active" | "inactive"; version: number };
export type InvitationSummary = { id: string; familyId: string; version: number; createdAt: string; expiresAt: string; revokedAt: string | null };
export type ExitPreview = {
  previewToken: string; expiresAt: string; familyVersion: number; targetName: string; successorName: string;
  ownedTaskCount: number; privateTaskCount: number; createdManagementCount: number; virtualTaskCount: number; otherScopesUnaffected: true;
};
export type TransferPreview = { previewToken: string; expiresAt: string; familyVersion: number; toName: string; virtualTaskCount: number };
export type PreviewResult<T> = { preview: T; complete: true; nextCursor: null } | { preview: null; complete: false; nextCursor: string };
export type ExitInput = { familyId: string; targetMembershipId: string; mode: "leave" | "remove" };
export type TransferInput = { familyId: string; toMembershipId: string };
export type FamilyActionMap = {
  "family.list": { payload: PageInput; data: Page<FamilySummary> };
  "family.create": { payload: { name: string; myName: string }; data: { family: FamilyDTO } };
  "family.get": { payload: { id: string }; data: { family: FamilyDTO; members: MemberDTO[]; virtualMembers: VirtualDTO[] } };
  "family.update": { payload: WriteRef & { name: string }; data: { family: FamilyDTO } };
  "member.list": { payload: PageInput & { familyId: string; status?: MemberDTO["status"] }; data: Page<MemberDTO> };
  "member.rename": { payload: WriteRef & { name: string }; data: { member: MemberDTO } };
  "invitation.create": { payload: { familyId: string; expectedFamilyVersion: number }; data: { id: string; token: string; expiresAt: string; version: number } };
  "invitation.list": { payload: PageInput & { familyId: string }; data: Page<InvitationSummary> };
  "invitation.preview": { payload: { token: string }; data: { familyName: string; inviterName: string; expiresAt: string; alreadyJoined: boolean } };
  "invitation.accept": { payload: { token: string; myName: string }; data: { familyId: string; membershipId: string; alreadyJoined: boolean } };
  "invitation.revoke": { payload: WriteRef; data: { id: string; version: number; revoked: true } };
  "virtualMember.list": { payload: PageInput & { familyId: string; status?: VirtualDTO["status"] }; data: Page<VirtualDTO> };
  "virtualMember.create": { payload: { familyId: string; expectedFamilyVersion: number; name: string }; data: { member: VirtualDTO } };
  "virtualMember.update": { payload: WriteRef & { name: string }; data: { member: VirtualDTO } };
  "virtualMember.deactivate": { payload: WriteRef; data: { member: VirtualDTO } };
  "family.previewExit": { payload: ExitInput & { cursor?: string }; data: PreviewResult<ExitPreview> };
  "family.exit": { payload: ExitInput & { previewToken: string; expectedFamilyVersion: number }; data: { familyId: string; exitedMembershipId: string; completed: true } };
  "family.previewTransfer": { payload: TransferInput & { cursor?: string }; data: PreviewResult<TransferPreview> };
  "family.transferOwnership": { payload: TransferInput & { previewToken: string; expectedFamilyVersion: number }; data: { id: string; version: number; transferred: true } };
};
export const FAMILY_ACTIONS = [
  "family.list", "family.create", "family.get", "family.update", "member.list", "member.rename",
  "invitation.create", "invitation.list", "invitation.preview", "invitation.accept", "invitation.revoke",
  "virtualMember.list", "virtualMember.create", "virtualMember.update", "virtualMember.deactivate",
  "family.previewExit", "family.exit", "family.previewTransfer", "family.transferOwnership",
] as const satisfies readonly (keyof FamilyActionMap)[];
export type FamilyAction = keyof FamilyActionMap;

export function isInvitationToken(v: unknown): v is string { return typeof v === "string" && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(v); }
function memberStatus(v: unknown): v is MemberDTO["status"] { return v === "active" || v === "left" || v === "removed"; }
function virtualStatus(v: unknown): v is VirtualDTO["status"] { return v === "active" || v === "inactive"; }
function role(v: unknown): v is MemberDTO["role"] { return v === "owner" || v === "member"; }
function writeRef(v: Record<string, unknown>): boolean { return isUuid(v.id) && integer(v.expectedVersion, 1); }
function exitInput(v: Record<string, unknown>): boolean { return isUuid(v.familyId) && isUuid(v.targetMembershipId) && (v.mode === "leave" || v.mode === "remove"); }
function transferInput(v: Record<string, unknown>): boolean { return isUuid(v.familyId) && isUuid(v.toMembershipId); }
export function isFamilyPayload<A extends FamilyAction>(action: A, v: unknown): v is FamilyActionMap[A]["payload"] {
  switch (action) {
    case "family.list": return exact(v, [], ["limit", "cursor"]) && pageInput(v);
    case "family.create": return exact(v, ["name", "myName"]) && text(v.name, 1, 24) && text(v.myName, 1, 12);
    case "family.get": return exact(v, ["id"]) && isUuid(v.id);
    case "family.update": return exact(v, ["id", "expectedVersion", "name"]) && writeRef(v) && text(v.name, 1, 24);
    case "member.rename": case "virtualMember.update": return exact(v, ["id", "expectedVersion", "name"]) && writeRef(v) && text(v.name, 1, 12);
    case "member.list": return exact(v, ["familyId"], ["status", "limit", "cursor"]) && isUuid(v.familyId) && pageInput(v) && (v.status === undefined || memberStatus(v.status));
    case "virtualMember.list": return exact(v, ["familyId"], ["status", "limit", "cursor"]) && isUuid(v.familyId) && pageInput(v) && (v.status === undefined || virtualStatus(v.status));
    case "invitation.list": return exact(v, ["familyId"], ["limit", "cursor"]) && isUuid(v.familyId) && pageInput(v);
    case "invitation.create": return exact(v, ["familyId", "expectedFamilyVersion"]) && isUuid(v.familyId) && integer(v.expectedFamilyVersion, 1);
    case "invitation.preview": return exact(v, ["token"]) && isInvitationToken(v.token);
    case "invitation.accept": return exact(v, ["token", "myName"]) && isInvitationToken(v.token) && text(v.myName, 1, 12);
    case "invitation.revoke": case "virtualMember.deactivate": return exact(v, ["id", "expectedVersion"]) && writeRef(v);
    case "virtualMember.create": return exact(v, ["familyId", "expectedFamilyVersion", "name"]) && isUuid(v.familyId) && integer(v.expectedFamilyVersion, 1) && text(v.name, 1, 12);
    case "family.previewExit": return exact(v, ["familyId", "targetMembershipId", "mode"], ["cursor"]) && exitInput(v) && (v.cursor === undefined || opaque(v.cursor));
    case "family.exit": return exact(v, ["familyId", "targetMembershipId", "mode", "previewToken", "expectedFamilyVersion"]) && exitInput(v) && opaque(v.previewToken) && integer(v.expectedFamilyVersion, 1);
    case "family.previewTransfer": return exact(v, ["familyId", "toMembershipId"], ["cursor"]) && transferInput(v) && (v.cursor === undefined || opaque(v.cursor));
    case "family.transferOwnership": return exact(v, ["familyId", "toMembershipId", "previewToken", "expectedFamilyVersion"]) && transferInput(v) && opaque(v.previewToken) && integer(v.expectedFamilyVersion, 1);
  }
  return false;
}
export function isFamilySummary(v: unknown): v is FamilySummary {
  return exact(v, ["id", "name", "ownerName", "myMembershipId", "myRole", "version"]) && isUuid(v.id)
    && text(v.name, 1, 24) && text(v.ownerName, 1, 12) && isUuid(v.myMembershipId) && role(v.myRole) && integer(v.version, 1);
}
export function isFamilyDTO(v: unknown): v is FamilyDTO {
  return exact(v, ["id", "name", "version", "myMembershipId", "ownerMembershipId", "authEpoch"]) && isUuid(v.id)
    && text(v.name, 1, 24) && integer(v.version, 1) && isUuid(v.myMembershipId) && isUuid(v.ownerMembershipId) && integer(v.authEpoch, 1);
}
export function isMemberDTO(v: unknown): v is MemberDTO {
  return exact(v, ["id", "familyId", "name", "status", "role", "version", "isMe"]) && isUuid(v.id) && isUuid(v.familyId)
    && text(v.name, 1, 12) && memberStatus(v.status) && role(v.role) && (v.status === "active" || v.role === "member")
    && integer(v.version, 1) && typeof v.isMe === "boolean";
}
export function isVirtualDTO(v: unknown): v is VirtualDTO {
  return exact(v, ["id", "familyId", "name", "status", "version"]) && isUuid(v.id) && isUuid(v.familyId)
    && text(v.name, 1, 12) && virtualStatus(v.status) && integer(v.version, 1);
}
export function isInvitationSummary(v: unknown): v is InvitationSummary {
  return exact(v, ["id", "familyId", "version", "createdAt", "expiresAt", "revokedAt"]) && isUuid(v.id) && isUuid(v.familyId)
    && integer(v.version, 1) && instant(v.createdAt) && instant(v.expiresAt) && nullable(v.revokedAt, instant);
}
export function isExitPreview(v: unknown): v is ExitPreview {
  return exact(v, ["previewToken", "expiresAt", "familyVersion", "targetName", "successorName", "ownedTaskCount", "privateTaskCount", "createdManagementCount", "virtualTaskCount", "otherScopesUnaffected"])
    && opaque(v.previewToken) && instant(v.expiresAt) && integer(v.familyVersion, 1) && text(v.targetName, 1, 12) && text(v.successorName, 1, 12)
    && integer(v.ownedTaskCount) && integer(v.privateTaskCount) && integer(v.createdManagementCount) && integer(v.virtualTaskCount) && v.otherScopesUnaffected === true;
}
export function isTransferPreview(v: unknown): v is TransferPreview {
  return exact(v, ["previewToken", "expiresAt", "familyVersion", "toName", "virtualTaskCount"]) && opaque(v.previewToken)
    && instant(v.expiresAt) && integer(v.familyVersion, 1) && text(v.toName, 1, 12) && integer(v.virtualTaskCount);
}
function previewResult(v: unknown, guard: (v: unknown) => boolean): boolean {
  return exact(v, ["preview", "complete", "nextCursor"])
    && ((v.complete === true && v.nextCursor === null && guard(v.preview)) || (v.complete === false && v.preview === null && opaque(v.nextCursor)));
}
export function isFamilyData<A extends FamilyAction>(action: A, v: unknown): v is FamilyActionMap[A]["data"] {
  switch (action) {
    case "family.list": return page(v, isFamilySummary);
    case "family.create": case "family.update": return exact(v, ["family"]) && isFamilyDTO(v.family);
    case "family.get": {
      if (!exact(v, ["family", "members", "virtualMembers"]) || !isFamilyDTO(v.family)) return false;
      const familyId = v.family.id;
      return Array.isArray(v.members) && v.members.length <= 20 && v.members.every(m => isMemberDTO(m) && m.status === "active" && m.familyId === familyId)
        && Array.isArray(v.virtualMembers) && v.virtualMembers.length <= 20 && v.virtualMembers.every(m => isVirtualDTO(m) && m.status === "active" && m.familyId === familyId);
    }
    case "member.list": return page(v, isMemberDTO);
    case "member.rename": return exact(v, ["member"]) && isMemberDTO(v.member);
    case "virtualMember.list": return page(v, isVirtualDTO);
    case "virtualMember.create": case "virtualMember.update": return exact(v, ["member"]) && isVirtualDTO(v.member);
    case "virtualMember.deactivate": return exact(v, ["member"]) && isVirtualDTO(v.member) && v.member.status === "inactive";
    case "invitation.create": return exact(v, ["id", "token", "expiresAt", "version"]) && isUuid(v.id) && isInvitationToken(v.token) && instant(v.expiresAt) && integer(v.version, 1);
    case "invitation.list": return page(v, isInvitationSummary);
    case "invitation.preview": return exact(v, ["familyName", "inviterName", "expiresAt", "alreadyJoined"]) && text(v.familyName, 1, 24) && text(v.inviterName, 1, 12) && instant(v.expiresAt) && typeof v.alreadyJoined === "boolean";
    case "invitation.accept": return exact(v, ["familyId", "membershipId", "alreadyJoined"]) && isUuid(v.familyId) && isUuid(v.membershipId) && typeof v.alreadyJoined === "boolean";
    case "invitation.revoke": return exact(v, ["id", "version", "revoked"]) && isUuid(v.id) && integer(v.version, 1) && v.revoked === true;
    case "family.previewExit": return previewResult(v, isExitPreview);
    case "family.exit": return exact(v, ["familyId", "exitedMembershipId", "completed"]) && isUuid(v.familyId) && isUuid(v.exitedMembershipId) && v.completed === true;
    case "family.previewTransfer": return previewResult(v, isTransferPreview);
    case "family.transferOwnership": return exact(v, ["id", "version", "transferred"]) && isUuid(v.id) && integer(v.version, 1) && v.transferred === true;
  }
  return false;
}
