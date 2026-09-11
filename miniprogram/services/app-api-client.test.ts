import { describe, expect, it, vi } from "vitest";

import { main } from "../../cloudfunctions/api/src/index";
import { isSystemHealthData } from "@family-todo/contracts";
import type { ApiRequest } from "@family-todo/contracts";

import { AppApiClient } from "./app-api-client";
import { CloudFunctionTransport } from "./cloud-transport";

vi.mock("../config/index", () => ({ appConfig: { cloudbaseEnvId: "test-env", apiFunctionName: "api" } }));

const request: ApiRequest = {
  apiVersion: 1, action: "system.health",
  requestId: "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0", payload: {},
};
const health = { status: "ok", service: "api", apiVersion: 1, now: "2026-09-11T00:00:00.000Z" };

describe("客户端与服务端契约", () => {
  it("通过真实路由执行健康请求", async () => {
    const client = new AppApiClient({ send: main });
    expect(await client.call(request, isSystemHealthData)).toMatchObject({
      ok: true, requestId: request.requestId, data: { status: "ok", service: "api" },
    });
  });

  it.each([
    null,
    { ok: true, requestId: request.requestId },
    { ok: true, requestId: "different", data: health },
    { ok: true, requestId: request.requestId, data: { ...health, now: "invalid" } },
    { ok: false, requestId: request.requestId },
    { ok: false, requestId: request.requestId, error: { code: "SDK_PRIVATE_ERROR", message: "internal", retryable: false } },
    { ok: false, requestId: request.requestId, error: { code: "NOT_FOUND", message: "missing" } },
  ])("拒绝不完整或不匹配的响应 %j", async (result) => {
    const client = new AppApiClient({ send: async () => result });
    await expect(client.call(request, isSystemHealthData)).rejects.toThrow("服务响应异常");
  });

  it("保留合法接口错误，去掉额外内部字段", async () => {
    const error = { code: "NOT_FOUND", message: "请求的接口不存在。", retryable: false };
    const client = new AppApiClient({ send: async () => ({ ok: false, requestId: request.requestId, error: { ...error, stack: "private" } }) });
    expect(await client.call(request, isSystemHealthData)).toEqual({ ok: false, requestId: request.requestId, error });
  });
});

describe("微信传输适配", () => {
  it("传递完整 envelope 并拆除 SDK 包装", async () => {
    const callFunction = vi.fn().mockResolvedValue({ result: health });
    vi.stubGlobal("getApp", () => ({ globalData: { cloudStatus: "ready" } }));
    vi.stubGlobal("wx", { cloud: { callFunction } });
    expect(await new CloudFunctionTransport().send(request)).toEqual(health);
    expect(callFunction).toHaveBeenCalledWith({ name: "api", data: request });
  });

  it.each(["unconfigured", "unavailable"])("%s 时不调用云 API", async (cloudStatus) => {
    const callFunction = vi.fn();
    vi.stubGlobal("getApp", () => ({ globalData: { cloudStatus } }));
    vi.stubGlobal("wx", { cloud: { callFunction } });
    await expect(new CloudFunctionTransport().send(request)).rejects.toThrow();
    expect(callFunction).not.toHaveBeenCalled();
  });

  it("网络异常不暴露 SDK 原文", async () => {
    vi.stubGlobal("getApp", () => ({ globalData: { cloudStatus: "ready" } }));
    vi.stubGlobal("wx", { cloud: { callFunction: vi.fn().mockRejectedValue(new Error("SECRET")) } });
    await expect(new CloudFunctionTransport().send(request)).rejects.toThrow("网络连接失败，请稍后重试。");
  });
});
