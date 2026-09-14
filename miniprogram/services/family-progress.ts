import type { MemberProgress } from "@family-todo/contracts";
import { personalApi, PersonalApiError } from "./personal-api";

/** Publish only a complete, authorized progress snapshot. */
export async function familyProgress(familyId: string, date: string, active: () => boolean): Promise<MemberProgress[]> {
  let cursor: string | undefined;
  let restarted = false;
  const seen = new Set<string>();
  while (active()) {
    try {
      const result = await personalApi.read("progress.get", { familyId, date, ...(cursor ? { cursor } : {}) });
      if (!active()) break;
      if (result.complete && result.members !== null) return result.members;
      if (!result.nextCursor || seen.has(result.nextCursor)) throw new Error("进度未完整加载，请重试。");
      cursor = result.nextCursor;
      seen.add(cursor);
    } catch (error) {
      if (error instanceof PersonalApiError && error.code === "CURSOR_EXPIRED" && !restarted) {
        restarted = true; cursor = undefined; seen.clear(); continue;
      }
      throw error;
    }
  }
  throw new Error("已切换查看范围。");
}
