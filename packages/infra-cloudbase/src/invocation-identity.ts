import { isRecord } from "@family-todo/contracts";

export type WechatIdentity = {
  readonly provider: "wechat";
  readonly appId: string;
  readonly subject: string;
};

/** 仅接受平台 main 第二参数的新架构 environment，绝不回退到进程环境或 event。 */
export function readInvocationIdentity(context: unknown, expectedAppId: string): WechatIdentity | null {
  if (!/^wx[0-9a-f]{16}$/.test(expectedAppId) || !isRecord(context)
    || typeof context.environment !== "string" || context.environment.length > 65536) return null;
  let environment: unknown;
  try {
    environment = JSON.parse(context.environment);
  } catch {
    return null;
  }
  if (!isRecord(environment)
    || (environment.TCB_SOURCE !== "wx_client" && environment.TCB_SOURCE !== "wx_devtools")
    || environment.WX_APPID !== expectedAppId
    || typeof environment.WX_OPENID !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(environment.WX_OPENID)) return null;
  return { provider: "wechat", appId: expectedAppId, subject: environment.WX_OPENID };
}
