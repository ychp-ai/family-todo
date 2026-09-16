import { expect, it, vi } from "vitest";

import { initializeCloud } from "./cloud-runtime";

it.each([{}, { cloud: { init: () => { throw new Error("SDK unavailable"); } } }])("缺少或无法初始化 SDK 时不让 App 崩溃", (wxMock) => {
  vi.stubGlobal("wx", wxMock);
  expect(initializeCloud({ cloudbaseEnvId: "test-env", apiFunctionName: "api" })).toBe("unavailable");
});
