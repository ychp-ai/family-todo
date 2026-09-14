import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, PersonalActionMap } from "@family-todo/contracts";
import { AppApiClient } from "./app-api-client";
import { PersonalApi } from "./personal-api";
import { isRecoveryRecord, recoveryContextKey } from "./write-recovery";
import type { RecoveryStorage } from "./write-recovery";

const userId = randomUUID();
const payload = {id: randomUUID(), expectedVersion: 7};
const record = () => ({version: 1, action: "task.delete", payload: {...payload}, requestId: randomUUID(), state: "pending"});
const success = (request: ApiRequest) => ({ok: true, requestId: request.requestId, data: {id: payload.id, version: 8, deleted: true}});
function fixture() {
  const values = new Map<string, unknown>();
  const storage: RecoveryStorage = {
    read: vi.fn(key => values.get(key)),
    write: vi.fn((key, value) => { values.set(key, JSON.parse(JSON.stringify(value))); }),
    remove: vi.fn(key => { values.delete(key); }),
  };
  const requests: ApiRequest[] = [];
  const send = vi.fn(async (request: ApiRequest): Promise<unknown> => { requests.push(request); throw new Error("offline"); });
  const create = (user = userId, env = "test") => {
    const api = new PersonalApi(new AppApiClient({send}), async () => randomUUID(), storage);
    api.bindRecovery(env, user);
    return api;
  };
  return {values, storage, requests, send, create, key: recoveryContextKey("test", userId) + ":pending"};
}
afterEach(() => vi.useRealTimers());

