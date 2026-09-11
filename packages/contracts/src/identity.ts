import { isRecord, isUuid } from "./api";

export type IdentityEnsurePayload = Record<string, never>;
export type UserDTO = { id: string; displayName: string; version: number };
export type IdentityEnsureData = { user: UserDTO };

export function isIdentityEnsurePayload(value: unknown): value is IdentityEnsurePayload {
  return isRecord(value) && Object.keys(value).length === 0;
}

export function isIdentityEnsureData(value: unknown): value is IdentityEnsureData {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.user)) return false;
  const user = value.user;
  return Object.keys(user).length === 3
    && isUuid(user.id)
    && typeof user.displayName === "string"
    && user.displayName === user.displayName.trim()
    && [...user.displayName].length >= 1 && [...user.displayName].length <= 12
    && typeof user.version === "number" && Number.isSafeInteger(user.version) && user.version >= 1;
}
