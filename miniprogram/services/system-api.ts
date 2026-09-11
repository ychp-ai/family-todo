import { isSystemHealthData } from "../shared/contracts";
import { AppApiClient } from "./app-api-client";

const client = new AppApiClient();

// 请求 ID 由调用方创建并持有；重试同一请求时继续复用。
export function checkSystemHealth(requestId: string) {
  return client.call({ apiVersion: 1, action: "system.health", requestId, payload: {} }, isSystemHealthData);
}
