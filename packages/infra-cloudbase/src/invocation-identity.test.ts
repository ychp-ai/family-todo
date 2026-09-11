import { afterEach, describe, expect, it, vi } from "vitest";

import { readInvocationIdentity } from "./invocation-identity";

const appId = "wx0123456789abcdef";
const environment = { TCB_SOURCE: "wx_client", WX_APPID: appId, WX_OPENID: "user-a" };

afterEach(() => vi.unstubAllEnvs());

describe("每次请求的可信身份", () => {
  it.each(["wx_client", "wx_devtools"])("接受当前上下文 %s", (source) => {
    expect(readInvocationIdentity({ environment: JSON.stringify({ ...environment, TCB_SOURCE: source }) }, appId)).toEqual({
      provider: "wechat", appId, subject: "user-a",
    });
  });

  it.each([undefined, null, {}, { environment }, { environment: "invalid" }, { environment: "null" },
    { environ: "WX_OPENID=user-a" }, { environment: JSON.stringify({ ...environment, TCB_SOURCE: "wx_http" }) },
    { environment: JSON.stringify({ ...environment, TCB_SOURCE: "wx_client,scf" }) },
    { environment: JSON.stringify({ ...environment, WX_APPID: "wx1111111111111111" }) },
    { environment: JSON.stringify({ ...environment, WX_OPENID: "" }) },
    { environment: JSON.stringify({ ...environment, WX_OPENID: 123 }) },
  ])("拒绝无身份、未知来源或其他小程序 %j", (context) => {
    expect(readInvocationIdentity(context, appId)).toBeNull();
  });

  it("合法调用之后，空上下文不能继承进程残留身份", () => {
    vi.stubEnv("WX_OPENID", "user-a");
    vi.stubEnv("WX_APPID", appId);
    vi.stubEnv("TCB_SOURCE", "wx_client");
    const first = readInvocationIdentity({ environment: JSON.stringify(environment) }, appId);
    expect(first?.subject).toBe("user-a");
    expect(readInvocationIdentity({}, appId)).toBeNull();
    const second = readInvocationIdentity({ environment: JSON.stringify({ ...environment, WX_OPENID: "user-b" }) }, appId);
    expect(second?.subject).toBe("user-b");
    expect(first?.subject).toBe("user-a");
  });

  it("未配置预期 AppID 时关闭身份入口", () => {
    expect(readInvocationIdentity({ environment: JSON.stringify(environment) }, "")).toBeNull();
  });
});
