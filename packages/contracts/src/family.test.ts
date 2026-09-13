import { describe, expect, it } from "vitest";
import { API_ACTIONS, ERROR_CODES, isApiResponse } from "./api";
import { FAMILY_ACTIONS, isFamilyData, isFamilyPayload } from "./family";
import type { FamilyAction, FamilyActionMap } from "./family";

const id = "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0";
const otherId = "bc9b6a08-4357-4a19-98bb-f1bffef9c4d0";
const now = "2026-09-11T10:00:00.000Z";
const token = "ABCDEFGHIJKLMNOPQRSTUw";
const family = { id, name: "我们家", version: 1, myMembershipId: id, ownerMembershipId: id, authEpoch: 1 };
const member = { id, familyId: id, name: "妈妈", status: "active", role: "owner", version: 1, isMe: true } as const;
const virtual = { id: otherId, familyId: id, name: "小宝", status: "active", version: 1 } as const;
const invitation = { id, familyId: id, version: 1, createdAt: now, expiresAt: now, revokedAt: null };
const exit = { previewToken: "signed-preview", expiresAt: now, familyVersion: 1, targetName: "妈妈", successorName: "爸爸", ownedTaskCount: 1, privateTaskCount: 1, createdManagementCount: 0, virtualTaskCount: 0, otherScopesUnaffected: true } as const;
const transfer = { previewToken: "signed-preview", expiresAt: now, familyVersion: 1, toName: "爸爸", virtualTaskCount: 1 };
const paged = <T>(items: T[]) => ({ items, nextCursor: null, complete: true, asOf: now });
const fixtures = {
  "family.list": { payload: {}, data: paged([{ id, name: "我们家", ownerName: "妈妈", myMembershipId: id, myRole: "owner", version: 1 }]) },
  "family.create": { payload: { name: "我们家", myName: "妈妈" }, data: { family } },
  "family.get": { payload: { id }, data: { family, members: [member], virtualMembers: [virtual] } },
  "family.update": { payload: { id, name: "我们家", expectedVersion: 1 }, data: { family } },
  "member.list": { payload: { familyId: id, status: "left", limit: 50, cursor: "signed" }, data: paged([{ ...member, status: "left", role: "member" }]) },
  "member.rename": { payload: { id, name: "妈妈", expectedVersion: 1 }, data: { member } },
  "invitation.create": { payload: { familyId: id, expectedFamilyVersion: 1 }, data: { id, token, expiresAt: now, version: 1 } },
  "invitation.list": { payload: { familyId: id }, data: paged([invitation]) },
  "invitation.preview": { payload: { token }, data: { familyName: "我们家", inviterName: "妈妈", expiresAt: now, alreadyJoined: false } },
  "invitation.accept": { payload: { token, myName: "爸爸" }, data: { familyId: id, membershipId: id, alreadyJoined: true } },
  "invitation.revoke": { payload: { id, expectedVersion: 1 }, data: { id, version: 2, revoked: true } },
  "virtualMember.list": { payload: { familyId: id, status: "inactive" }, data: paged([{ ...virtual, status: "inactive" }]) },
  "virtualMember.create": { payload: { familyId: id, name: "小宝", expectedFamilyVersion: 1 }, data: { member: virtual } },
  "virtualMember.update": { payload: { id, name: "小宝", expectedVersion: 1 }, data: { member: virtual } },
  "virtualMember.deactivate": { payload: { id, expectedVersion: 1 }, data: { member: { ...virtual, status: "inactive" } } },
  "family.previewExit": { payload: { familyId: id, targetMembershipId: id, mode: "leave" }, data: { preview: exit, complete: true, nextCursor: null } },
  "family.exit": { payload: { familyId: id, targetMembershipId: id, mode: "remove", previewToken: "signed-preview", expectedFamilyVersion: 1 }, data: { familyId: id, exitedMembershipId: id, completed: true } },
  "family.previewTransfer": { payload: { familyId: id, toMembershipId: otherId }, data: { preview: transfer, complete: true, nextCursor: null } },
  "family.transferOwnership": { payload: { familyId: id, toMembershipId: otherId, previewToken: "signed-preview", expectedFamilyVersion: 1 }, data: { id, version: 2, transferred: true } },
} satisfies { [A in FamilyAction]: FamilyActionMap[A] };

