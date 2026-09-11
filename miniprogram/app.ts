import { appConfig } from "./config/index";
import { initializeCloud } from "./services/cloud-runtime";
import type { AppOptions } from "./types/app";

App<AppOptions>({
  globalData: { cloudStatus: "unconfigured" },
  onLaunch() {
    this.globalData.cloudStatus = initializeCloud(appConfig);
  },
});
