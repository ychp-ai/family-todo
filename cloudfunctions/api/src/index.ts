import { ActionRouter, createApiHandler, SystemHealthHandler } from "@family-todo/application";
import { SystemClock } from "@family-todo/infra-cloudbase";

// 标准 CloudBase 事件入口；接入数据库或可信身份时再装配服务端 SDK。
const router = new ActionRouter();
router.register(new SystemHealthHandler(new SystemClock()));

export const main = createApiHandler(router);
