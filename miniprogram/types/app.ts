export type CloudStatus = "unconfigured" | "ready" | "unavailable";

export type AppOptions = {
  globalData: { cloudStatus: CloudStatus };
};
