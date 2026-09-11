import { describe, expect, it } from "vitest";

import { isIdentityEnsureData, isIdentityEnsurePayload } from "./identity";

const user = { id: "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0", displayName: "我", version: 1 };

describe("身份初始化契约", () => {
  it("接受空参数及最小公开用户", () => {
    expect(isIdentityEnsurePayload({})).toBe(true);
    expect(isIdentityEnsureData({ user })).toBe(true);
    expect(isIdentityEnsureData({ user: { ...user, displayName: "😀".repeat(12) } })).toBe(true);
  });

  it.each([null, [], "", { userId: user.id }, { role: "owner" }, { openid: "fake" }])("拒绝身份声明和非对象 %j", (payload) => {
    expect(isIdentityEnsurePayload(payload)).toBe(false);
  });

  it.each([
    null, {}, { user: null }, { user, openid: "secret" },
    { user: { ...user, _openid: "secret" } }, { user: { ...user, id: "openid" } },
    { user: { ...user, displayName: " " } }, { user: { ...user, displayName: " 我" } },
    { user: { ...user, displayName: "😀".repeat(13) } },
    ...[0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((version) => ({ user: { ...user, version } })),
  ])("拒绝非法用户和内部字段 %j", (value) => {
    expect(isIdentityEnsureData(value)).toBe(false);
  });
});
