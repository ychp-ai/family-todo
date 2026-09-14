import { appConfig } from "../config/index";

let avatarSequence = 0;
function avatarPrefix(): string { return `${wx.env.USER_DATA_PATH}/family-todo-avatar-`; }

export type LocalProfile = { displayName: string; avatarPath: string };

function profileKey(userId: string): string {
  if (!userId) throw new Error("请先完成身份初始化。");
  return `family-todo:profile:v1:${appConfig.cloudbaseEnvId}:${userId}`;
}

/** 仅用于当前设备的资料展示，不作为业务身份或家庭称呼。 */
export function readLocalProfile(userId: string): LocalProfile | null {
  try {
    const value: unknown = wx.getStorageSync(profileKey(userId));
    if (typeof value !== "object" || value === null || !("displayName" in value) || !("avatarPath" in value)
      || typeof value.displayName !== "string" || !value.displayName.trim() || [...value.displayName].length > 32
      || typeof value.avatarPath !== "string") return null;
    let avatarPath = value.avatarPath;
    if (avatarPath && !avatarPath.startsWith(avatarPrefix())) avatarPath = "";
    if (avatarPath) {
      try { wx.getFileSystemManager().accessSync(avatarPath); } catch { avatarPath = ""; }
    }
    return { displayName: value.displayName, avatarPath };
  } catch { return null; }
}

export function saveLocalProfile(userId: string, displayName: string, avatarPath: string): LocalProfile {
  const key = profileKey(userId);
  const name = displayName.trim();
  if (!name || [...name].length > 32) throw new Error("请填写 1–32 个字的昵称。");
  const previous = readLocalProfile(userId);
  let savedPath = previous?.avatarPath ?? "";
  let createdPath = "";
  try {
    if (avatarPath && avatarPath !== savedPath) {
      createdPath = `${avatarPrefix()}${Date.now()}-${avatarSequence++}.png`;
      wx.getFileSystemManager().copyFileSync(avatarPath, createdPath);
      savedPath = createdPath;
    }
    const profile = { displayName: name, avatarPath: savedPath };
    wx.setStorageSync(key, profile);
    if (previous?.avatarPath && previous.avatarPath !== savedPath) removeAvatar(previous.avatarPath);
    return profile;
  } catch {
    if (createdPath) removeAvatar(createdPath);
    throw new Error("资料保存失败，请重试。");
  }
}

function removeAvatar(filePath: string): void {
  if (!filePath.startsWith(avatarPrefix())) return;
  try { wx.getFileSystemManager().unlinkSync(filePath); } catch { /* 清理失败不影响已保存资料。 */ }
}
