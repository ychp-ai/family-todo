import { createHash } from "node:crypto";

import { isIdentityEnsureData, isRecord, isUuid } from "@family-todo/contracts";
import type { User } from "@family-todo/domain";
import type { IdentityStore } from "@family-todo/ports";

import { retryTransaction } from "./transaction-retry";

import type { WechatIdentity } from "./invocation-identity";

// wx-server-sdk 4.0.2 的事务声明为 any；将缺失类型收敛到实际使用的方法，读取仍按 unknown 校验。
export interface IdentityDocument {
  get(): Promise<unknown>;
  set(options: { data: Record<string, unknown> }): Promise<unknown>;
}
export interface IdentityTransaction {
  collection(name: string): { doc(id: string): IdentityDocument };
}
export interface IdentityDatabase {
  runTransaction(work: (transaction: IdentityTransaction) => Promise<User>, retries: number): Promise<unknown>;
}

export function readDocument(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result) || !Object.prototype.hasOwnProperty.call(result, "data")) throw new Error("Invalid document response.");
  if (result.data === null) return null;
  if (!isRecord(result.data)) throw new Error("Invalid document data.");
  return result.data;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function readUser(value: unknown): User {
  if (!isRecord(value) || !isIdentityEnsureData({ user: { id: value.id, displayName: value.displayName, version: value.version } })
    || !isInstant(value.createdAt) || !isInstant(value.updatedAt)) throw new Error("Invalid user record.");
  // 单独校验以保留 unknown 的类型收窄，不使用断言代替读取校验。
  if (!isUuid(value.id) || typeof value.displayName !== "string" || typeof value.version !== "number") throw new Error("Invalid user fields.");
  return { id: value.id, displayName: value.displayName, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function identityDocumentKey(identity: WechatIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.provider, identity.appId, identity.subject])).digest("hex");
}

export class CloudBaseIdentityStore implements IdentityStore {
  public constructor(private readonly database: IdentityDatabase, private readonly identity: WechatIdentity) {}

  public async ensureUser(candidate: User): Promise<User> {
    const key = identityDocumentKey(this.identity);
    const result = await retryTransaction(() => this.database.runTransaction(async (transaction) => {
      const identityRef = transaction.collection("identities").doc(key);
      const existing = readDocument(await identityRef.get());
      if (existing) {
        if (existing.schemaVersion !== 1 || existing.provider !== this.identity.provider || existing.appId !== this.identity.appId
          || existing.subject !== this.identity.subject || !isUuid(existing.userId)) throw new Error("Invalid identity mapping.");
        const userDocument = readDocument(await transaction.collection("users").doc(existing.userId).get());
        if (!userDocument || userDocument.schemaVersion !== 1) throw new Error("Missing identity user.");
        const user = readUser({ ...userDocument, id: userDocument._id });
        if (user.id !== existing.userId) throw new Error("Mismatched identity user.");
        const scope = readDocument(await transaction.collection("user_scopes").doc(user.id).get());
        if (!scope || scope.schemaVersion !== 1 || scope.userId !== user.id
          || typeof scope.revision !== "number" || !Number.isSafeInteger(scope.revision) || scope.revision < 1
          || ![scope.activeFamilyCount, scope.personalTaskCount].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) {
          throw new Error("Invalid user scope.");
        }
        return user;
      }

      const user = readUser(candidate);
      const userRef = transaction.collection("users").doc(user.id);
      const scopeRef = transaction.collection("user_scopes").doc(user.id);
      // UUID 冲突或孤立容量文档不能被 set 静默覆盖。
      if (readDocument(await userRef.get()) || readDocument(await scopeRef.get())) throw new Error("User identifier collision.");
      const metadata = { schemaVersion: 1, version: 1, createdAt: user.createdAt, updatedAt: user.updatedAt };
      await userRef.set({ data: { ...metadata, displayName: user.displayName } });
      await scopeRef.set({ data: { ...metadata, userId: user.id, revision: 1, activeFamilyCount: 0, personalTaskCount: 0 } });
      await identityRef.set({ data: { ...metadata, ...this.identity, userId: user.id } });
      return user;
    }, 0));
    // SDK 返回事务回调结果；如版本升级改变形状，应明确失败而非伪造成功。
    return readUser(result);
  }
}
