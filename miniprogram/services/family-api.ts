import type { FamilySummary, VirtualDTO, Page, ExitInput, TransferInput, ExitPreview, TransferPreview } from "@family-todo/contracts";
import { personalApi } from "./personal-api";
import { collect } from "./personal-lists";
export const familyApi = personalApi;
export function listFamilies() { return collect<FamilySummary, Page<FamilySummary>>(cursor => familyApi.read("family.list", {limit:50,...(cursor ? {cursor} : {})})); }
export async function listManagedVirtualMembers(familyId:string):Promise<VirtualDTO[]> {
  const results=await Promise.all((["active","inactive"] as const).map(status=>collect<VirtualDTO,Page<VirtualDTO>>(cursor=>familyApi.read("virtualMember.list",{familyId,status,limit:50,...(cursor?{cursor}:{})}))));
  return results.flatMap(result=>result.items);
}
export async function previewExit(input: ExitInput): Promise<ExitPreview> {
  if (familyApi.pendingCount) throw new Error("请先返回首页确认未决操作，再重新查看交接范围。");
  let cursor: string | undefined; const seen = new Set<string>();
  for (;;) { const result = await familyApi.read("family.previewExit", {...input,...(cursor ? {cursor} : {})}); if (result.complete) return result.preview; if (seen.has(result.nextCursor)) throw new Error("交接范围未完整加载，请重试。"); cursor=result.nextCursor; seen.add(cursor); }
}
export async function previewTransfer(input: TransferInput): Promise<TransferPreview> {
  if (familyApi.pendingCount) throw new Error("请先返回首页确认未决操作，再重新查看交接范围。");
  let cursor: string | undefined; const seen = new Set<string>();
  for (;;) { const result = await familyApi.read("family.previewTransfer", {...input,...(cursor ? {cursor} : {})}); if (result.complete) return result.preview; if (seen.has(result.nextCursor)) throw new Error("交接范围未完整加载，请重试。"); cursor=result.nextCursor; seen.add(cursor); }
}

/** The list contract is unchanged; counts come from the authorized family roster. */
export type FamilyOverview = FamilySummary & { memberCount?: number };
export async function familyOverviews(families: FamilySummary[]): Promise<FamilyOverview[]> {
  return Promise.all(families.map(async family => {
    try {
      const detail = await familyApi.read("family.get", { id: family.id });
      return { ...family, memberCount: detail.members.length + detail.virtualMembers.filter(member => member.status === "active").length };
    } catch {
      // A count failure must not turn a real family into an empty list or a zero count.
      return family;
    }
  }));
}