describe("durable write recovery", () => {
  it("persists before send and reconstructs the original ID and complete versioned payload without auto replay", async () => {
    const f = fixture(); const api = f.create();
    f.send.mockImplementation(async request => {
      expect(f.values.get(f.key)).toMatchObject({requestId: request.requestId, payload: request.payload});
      f.requests.push(request); throw new Error("offline");
    });
    const original = {...payload};
    await expect(api.write("task.delete", original)).rejects.toMatchObject({retryable: true});
    original.expectedVersion = 99;
    const restarted = f.create();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(restarted.pendingCount).toBe(1);
    f.send.mockImplementation(async request => { f.requests.push(request); return success(request); });
    await restarted.retryPending();
    expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.requests[1]?.payload).toEqual(payload);
    expect(restarted.pendingCount).toBe(0);
  });

  it.each([null, [], {...record(), state: ["pending"]}, {...record(), state: {}}, {...record(), version: 2}, {...record(), action: "identity.ensure"}, {...record(), action: "invitation.accept", payload: {token: "secret"}}, {...record(), payload: {...payload, expectedVersion: "7"}}, {...record(), requestId: "bad"}, {...record(), result: {secret: true}}, {...record(), draftId: "bad"}])("rejects unknown recovery shapes %#", value => {
    expect(isRecoveryRecord(value)).toBe(false);
  });
  it("corrupt cache blocks writes and offers explicit retry instead of silently dropping it", async () => {
    const f = fixture(); f.values.set(f.key, {action: "system.health"}); const api = f.create();
    expect(api.pendingCount).toBe(1); expect(api.recoveryError).toContain("首页重试");
    await expect(api.write("task.delete", payload)).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    await expect(api.retryPending()).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    expect(f.send).not.toHaveBeenCalled(); expect(f.values.get(f.key)).toEqual({action: "system.health"});
  });
  it("read failure blocks send; same verified identity can retry storage loading", async () => {
    const f = fixture(); f.values.set(f.key, record()); vi.mocked(f.storage.read).mockImplementationOnce(() => {throw new Error("disk");});
    const api = f.create(); await expect(api.write("task.delete", payload)).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    api.bindRecovery("test", userId); expect(api.recoveryError).toBe(""); expect(api.pendingCount).toBe(1); expect(f.send).not.toHaveBeenCalled();
  });
  it("persist failure retains the same generated ID and sends nothing until user retries", async () => {
    const f = fixture(); vi.mocked(f.storage.write).mockImplementationOnce(() => {throw new Error("full");}); const api = f.create();
    await expect(api.write("task.delete", payload)).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    expect(f.send).not.toHaveBeenCalled(); const first = vi.mocked(f.storage.write).mock.calls[0]?.[1];
    await expect(api.retryPending()).rejects.toMatchObject({code: "NETWORK_ERROR"});
    expect(f.values.get(f.key)).toEqual(first);
  });
  it("remove failure persists completed state; restart cleans up without resending or saving response data", async () => {
    const f = fixture(); f.send.mockImplementation(async request => success(request)); vi.mocked(f.storage.remove).mockImplementationOnce(() => {throw new Error("disk");});
    const api = f.create(); const draftId = randomUUID();
    await expect(api.write("task.delete", payload, {draftId})).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    expect(api.pendingCount).toBe(1); expect(api.isDraftCompleted(draftId)).toBe(true);
    expect(f.values.get(f.key)).toEqual(expect.objectContaining({state: "succeeded", draftId}));
    expect(JSON.stringify([...f.values.values()])).not.toContain('"deleted"');
    const restarted = f.create(); await restarted.retryPending(); expect(f.send).toHaveBeenCalledTimes(1); expect(restarted.pendingCount).toBe(0);
    restarted.forgetDraftCompletion(draftId); expect(restarted.isDraftCompleted(draftId)).toBe(false);
  });
  it("completion marker failure keeps original request and blocks a different write", async () => {
    const f = fixture(); f.send.mockImplementation(async request => success(request)); const write = f.storage.write;
    vi.mocked(f.storage.write).mockImplementation((key, value) => { if (key.includes(":completed:")) throw new Error("full"); f.values.set(key, value); });
    const api = f.create(); const draftId = randomUUID();
    await expect(api.write("task.delete", payload, {draftId})).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    await expect(api.write("task.delete", {...payload, expectedVersion: 8})).rejects.toMatchObject({code: "PENDING_WRITE"});
    expect(f.values.get(f.key)).toMatchObject({state: "pending", draftId});
    expect(write).toHaveBeenCalled();
    vi.mocked(f.storage.write).mockImplementation((key, value) => {f.values.set(key, value);});
    await api.retryPending(); expect(f.send).toHaveBeenCalledTimes(1); expect(api.isDraftCompleted(draftId)).toBe(true);
  });
  it("single flight also covers slow request ID generation and blocks different intent", async () => {
    const f = fixture(); let resolve: ((value: unknown) => void) | undefined;
    f.send.mockImplementation(request => new Promise(done => {f.requests.push(request); resolve = done;})); const api = f.create();
    const a = api.write("task.delete", payload); const b = api.write("task.delete", payload); const c = api.retryPending();
    await expect(api.write("task.delete", {...payload, expectedVersion: 9})).rejects.toMatchObject({code: "PENDING_WRITE"});
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    const request = f.requests[0]; if (!request || !resolve) throw new Error("missing request"); resolve(success(request));
    await Promise.all([a,b,c]); expect(api.pendingCount).toBe(0);
  });
  it("account and environment switch isolate intents and late old responses cannot erase the new pending batch", async () => {
    const f = fixture(); let resolve: ((value: unknown) => void) | undefined;
    f.send.mockImplementationOnce(request => new Promise(done => {f.requests.push(request); resolve = done;})); const api = f.create();
    const first = api.write("task.delete", payload); const rejected = expect(first).rejects.toMatchObject({code: "SESSION_INVALIDATED"});
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    api.bindRecovery("test", randomUUID()); expect(api.pendingCount).toBe(0);
    const batch = {items: [{taskId: randomUUID(), expectedVersion: 2, viewerMembershipIds: []}]};
    await expect(api.write("task.batchAddViewers", batch)).rejects.toMatchObject({retryable: true});
    const request = f.requests[0]; if (!request || !resolve) throw new Error("missing request"); resolve(success(request)); await rejected;
    expect(api.pendingCount).toBe(1); expect(api.batch?.payload).toEqual(batch); expect(f.values.has(f.key)).toBe(true);
    api.bindRecovery("other-env", userId); expect(api.pendingCount).toBe(0);
    api.bindRecovery("test", userId); expect(api.pendingCount).toBe(1); expect(api.batch).toBeNull();
  });
  it("incomplete batches survive restart with the entire original payload and fetch their result again", async () => {
    const f = fixture(); const input: PersonalActionMap["task.batchAddViewers"]["payload"] = {items: [{taskId: randomUUID(), expectedVersion: 3, viewerMembershipIds: [randomUUID()], targetFamilyId: randomUUID()}]};
    f.send.mockImplementation(async request => {f.requests.push(request); return {ok: true, requestId: request.requestId, data: {complete: false, results: input.items.map(item => ({taskId: item.taskId, status: "pending"}))}};});
    const api = f.create(); await api.write("task.batchAddViewers", input); const restarted = f.create();
    expect(restarted.batch).toEqual({payload: input, result: null}); await restarted.continueBatch(); expect(f.requests[1]).toEqual(f.requests[0]); expect(restarted.pendingCount).toBe(1);
  });
  it("definite rejection frees the intent while unconfirmed response retains it", async () => {
    const f = fixture(); const api = f.create();
    f.send.mockResolvedValueOnce({unexpected: true}); await expect(api.write("task.delete", payload)).rejects.toMatchObject({retryable: true}); expect(api.pendingCount).toBe(1);
    f.send.mockImplementation(async request => ({ok: false, requestId: request.requestId, error: {code: "VERSION_CONFLICT", message: "最新版本已变化", retryable: false}}));
    await expect(api.retryPending()).rejects.toMatchObject({code: "VERSION_CONFLICT"}); expect(api.pendingCount).toBe(0); expect(f.values.has(f.key)).toBe(false);
  });
  it("invitation accept token is memory-only and restart requires a fresh preview", async () => {
    const f = fixture(); const api = f.create();
    await expect(api.write("invitation.accept", {token: "secret-token", myName: "我"})).rejects.toMatchObject({retryable: true});
    expect(f.storage.write).not.toHaveBeenCalled(); expect(api.pendingCount).toBe(1); expect(f.create().pendingCount).toBe(0);
  });
  it("invitation create never persists its returned token, including completion cleanup failure", async () => {
    const f = fixture(); const token = "a".repeat(21) + "A";
    f.send.mockImplementation(async request => ({ok: true, requestId: request.requestId, data: {id: randomUUID(), token, expiresAt: "2026-09-20T00:00:00.000Z", version: 1}}));
    vi.mocked(f.storage.remove).mockImplementationOnce(() => {throw new Error("disk");});
    const api = f.create();
    await expect(api.write("invitation.create", {familyId: randomUUID(), expectedFamilyVersion: 1})).rejects.toMatchObject({code: "RECOVERY_STORAGE"});
    expect(JSON.stringify(vi.mocked(f.storage.write).mock.calls)).not.toContain(token);
    await f.create().retryPending(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("invalid new durable payload fails before reserving a pending slot or generating a request", async () => {
    const f = fixture(); const api = f.create();
    await expect(api.write("task.delete", {...payload, expectedVersion: 0})).rejects.toMatchObject({code: "INVALID_ARGUMENT"});
    expect(api.pendingCount).toBe(0); expect(f.storage.write).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("a null completion marker fails closed rather than restoring a completed draft", () => {
    const f = fixture(); const draftId = randomUUID();
    const markerKey = recoveryContextKey("test", userId) + ":completed:" + draftId;
    f.values.set(markerKey, null);
    const restarted = f.create();
    expect(() => restarted.isDraftCompleted(draftId)).toThrow(expect.objectContaining({code: "RECOVERY_STORAGE", retryable: true}));
    expect(f.values.get(markerKey)).toBeNull();
    expect(f.storage.write).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

});
