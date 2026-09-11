import { expect, it, vi } from "vitest";

import { initializeCloud } from "./cloud-runtime";

it("未配置环境时不接触微信 SDK", () => {
  expect(initializeCloud({ cloudbaseEnvId: "", apiFunctionName: "api" })).toBe("unconfigured");
});

it("使用指定环境初始化且不默认开启用户追踪", () => {
  const init = vi.fn();
  vi.stubGlobal("wx", { cloud: { init } });
  expect(initializeCloud({ cloudbaseEnvId: "test-env", apiFunctionName: "api" })).toBe("ready");
  expect(init).toHaveBeenCalledWith({ env: "test-env", traceUser: false });
});

it.each([{}, { cloud: { init: () => { throw new Error("SDK unavailable"); } } }])("缺少或无法初始化 SDK 时不让 App 崩溃", (wxMock) => {
  vi.stubGlobal("wx", wxMock);
  expect(initializeCloud({ cloudbaseEnvId: "test-env", apiFunctionName: "api" })).toBe("unavailable");
});
