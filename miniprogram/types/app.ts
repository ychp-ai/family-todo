export type CloudStatus = "unconfigured" | "ready" | "unavailable";

export type AppOptions = {
  globalData: { cloudStatus: CloudStatus; session: IdentitySession };
};
import type { IdentitySession } from "../services/session";
