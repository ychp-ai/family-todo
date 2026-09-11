import type { ApiRequest } from "@family-todo/contracts";

import { appConfig } from "../config/index";
import type { AppOptions } from "../types/app";

export interface ApiTransport {
  send(request: ApiRequest): Promise<unknown>;
}

export class ApiTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ApiTransportError";
  }
}

export class CloudFunctionTransport implements ApiTransport {
  public async send(request: ApiRequest): Promise<unknown> {
    const status = getApp<AppOptions>().globalData.cloudStatus;
    if (status === "unconfigured") throw new ApiTransportError("尚未配置云环境。");
    if (status !== "ready") throw new ApiTransportError("云服务不可用，请重新打开小程序。");
    try {
      const response = await wx.cloud.callFunction({ name: appConfig.apiFunctionName, data: request });
      return response.result;
    } catch {
      throw new ApiTransportError("网络连接失败，请稍后重试。");
    }
  }
}
