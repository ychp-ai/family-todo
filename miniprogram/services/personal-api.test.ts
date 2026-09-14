import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "@family-todo/contracts";
import { AppApiClient } from "./app-api-client";
import { PersonalApi } from "./personal-api";

const payload = { id: randomUUID(), expectedVersion: 1 };
function success(request: ApiRequest) {
  return { ok: true, requestId: request.requestId, data: { id: payload.id, version: 2, deleted: true } };
}
afterEach(() => vi.useRealTimers());

describe("个人事项客户端写入重试", () => {
  it("响应丢失后重试保留原 requestId，成功后新操作使用新 ID", async () => {
    const requests: ApiRequest[] = [];
    const api = new PersonalApi(new AppApiClient({ send: async request => {
      requests.push(request);
      if (requests.length === 1) throw new Error("connection lost after commit");
      return success(request);
    } }), async () => randomUUID());
    await expect(api.write("task.delete", payload)).rejects.toMatchObject({ retryable: true });
    await expect(api.write("task.delete", payload)).resolves.toMatchObject({ deleted: true });
    await api.write("task.delete", payload);
    expect(requests[1]?.requestId).toBe(requests[0]?.requestId);
    expect(requests[2]?.requestId).not.toBe(requests[1]?.requestId);
  });

  it("超时后的迟到响应不释放未确认请求，重试仍使用原 ID", async () => {
    vi.useFakeTimers();
    const requests: ApiRequest[] = [];
    let finish: ((value: unknown) => void) | undefined;
    const api = new PersonalApi(new AppApiClient({ send: request => {
      requests.push(request);
      return requests.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(success(request));
    } }), async () => randomUUID());
    const first = expect(api.write("task.delete", payload)).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    await vi.advanceTimersByTimeAsync(10000);
    await first;
    const original = requests[0];
    if (!original || !finish) throw new Error("Expected first request.");
    finish(success(original));
    await Promise.resolve();
    await api.write("task.delete", payload);
    expect(requests[1]?.requestId).toBe(original.requestId);
  });

  it("确定的业务拒绝结束当前意图，后续修改使用新 ID", async () => {
    const requests: ApiRequest[] = [];
    const api = new PersonalApi(new AppApiClient({ send: async request => {
      requests.push(request);
      return { ok: false, requestId: request.requestId, error: { code: "VERSION_CONFLICT", message: "已更新", retryable: false } };
    } }), async () => randomUUID());
    await expect(api.write("task.delete", payload)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(api.write("task.delete", payload)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
  });
});

it("shares only in-flight reads and separates account generations", async () => {
  const requests: ApiRequest[] = []; let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = new PersonalApi(new AppApiClient({ send: async request => {
    requests.push(request); await gate;
    return { ok: true, requestId: request.requestId, data: { items: [], nextCursor: null, complete: true, asOf: "2026-09-14T00:00:00.000Z" } };
  } }), async () => randomUUID());
  api.bindRecovery("env", randomUUID());
  const a = api.read("family.list", { limit: 50 }); const b = api.read("family.list", { limit: 50 });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  api.bindRecovery("env", randomUUID());
  const c = api.read("family.list", { limit: 50 });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  release?.(); await Promise.all([a,b,c]);
  await api.read("family.list", { limit: 50 }); expect(requests).toHaveLength(3);
});

it("does not reuse failed reads", async () => {
  const send = vi.fn(async (request: ApiRequest) => ({ ok: false, requestId: request.requestId, error: { code: "TEMPORARILY_UNAVAILABLE", message: "稍后重试", retryable: true } }));
  const api = new PersonalApi(new AppApiClient({ send }), async () => randomUUID());
  const results = await Promise.allSettled([api.read("family.list", {}), api.read("family.list", {})]);
  expect(results.every(result => result.status === "rejected")).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  await expect(api.read("family.list", {})).rejects.toMatchObject({ retryable: true });
  expect(send).toHaveBeenCalledTimes(2);
});

it("separates read parameters and refreshes reads after a write", async () => {
  const requests: ApiRequest[] = []; let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = new PersonalApi(new AppApiClient({ send: async request => {
    requests.push(request);
    if (request.action === "task.delete") return success(request);
    await gate;
    return { ok: true, requestId: request.requestId, data: { items: [], nextCursor: null, complete: true, asOf: "2026-09-14T00:00:00.000Z" } };
  } }), async () => randomUUID());
  const first = api.read("family.list", { limit: 10 });
  const different = api.read("family.list", { limit: 20 });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  const revision = api.readRevision;
  await api.write("task.delete", payload);
  expect(api.readRevision).toBeGreaterThan(revision);
  const refreshed = api.read("family.list", { limit: 10 });
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  release?.(); await Promise.all([first, different, refreshed]);
});
