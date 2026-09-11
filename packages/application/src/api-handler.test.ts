import { describe, expect, it } from "vitest";

import { createApiHandler } from "./api-handler";
import { ActionRouter } from "./router";
import { SystemHealthHandler } from "./system-health";

const request = {
  apiVersion: 1,
  action: "system.health",
  requestId: "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0",
  payload: {},
};

function createHandler() {
  const router = new ActionRouter();
  router.register(new SystemHealthHandler({ now: () => new Date("2026-09-11T00:00:00.000Z") }));
  return createApiHandler(router);
}

describe("统一 API 入口", () => {
  it("使用注入时钟返回健康结果并保留请求 ID", async () => {
    expect(await createHandler()(request)).toEqual({
      ok: true,
      requestId: request.requestId,
      data: { status: "ok", service: "api", apiVersion: 1, now: "2026-09-11T00:00:00.000Z" },
    });
  });

  it.each([null, [], {}, { ...request, apiVersion: 2 }, { ...request, requestId: "invalid" },
    { apiVersion: 1, action: "system.health", requestId: request.requestId }])(
    "拒绝非法请求 %j", async (event) => {
      expect(await createHandler()(event)).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR", retryable: false } });
    },
  );

  it("非法 requestId 不反射到响应", async () => {
    expect(await createHandler()({ ...request, requestId: "private-user-text" })).toMatchObject({ requestId: "unknown" });
  });

  it.each([null, [], "", { extra: true }])("拒绝健康检查的非空或非法参数 %j", async (payload) => {
    expect(await createHandler()({ ...request, payload })).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("未注册 action 返回稳定错误", async () => {
    expect(await createHandler()({ ...request, action: "todo.create" })).toMatchObject({
      ok: false, requestId: request.requestId, error: { code: "NOT_FOUND" },
    });
  });

  it("禁止覆盖已注册路由", () => {
    const router = new ActionRouter();
    const handler = new SystemHealthHandler({ now: () => new Date() });
    router.register(handler);
    expect(() => router.register(handler)).toThrow("already registered");
  });

  it("隐藏内部异常和堆栈", async () => {
    const router = new ActionRouter();
    router.register(new SystemHealthHandler({ now: () => { throw new Error("SECRET: internal SDK error"); } }));
    const response = await createApiHandler(router)(request);
    expect(response).toEqual({
      ok: false, requestId: request.requestId,
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。", retryable: true },
    });
    expect(JSON.stringify(response)).not.toContain("SECRET");
  });
});
