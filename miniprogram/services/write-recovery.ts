import type { FamilyAction, PersonalAction } from "@family-todo/contracts";
import { FAMILY_ACTIONS, isFamilyPayload, isPersonalPayload, isRecord, isUuid } from "../shared/contracts";

export interface RecoveryStorage {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  remove(key: string): void;
}
/** Lazy access: importing the service never touches the platform. */
export const wxRecoveryStorage: RecoveryStorage = {
  read: key => wx.getStorageSync(key),
  write: (key, value) => wx.setStorageSync(key, value),
  remove: key => wx.removeStorageSync(key),
};
export const WRITE_ACTIONS = [
  "task.create", "task.update", "task.setAccess", "task.delete", "task.restore", "task.pause", "task.resume", "task.stop", "task.batchAddViewers",
  "occurrence.record", "occurrence.undo", "reminder.setMine", "reminder.markRead", "reminder.dismiss",
  "family.create", "family.update", "member.rename", "invitation.create", "invitation.revoke",
  "virtualMember.create", "virtualMember.update", "virtualMember.deactivate", "family.exit", "family.transferOwnership",
] as const;
export type DurableWriteAction = typeof WRITE_ACTIONS[number];
export interface RecoveryRecord {
  version: 1;
  action: DurableWriteAction;
  payload: unknown;
  requestId: string;
  draftId?: string;
  state: "pending" | "succeeded" | "rejected";
}
export function isDurableWriteAction(action: string): action is DurableWriteAction {
  return WRITE_ACTIONS.some(candidate => candidate === action);
}
export function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!isRecord(value) || Object.keys(value).some(key => !["version", "action", "payload", "requestId", "draftId", "state"].includes(key))) return false;
  if (value.version !== 1 || typeof value.action !== "string" || !isDurableWriteAction(value.action) || !isUuid(value.requestId)) return false;
  if (value.draftId !== undefined && !isUuid(value.draftId)) return false;
  if (typeof value.state !== "string" || !["pending", "succeeded", "rejected"].includes(value.state)) return false;
  return isDurablePayload(value.action, value.payload);
}
export function isDurablePayload(action: DurableWriteAction, payload: unknown): boolean {
  return FAMILY_ACTIONS.some(candidate => candidate === action)
    ? isFamilyPayload(action as FamilyAction, payload)
    : isPersonalPayload(action as PersonalAction, payload);
}
export function recoveryContextKey(environment: string, userId: string): string {
  if (!environment.trim() || !isUuid(userId)) throw new Error("恢复身份无效，请重新进入小程序。");
  return `family-todo:recovery:v1:${encodeURIComponent(environment)}:${userId}`;
}
