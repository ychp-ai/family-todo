import { afterEach, describe, expect, it, vi } from "vitest";
import { loadIdentityStore } from "@family-todo/infra-cloudbase";

import { main } from "./index";

vi.mock("@family-todo/infra-cloudbase", async (importOriginal) => ({
  ...await importOriginal<typeof import("@family-todo/infra-cloudbase")>(),
  loadIdentityStore: vi.fn(),
}));

const request = { apiVersion: 1, action: "identity.ensure", requestId: "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0", payload: {} };
afterEach(() => vi.unstubAllEnvs());

describe("云入口身份发布边界", () => {
  it("缺少可信来源时拒绝业务，健康调用不依赖身份", async () => {
    expect(await main(request)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await main({ ...request, action: "system.health" })).toMatchObject({ ok: true, data: { status: "ok" } });
  });

  it("接受微信附加 userInfo/tcbContext，但绝不据此认证或放宽其他字段", async () => {
    const userInfo = { appId: "wx0123456789abcdef", openId: "forged" };
    const tcbContext = { WX_APPID: "wx0123456789abcdef", WX_OPENID: "forged", TCB_SOURCE: "wx_client" };
    expect(await main({ ...request, userInfo, tcbContext, action: "system.health" })).toMatchObject({ ok: true });
    expect(await main({ ...request, userInfo, tcbContext })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await main({ ...request, userInfo, tcbContext, role: "owner" })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("客户端不能将 context 放进 event 冒充平台身份", async () => {
    expect(await main({ ...request, context: { environment: "{}" } })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("尚未完成平台验收时不打开业务写入", async () => {
    vi.stubEnv("FAMILY_TODO_APP_ID", "wx0123456789abcdef");
    vi.stubEnv("FAMILY_TODO_IDENTITY_ENABLED", "false");
    const context = { environment: JSON.stringify({ WX_APPID: "wx0123456789abcdef", WX_OPENID: "user-a", TCB_SOURCE: "wx_client" }) };
    expect(await main(request, context)).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR", retryable: true } });
    expect(await main({ ...request, action: "family.list" }, context)).toMatchObject({ ok: false, error: { code: "TEMPORARILY_UNAVAILABLE", retryable: true } });
    expect(loadIdentityStore).not.toHaveBeenCalled();
  });

  it("并发请求分别绑定自己的身份，随后无身份调用不能继承", async () => {
    vi.stubEnv("FAMILY_TODO_APP_ID", "wx0123456789abcdef");
    vi.stubEnv("FAMILY_TODO_IDENTITY_ENABLED", "true");
    vi.mocked(loadIdentityStore).mockImplementation(async (identity) => {
      // 跨过异步边界，模拟两个请求在等待存储时交错。
      await Promise.resolve();
      return { ensureUser: async (candidate) => ({ ...candidate, displayName: identity.subject }) };
    });
    const context = (subject: string) => ({ environment: JSON.stringify({
      WX_APPID: "wx0123456789abcdef", WX_OPENID: subject, TCB_SOURCE: "wx_client",
    }) });
    const [first, second] = await Promise.all([main(request, context("user-a")), main(request, context("user-b"))]);
    expect(first).toMatchObject({ ok: true, data: { user: { displayName: "user-a" } } });
    expect(second).toMatchObject({ ok: true, data: { user: { displayName: "user-b" } } });
    expect(await main(request, {})).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(loadIdentityStore).toHaveBeenCalledTimes(2);
  });
});
