import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ActionRouter, createApiHandler, IdentityEnsureHandler } from "@family-todo/application";
import { createUser } from "@family-todo/domain";
import { CloudBaseIdentityStore, identityDocumentKey } from "../packages/infra-cloudbase/src/identity-store";
import { AppApiClient } from "../miniprogram/services/app-api-client";
import { ensureIdentity } from "../miniprogram/services/identity-api";
import { MemoryIdentityDatabase } from "./support/identity-database";

const identity = { provider: "wechat", appId: "wx0123456789abcdef", subject: "private-subject-a" } as const;
const clock = { now: () => new Date("2026-09-11T00:00:00.000Z") };
const request = { apiVersion: 1, action: "identity.ensure", requestId: randomUUID(), payload: {} };

function handler(database: MemoryIdentityDatabase, subject: string = identity.subject) {
  const router = new ActionRouter();
  router.register(new IdentityEnsureHandler(async () => new CloudBaseIdentityStore(database, { ...identity, subject }), clock, { generate: randomUUID }));
  return createApiHandler(router);
}

describe("身份初始化闭环（模拟存储）", () => {
  it("客户端经真实 handler 和存储适配返回默认用户，重进和换 requestId 不重复创建", async () => {
    const database = new MemoryIdentityDatabase();
    const first = await ensureIdentity(request.requestId, new AppApiClient({ send: handler(database) }));
    const repeated = await ensureIdentity(request.requestId, new AppApiClient({ send: handler(database) }));
    const reopened = await ensureIdentity(randomUUID(), new AppApiClient({ send: handler(database) }));
    expect(first.ok).toBe(true);
    expect(first).toEqual(repeated);
    if (!first.ok || !reopened.ok) throw new Error("Expected identity success.");
    expect(first.data).toEqual(reopened.data);
    expect(first.data.user).toEqual({ id: expect.any(String), displayName: "我", version: 1 });
    expect(database.documents.size).toBe(3);
    expect(database.documents.get(`user_scopes/${first.data.user.id}`)).toMatchObject({
      revision: 1, personalTaskCount: 0, activeFamilyCount: 0,
    });
    expect(JSON.stringify(first)).not.toMatch(/private-subject|appId|_id|createdAt/);
  });

  it("两个实例同时首次进入，仅创建一个应用用户", async () => {
    const database = new MemoryIdentityDatabase();
    const responses = await Promise.all([handler(database)(request), handler(database)({ ...request, requestId: randomUUID() })]);
    expect(responses[0]).toMatchObject({ ok: true });
    expect(responses[0]?.ok && responses[1]?.ok && responses[0].data).toEqual(responses[1]?.ok && responses[1].data);
    expect(database.conflicts).toBeGreaterThan(0);
    expect(database.documents.size).toBe(3);
  });

  it("不同真实身份即使使用相同 requestId 也不会串号", async () => {
    const database = new MemoryIdentityDatabase();
    const first = await handler(database)(request);
    const second = await handler(database, "private-subject-b")(request);
    expect(first.ok && first.data).not.toEqual(second.ok && second.data);
    expect(database.documents.size).toBe(6);
    expect(identityDocumentKey(identity)).not.toBe(identityDocumentKey({ ...identity, appId: "wx1111111111111111" }));
  });

  it.each(["users", "user_scopes", "identities"])("%s 写入失败时回滚且隐藏原文，可安全重试", async (collection) => {
    const database = new MemoryIdentityDatabase();
    database.failCollection = collection;
    const failed = await handler(database)(request);
    expect(failed).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR", retryable: true } });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect(database.documents.size).toBe(0);
    database.failCollection = null;
    expect(await handler(database)(request)).toMatchObject({ ok: true });
    expect(database.documents.size).toBe(3);
  });

  it("已有用户的称呼及版本保持不变", async () => {
    const database = new MemoryIdentityDatabase();
    const user = createUser(randomUUID(), clock.now());
    const store = new CloudBaseIdentityStore(database, identity);
    await store.ensureUser(user);
    const saved = database.documents.get(`users/${user.id}`);
    database.documents.set(`users/${user.id}`, { ...saved, displayName: "妈妈", version: 2 });
    expect(await store.ensureUser(createUser(randomUUID(), clock.now()))).toMatchObject({ id: user.id, displayName: "妈妈", version: 2 });
  });

  it("映射用户丢失时明确失败，不重建为另一个用户", async () => {
    const database = new MemoryIdentityDatabase();
    database.documents.set(`identities/${identityDocumentKey(identity)}`, { ...identity, schemaVersion: 1, userId: randomUUID() });
    expect(await handler(database)(request)).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(database.documents.size).toBe(1);
  });

  it("已有身份的容量文档丢失时不重置计数或伪造就绪", async () => {
    const database = new MemoryIdentityDatabase();
    const user = createUser(randomUUID(), clock.now());
    const store = new CloudBaseIdentityStore(database, identity);
    await store.ensureUser(user);
    database.documents.delete(`user_scopes/${user.id}`);
    await expect(store.ensureUser(createUser(randomUUID(), clock.now()))).rejects.toThrow("Invalid user scope");
    expect(database.documents.size).toBe(2);
  });

  it("候选 UUID 碰撞时保留已有用户", async () => {
    const database = new MemoryIdentityDatabase();
    const user = createUser(randomUUID(), clock.now());
    database.documents.set(`users/${user.id}`, { _id: user.id, displayName: "已有用户" });
    const store = new CloudBaseIdentityStore(database, identity);
    await expect(store.ensureUser(user)).rejects.toThrow("User identifier collision");
    expect(database.documents.get(`users/${user.id}`)?.displayName).toBe("已有用户");
    expect(database.documents.size).toBe(1);
  });

  it("恶意 payload 在解析身份或访问数据库前被拒绝", async () => {
    const resolveStore = vi.fn();
    const router = new ActionRouter();
    router.register(new IdentityEnsureHandler(resolveStore, clock, { generate: randomUUID }));
    expect(await createApiHandler(router)({ ...request, payload: { userId: randomUUID() } })).toMatchObject({
      ok: false, error: { code: "VALIDATION_ERROR" },
    });
    expect(resolveStore).not.toHaveBeenCalled();
  });
});
