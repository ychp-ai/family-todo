import { appConfig } from "./config/index";
import { initializeCloud } from "./services/cloud-runtime";
import { IdentitySession } from "./services/session";
import { personalApi } from "./services/personal-api";
import type { AppOptions } from "./types/app";

App<AppOptions>({
  globalData: { cloudStatus: "unconfigured", session: new IdentitySession(undefined, undefined, {
    verified: user => personalApi.bindRecovery(appConfig.cloudbaseEnvId, user.id),
    invalidated: () => personalApi.unbindRecovery(),
  }) },
  onLaunch() {
    this.globalData.cloudStatus = initializeCloud(appConfig);
  },
});
