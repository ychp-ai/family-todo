import type { AppConfig } from "./types";

// npm run setup 会复制到 local.ts；空环境 ID 允许无云环境预览首页。
// 此文件最终进入客户端，任何配置都不能包含密钥。
export const localConfig: AppConfig = {
  cloudbaseEnvId: "",
  apiFunctionName: "api",
};
