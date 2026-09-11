import type { IdentityStore } from "@family-todo/ports";
import type { WechatIdentity } from "./invocation-identity";

export * from "./platform";
export * from "./invocation-identity";

// 健康请求不加载 SDK，也不初始化数据库。
export async function loadIdentityStore(identity: WechatIdentity): Promise<IdentityStore> {
  const { createCloudBaseIdentityStore } = await import("./identity-sdk");
  return createCloudBaseIdentityStore(identity);
}
