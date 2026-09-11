import type { ActionRequest } from "@family-todo/contracts";

import { isIdentityEnsureData } from "../shared/contracts";
import { AppApiClient } from "./app-api-client";

const client = new AppApiClient();

// 调用方持有 requestId，网络重试保持不变；此处不触发页面跳转或头像昵称授权。
export function ensureIdentity(requestId: string, api: AppApiClient = client) {
  const request: ActionRequest<"identity.ensure"> = { apiVersion: 1, action: "identity.ensure", requestId, payload: {} };
  return api.call(request, isIdentityEnsureData);
}