describe("家庭协作契约", () => {
  it.each(FAMILY_ACTIONS)("接受 %s 的请求与响应并拒绝额外身份字段", action => {
    expect(isFamilyPayload(action, fixtures[action].payload)).toBe(true);
    expect(isFamilyData(action, fixtures[action].data)).toBe(true);
    for (const key of ["userId", "role", "openid", "actorId"]) {
      expect(isFamilyPayload(action, { ...fixtures[action].payload, [key]: id })).toBe(false);
      expect(isFamilyData(action, { ...fixtures[action].data, [key]: id })).toBe(false);
    }
    expect(isFamilyPayload(action, null)).toBe(false);
    expect(isFamilyData(action, {})).toBe(false);
  });
  it("action 注册完整，两个新增错误码可验证", () => {
    expect(FAMILY_ACTIONS).toHaveLength(19);
    expect(new Set(FAMILY_ACTIONS).size).toBe(Object.keys(fixtures).length);
    expect(FAMILY_ACTIONS.every(action => API_ACTIONS.some(a => a === action))).toBe(true);
    for (const code of ["INVITATION_UNAVAILABLE", "PREVIEW_EXPIRED"]) {
      expect(ERROR_CODES.some(c => c === code)).toBe(true);
      expect(isApiResponse({ ok: false, requestId: id, error: { code, message: "请重试", retryable: false } }, id, isNever)).toBe(true);
    }
  });
  it("邀请只接受22字符base64url，不接受旧32字符口令", () => {
    expect(isFamilyPayload("invitation.preview", { token })).toBe(true);
    for (const invalid of ["a".repeat(32), "a".repeat(21), "a".repeat(23), token + "==", "+".repeat(22), "/".repeat(22), id, ""]) {
      expect(isFamilyPayload("invitation.preview", { token: invalid })).toBe(false);
      expect(isFamilyPayload("invitation.accept", { token: invalid, myName: "爸爸" })).toBe(false);
      expect(isFamilyData("invitation.create", { ...fixtures["invitation.create"].data, token: invalid })).toBe(false);
    }
  });
  it("16字节口令的末位必须是零填充位对应的A、Q、g或w", () => {
    for (const suffix of ["A", "Q", "g", "w"]) {
      const valid = token.slice(0, 21) + suffix;
      expect(isFamilyPayload("invitation.preview", { token: valid })).toBe(true);
      expect(isFamilyPayload("invitation.accept", { token: valid, myName: "爸爸" })).toBe(true);
      expect(isFamilyData("invitation.create", { ...fixtures["invitation.create"].data, token: valid })).toBe(true);
    }
    for (const invalid of ["a".repeat(22), ...["B", "R", "h", "x", "_", "-"].map(suffix => token.slice(0, 21) + suffix)]) {
      expect(isFamilyPayload("invitation.preview", { token: invalid })).toBe(false);
      expect(isFamilyPayload("invitation.accept", { token: invalid, myName: "爸爸" })).toBe(false);
      expect(isFamilyData("invitation.create", { ...fixtures["invitation.create"].data, token: invalid })).toBe(false);
    }
  });
  it("名称按Unicode字符和去首尾空白校验", () => {
    expect(isFamilyPayload("family.create", { name: "😀".repeat(24), myName: "😀".repeat(12) })).toBe(true);
    expect(isFamilyPayload("family.create", { name: "  我们家  ", myName: " 爸爸 " })).toBe(true);
    for (const name of ["", "  ", "😀".repeat(25)]) expect(isFamilyPayload("family.create", { name, myName: "妈妈" })).toBe(false);
    for (const name of ["", "😀".repeat(13)]) expect(isFamilyPayload("member.rename", { id, expectedVersion: 1, name })).toBe(false);
  });
  it("严格校验版本、应用ID、成员种类和公开隐私形状", () => {
    for (const expectedVersion of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(isFamilyPayload("family.update", { id, name: "家", expectedVersion })).toBe(false);
    expect(isFamilyPayload("family.get", { id: "openid" })).toBe(false);
    expect(isFamilyPayload("member.list", { familyId: id, status: "inactive" })).toBe(false);
    expect(isFamilyPayload("virtualMember.list", { familyId: id, status: "left" })).toBe(false);
    expect(isFamilyData("member.rename", { member: { ...member, userId: id } })).toBe(false);
    expect(isFamilyData("member.rename", { member: { ...member, status: "left" } })).toBe(false);
    expect(isFamilyData("family.create", { family: { ...family, authEpoch: 0 } })).toBe(false);
    expect(isFamilyData("virtualMember.create", { member })).toBe(false);
    for (const key of ["token", "tokenHash", "_openid"]) expect(isFamilyData("invitation.list", paged([{ ...invitation, [key]: token }]))).toBe(false);
    expect(isFamilyData("family.get", { family, members: [{ ...member, familyId: otherId }], virtualMembers: [] })).toBe(false);
    expect(isFamilyData("family.get", { family, members: [{ ...member, status: "left", role: "member" }], virtualMembers: [] })).toBe(false);
    expect(isFamilyData("family.get", { family, members: [], virtualMembers: Array.from({ length: 21 }, () => virtual) })).toBe(false);
  });
  it("分页和预览完整性有明确边界", () => {
    for (const limit of [0, 51, 1.5, "20"]) expect(isFamilyPayload("family.list", { limit })).toBe(false);
    for (const cursor of ["", null, "a".repeat(2049)]) expect(isFamilyPayload("family.list", { cursor })).toBe(false);
    expect(isFamilyPayload("family.list", { limit: 1, cursor: "a".repeat(2048) })).toBe(true);
    expect(isFamilyData("family.list", { ...paged([]), complete: false, nextCursor: "continue" })).toBe(true);
    expect(isFamilyData("family.list", { ...paged([]), complete: false })).toBe(false);
    expect(isFamilyData("family.list", { ...paged([]), nextCursor: "unexpected" })).toBe(false);
    expect(isFamilyData("family.list", { ...paged([]), asOf: "2026-02-30T10:00:00.000Z" })).toBe(false);
    for (const action of ["family.previewExit", "family.previewTransfer"] as const) {
      expect(isFamilyData(action, { preview: null, complete: false, nextCursor: "continue" })).toBe(true);
      expect(isFamilyData(action, { preview: null, complete: true, nextCursor: null })).toBe(false);
      expect(isFamilyData(action, { ...fixtures[action].data, complete: false, nextCursor: "continue" })).toBe(false);
    }
    expect(isFamilyData("family.previewExit", { preview: { ...exit, title: "秘密事项" }, complete: true, nextCursor: null })).toBe(false);
    expect(isFamilyData("family.previewExit", { preview: { ...exit, ownedTaskCount: -1 }, complete: true, nextCursor: null })).toBe(false);
    expect(isFamilyPayload("family.exit", { ...fixtures["family.exit"].payload, previewToken: "a".repeat(2049) })).toBe(false);
  });
});
function isNever(_v: unknown): _v is never { return false; }
