export const API_VERSION = 1 as const;
export const API_ACTIONS = ["system.health"] as const;
export type ApiAction = (typeof API_ACTIONS)[number];

export const ERROR_CODES = ["VALIDATION_ERROR", "NOT_FOUND", "INTERNAL_ERROR"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ApiRequest<TPayload = unknown, TAction extends string = ApiAction> = {
  apiVersion: typeof API_VERSION;
  action: TAction;
  requestId: string;
  payload: TPayload;
};

export type ApiError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
};

export type ApiResponse<TData> =
  | { ok: true; requestId: string; data: TData }
  | { ok: false; requestId: string; error: ApiError };

export type SystemHealthData = {
  status: "ok";
  service: "api";
  apiVersion: typeof API_VERSION;
  now: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isApiRequestEnvelope(value: unknown): value is ApiRequest<unknown, string> {
  return isRecord(value)
    && value.apiVersion === API_VERSION
    && typeof value.action === "string"
    && value.action.length > 0
    && value.action.length <= 100
    && isUuid(value.requestId)
    && Object.prototype.hasOwnProperty.call(value, "payload");
}

export function isApiResponse<TData>(
  value: unknown,
  requestId: string,
  isData: (data: unknown) => data is TData,
): value is ApiResponse<TData> {
  if (!isRecord(value) || value.requestId !== requestId) return false;
  if (value.ok === true) return isData(value.data);
  if (value.ok !== false || !isRecord(value.error)) return false;
  const error = value.error;
  return ERROR_CODES.some((code) => code === error.code)
    && typeof error.message === "string"
    && typeof error.retryable === "boolean";
}

export function isSystemHealthData(value: unknown): value is SystemHealthData {
  if (!isRecord(value) || typeof value.now !== "string") return false;
  const date = new Date(value.now);
  return value.status === "ok"
    && value.service === "api"
    && value.apiVersion === API_VERSION
    && !Number.isNaN(date.getTime())
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.now)
    && date.toISOString() === value.now;
}
