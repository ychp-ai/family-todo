import type { RecoveryIdentity } from "./input-recovery";
import { isRecoveryIdentityCurrent } from "./input-recovery";

/** 新增表单偏好按可信账号、云环境保存在当前设备。undefined 表示尚无偏好。 */
export function readCreateFamily(identity: RecoveryIdentity, families: readonly { id: string }[]): string | undefined {
  if (!identity.context || !isRecoveryIdentityCurrent(identity)) return undefined;
  try {
    const value: unknown = wx.getStorageSync(`${identity.context}:create-family:v1`);
    if (value === null) return undefined;
    if (typeof value !== "string" || !value) return undefined;
    return families.some(family => family.id === value) ? value : undefined;
  } catch { return undefined; }
}

export function rememberCreateFamily(identity: RecoveryIdentity, familyId: string | null): void {
  if (!identity.context || !isRecoveryIdentityCurrent(identity)) return;
  try { wx.setStorageSync(`${identity.context}:create-family:v1`, familyId); }
  catch { /* 偏好保存失败不阻止编辑；事项和草稿仍走各自的可靠写入流程。 */ }
}
