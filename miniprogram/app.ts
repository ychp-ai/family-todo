import { appConfig } from "./config/index";
import { initializeCloud } from "./services/cloud-runtime";
import { IdentitySession } from "./services/session";
import type { AppOptions } from "./types/app";

App<AppOptions>({
  globalData: { cloudStatus: "unconfigured", session: new IdentitySession() },
  onLaunch() {
    this.globalData.cloudStatus = initializeCloud(appConfig);
  },
});
