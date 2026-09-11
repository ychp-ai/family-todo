import type { AppConfig } from "../config/types";
import type { CloudStatus } from "../types/app";

export function initializeCloud(config: Readonly<AppConfig>): CloudStatus {
  if (config.cloudbaseEnvId.trim() === "") return "unconfigured";
  if (!wx.cloud) return "unavailable";
  try {
    wx.cloud.init({ env: config.cloudbaseEnvId, traceUser: false });
    return "ready";
  } catch {
    return "unavailable";
  }
}
