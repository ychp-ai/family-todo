import { ActionRouter, ApplicationError, createApiHandler, IdentityEnsureHandler, SystemHealthHandler } from "@family-todo/application";
import { loadIdentityStore, NodeUuidGenerator, readInvocationIdentity, SystemClock } from "@family-todo/infra-cloudbase";

const clock = new SystemClock();
const uuids = new NodeUuidGenerator();

export async function main(event: unknown, context?: unknown) {
  const router = new ActionRouter();
  router.register(new SystemHealthHandler(clock));
  router.register(new IdentityEnsureHandler(async () => {
    const identity = readInvocationIdentity(context, process.env.FAMILY_TODO_APP_ID ?? "");
    if (!identity) throw new ApplicationError("UNAUTHENTICATED", "请从小程序重新进入。");
    // 真实来源隔离、数据库权限及事务验收完成后，才由部署配置显式开启。
    if (process.env.FAMILY_TODO_IDENTITY_ENABLED !== "true") {
      throw new ApplicationError("INTERNAL_ERROR", "身份服务尚未开放，请稍后重试。", true);
    }
    return loadIdentityStore(identity);
  }, clock, uuids));
  return createApiHandler(router)(event);
}
