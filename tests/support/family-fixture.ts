import { randomUUID } from "node:crypto";
import { CloudBaseFamilyStore } from "../../packages/infra-cloudbase/src/family-store";
import { CloudBaseIdentityStore } from "../../packages/infra-cloudbase/src/identity-store";
import type { WechatIdentity } from "../../packages/infra-cloudbase/src/invocation-identity";
import { MemoryPersonalDatabase } from "./personal-database";

export async function familyFixture(database = new MemoryPersonalDatabase(), displayName = "家人") {
  const identity: WechatIdentity = { provider: "wechat", appId: "wx-family-tests", subject: randomUUID() };
  const now = "2026-09-11T12:00:00.000Z";
  const user = await new CloudBaseIdentityStore(database, identity).ensureUser({ id: randomUUID(), displayName, version: 1, createdAt: now, updatedAt: now });
  const store = () => new CloudBaseFamilyStore(database, identity, "test-family-cursor-and-encryption-secret", { activeKeyId: "test-key", keys: { "test-key": "test-family-encryption-key-separate-from-cursor" } });
  return { database, user, identity, now, store };
}
