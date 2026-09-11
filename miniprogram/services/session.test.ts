import type { ApiResponse, IdentityEnsureData } from "@family-todo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestIdUnavailableError } from "./request-id";
import { IdentitySession } from "./session";

const requestId = "00010203-0405-4607-8809-0a0b0c0d0e0f";
const user = { id: "95855838-6cb6-48b1-94b4-60e41d96cc44", displayName: "我", version: 1 };
const success: ApiResponse<IdentityEnsureData> = { ok: true, requestId, data: { user } };

function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error("Promise is not initialized"); };
  let reject = (_reason: unknown): void => { throw new Error("Promise is not initialized"); };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("身份会话协调", () => {
  it("多个入口共享初始化 Promise，成功后使用不可变的公开用户缓存", async () => {
    const response = deferred<ApiResponse<IdentityEnsureData>>();
    const ensureUser = vi.fn(() => response.promise);
    const generateId = vi.fn(async () => requestId);
    const session = new IdentitySession(ensureUser, generateId);
    expect(session.state).toEqual({ status: "idle" });
    const first = session.ensure();
    expect(session.ensure()).toBe(first);
    expect(session.state).toEqual({ status: "loading" });
    response.resolve(success);
    expect(await first).toEqual(user);
    expect(await session.ensure()).toEqual(user);
    expect(ensureUser).toHaveBeenCalledTimes(1);
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(session.state).toEqual({ status: "ready", user });
    expect(Object.isFrozen(await first)).toBe(true);
  });

  it("网络失败保留请求 ID，手动重试成功，不自动重放", async () => {
    const ensureUser = vi.fn<((id: string) => Promise<ApiResponse<IdentityEnsureData>>)>()
      .mockRejectedValueOnce(new Error("SDK SECRET"))
      .mockResolvedValueOnce(success);
    const generateId = vi.fn(async () => requestId);
    const session = new IdentitySession(ensureUser, generateId);
    await expect(session.ensure()).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(session.state).toMatchObject({ status: "error" });
    expect(ensureUser).toHaveBeenCalledTimes(1);
    expect(await session.ensure()).toEqual(user);
    expect(ensureUser.mock.calls).toEqual([[requestId], [requestId]]);
    expect(generateId).toHaveBeenCalledTimes(1);
  });

  it("服务端身份拒绝保留为错误，不能伪装为空用户或就绪", async () => {
    const error = { code: "UNAUTHENTICATED", message: "请从小程序重新进入。", retryable: false } as const;
    const session = new IdentitySession(async () => ({ ok: false, requestId, error }), async () => requestId);
    await expect(session.ensure()).rejects.toMatchObject(error);
    expect(session.state).toMatchObject({ status: "error", error });
  });

  it("主动刷新重新核验身份，失败立即清除旧用户可用状态", async () => {
    const ensureUser = vi.fn().mockResolvedValueOnce(success).mockRejectedValueOnce(new Error("offline"));
    const generateId = vi.fn().mockResolvedValueOnce(requestId).mockResolvedValueOnce("4071ec6b-e30f-4471-8afc-e46117c8c5c5");
    const session = new IdentitySession(ensureUser, generateId);
    await session.ensure();
    const refresh = session.refresh();
    expect(session.state).toEqual({ status: "loading" });
    expect(session.refresh()).toBe(refresh);
    await expect(refresh).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(session.state).not.toHaveProperty("user");
    expect(generateId).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("失效前发出的旧请求 %s 不得覆盖新会话或清理新请求", async (outcome) => {
    const old = deferred<ApiResponse<IdentityEnsureData>>();
    const fresh = deferred<ApiResponse<IdentityEnsureData>>();
    const ensureUser = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const session = new IdentitySession(ensureUser, async () => requestId);
    const first = session.ensure();
    const firstResult = expect(first).rejects.toMatchObject({ code: "SESSION_INVALIDATED" });
    await vi.waitFor(() => expect(ensureUser).toHaveBeenCalledTimes(1));
    session.invalidate();
    expect(session.state).toEqual({ status: "idle" });
    const second = session.ensure();
    if (outcome === "success") old.resolve(success);
    else old.reject(new Error("late failure"));
    await firstResult;
    expect(session.state).toEqual({ status: "loading" });
    expect(session.ensure()).toBe(second);
    const nextUser = { ...user, id: "b6fc558c-9a52-4a37-9947-71792e4485e4" };
    fresh.resolve({ ...success, data: { user: nextUser } });
    await expect(second).resolves.toEqual(nextUser);
    expect(session.state).toEqual({ status: "ready", user: nextUser });
  });

  it("生成 UUID 期间失效，不再发出旧会话的云请求", async () => {
    const random = deferred<string>();
    const ensureUser = vi.fn();
    const session = new IdentitySession(ensureUser, () => random.promise);
    const first = session.ensure();
    session.invalidate();
    random.resolve(requestId);
    await expect(first).rejects.toMatchObject({ code: "SESSION_INVALIDATED" });
    expect(ensureUser).not.toHaveBeenCalled();
    expect(session.state).toEqual({ status: "idle" });
  });

  it("10 秒超时后使用同 ID 重试，迟到的成功不替换重试结果", async () => {
    vi.useFakeTimers();
    const old = deferred<ApiResponse<IdentityEnsureData>>();
    const ensureUser = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(success);
    const generateId = vi.fn(async () => requestId);
    const session = new IdentitySession(ensureUser, generateId);
    const timedOut = expect(session.ensure()).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;
    await expect(session.ensure()).resolves.toEqual(user);
    old.resolve({ ...success, data: { user: { ...user, displayName: "旧响应" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toEqual({ status: "ready", user });
    expect(ensureUser.mock.calls).toEqual([[requestId], [requestId]]);
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("UUID 能力缺失给出升级提示，不请求服务端或记录平台原文", async () => {
    const ensureUser = vi.fn();
    const session = new IdentitySession(ensureUser, async () => { throw new RequestIdUnavailableError(); });
    await expect(session.ensure()).rejects.toMatchObject({ code: "UNSUPPORTED", retryable: false });
    expect(ensureUser).not.toHaveBeenCalled();
  });
});
