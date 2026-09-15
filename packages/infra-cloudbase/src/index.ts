import type { FamilyStore, IdentityStore, PersonalStore } from "@family-todo/ports";
import type { WechatIdentity } from "./invocation-identity";

export * from "./platform";
export * from "./invocation-identity";

// 健康请求不加载 SDK，也不初始化数据库。
export async function loadIdentityStore(identity: WechatIdentity): Promise<IdentityStore> {
  const { createCloudBaseIdentityStore } = await import("./identity-sdk");
  return createCloudBaseIdentityStore(identity);
}

export async function loadPersonalStore(identity: WechatIdentity, deadline?: number): Promise<PersonalStore> {
  const { createCloudBasePersonalStore } = await import("./identity-sdk");
  return createCloudBasePersonalStore(identity, deadline);
}

export async function loadFamilyStore(identity: WechatIdentity, deadline?: number): Promise<FamilyStore> {
  const { createCloudBaseFamilyStore } = await import("./identity-sdk");
  return createCloudBaseFamilyStore(identity, deadline);
}

export { measureApi } from "./api-metrics";
