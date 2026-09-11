import type { ApiRequest, ApiResponse } from "@family-todo/contracts";

import { isApiResponse } from "../shared/contracts";
import { ApiTransportError, CloudFunctionTransport } from "./cloud-transport";
import type { ApiTransport } from "./cloud-transport";

export class AppApiClient {
  public constructor(private readonly transport: ApiTransport = new CloudFunctionTransport()) {}

  public async call<TData>(
    request: ApiRequest,
    isData: (value: unknown) => value is TData,
  ): Promise<ApiResponse<TData>> {
    const response = await this.transport.send(request);
    if (!isApiResponse(response, request.requestId, isData)) {
      throw new ApiTransportError("服务响应异常，请稍后重试。");
    }
    // 只保留契约字段，避免 SDK 包装字段或内部调试信息进入页面。
    if (response.ok) return { ok: true, requestId: response.requestId, data: response.data };
    return {
      ok: false,
      requestId: response.requestId,
      error: { code: response.error.code, message: response.error.message, retryable: response.error.retryable },
    };
  }
}
