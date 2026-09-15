import { isRecord } from "@family-todo/contracts";
import { ActionRouter, ApplicationError, createApiHandler, registerCollaborativeTaskHandlers, registerFamilyHandlers, IdentityEnsureHandler, SystemHealthHandler } from "@family-todo/application";
import { measureApi, loadIdentityStore, loadFamilyStore, loadPersonalStore, NodeUuidGenerator, readInvocationIdentity, SystemClock } from "@family-todo/infra-cloudbase";

const clock = new SystemClock();
const uuids = new NodeUuidGenerator();

export async function main(event: unknown, context?: unknown) {
  const deadline = Date.now() + 8000;
  // 微信传输会附加 userInfo/tcbContext；只剥离传输元数据，业务身份仍只读取本次可信 context。
  if (isRecord(event)) {
    const { userInfo: _userInfo, tcbContext: _tcbContext, ...request } = event;
    event = request;
  }
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
  const familyStore = async () => {
    const identity = readInvocationIdentity(context, process.env.FAMILY_TODO_APP_ID ?? "");
    if (!identity) throw new ApplicationError("UNAUTHENTICATED", "请从小程序重新进入。");
    if (process.env.FAMILY_TODO_IDENTITY_ENABLED !== "true") throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "事项服务尚未开放，请稍后重试。", true);
    return loadFamilyStore(identity, deadline);
  };
  registerFamilyHandlers(router, familyStore, clock, uuids);
  registerCollaborativeTaskHandlers(router, familyStore, async () => {
    const identity = readInvocationIdentity(context, process.env.FAMILY_TODO_APP_ID ?? "");
    if (!identity) throw new ApplicationError("UNAUTHENTICATED", "请从小程序重新进入。");
    if (process.env.FAMILY_TODO_IDENTITY_ENABLED !== "true") throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "事项服务尚未开放，请稍后重试。", true);
    return loadPersonalStore(identity, deadline);
  }, clock, uuids);
  const run = () => createApiHandler(router)(event);
  return process.env.FAMILY_TODO_PERFORMANCE_LOGS === "true" ? measureApi(event, run) : run();
}
