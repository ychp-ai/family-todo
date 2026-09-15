import { observeDatabase } from "./api-metrics";
import * as cloud from "wx-server-sdk";

import { CloudBasePersonalStore } from "./personal-store";
import { CloudBaseFamilyStore, invitationKeyringFromEnvironment } from "./family-store";

import { CloudBaseIdentityStore } from "./identity-store";
import type { WechatIdentity } from "./invocation-identity";

export function createCloudBaseIdentityStore(identity: WechatIdentity): CloudBaseIdentityStore {
  const env = process.env.SCF_NAMESPACE;
  if (!env) throw new Error("Cloud function environment is unavailable.");
  // SDK 的 DYNAMIC_CURRENT_ENV 声明与 init 不一致，使用平台当前环境的显式字符串。
  cloud.init({ env });
  // 4.0.2 运行时支持 throwOnNotFound，但声明遗漏；保留额外配置且不使用类型断言。
  const config = { env, throwOnNotFound: false };
  const database = observeDatabase(cloud.database(config));
  return new CloudBaseIdentityStore(database, identity);
}

export function createCloudBasePersonalStore(identity: WechatIdentity, deadline?: number): CloudBasePersonalStore {
  const env = process.env.SCF_NAMESPACE;
  if (!env) throw new Error("Cloud function environment is unavailable.");
  cloud.init({env});
  const config = {env,throwOnNotFound:false};
  return new CloudBasePersonalStore(observeDatabase(cloud.database(config)),identity,process.env.FAMILY_TODO_CURSOR_SECRET ?? "", deadline);
}

export function createCloudBaseFamilyStore(identity: WechatIdentity, deadline?: number): CloudBaseFamilyStore {
  const env = process.env.SCF_NAMESPACE;
  if (!env) throw new Error("Cloud function environment is unavailable.");
  cloud.init({ env });
  const config = { env, throwOnNotFound: false };
  return new CloudBaseFamilyStore(observeDatabase(cloud.database(config)), identity, process.env.FAMILY_TODO_CURSOR_SECRET ?? "", invitationKeyringFromEnvironment(process.env.FAMILY_TODO_INVITATION_KEYRING), Date.now, deadline);
}
