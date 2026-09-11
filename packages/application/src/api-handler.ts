import { isApiRequestEnvelope, isRecord, isUuid } from "@family-todo/contracts";
import type { ApiResponse } from "@family-todo/contracts";

import { ApplicationError } from "./errors";
import type { ActionRouter } from "./router";

export function createApiHandler(router: ActionRouter) {
  return async (event: unknown): Promise<ApiResponse<unknown>> => {
    const requestId = isRecord(event) && isUuid(event.requestId) ? event.requestId : "unknown";
    try {
      if (!isApiRequestEnvelope(event)) {
        throw new ApplicationError("VALIDATION_ERROR", "请求格式不正确。");
      }
      return { ok: true, requestId, data: await router.dispatch(event) };
    } catch (error) {
      if (error instanceof ApplicationError) {
        return { ok: false, requestId, error: { code: error.code, message: error.message, retryable: error.retryable } };
      }
      return {
        ok: false,
        requestId,
        error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。", retryable: true },
      };
    }
  };
}
