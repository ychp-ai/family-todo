import type { ApiRequest, SystemHealthData } from "./api";
import type { IdentityEnsureData, IdentityEnsurePayload } from "./identity";

export type ActionMap = {
  "system.health": { payload: Record<string, never>; data: SystemHealthData };
  "identity.ensure": { payload: IdentityEnsurePayload; data: IdentityEnsureData };
};

export type ActionRequest<TAction extends keyof ActionMap> = ApiRequest<ActionMap[TAction]["payload"], TAction>;
