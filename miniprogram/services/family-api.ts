import type { FamilySummary, VirtualDTO, Page, ExitInput, TransferInput, ExitPreview, TransferPreview } from "@family-todo/contracts";
import { personalApi } from "./personal-api";
import { collect, completeLists } from "./personal-lists";
import type { MetricArgument } from "./personal-lists";
import { listMetricsConfigured, metricRequest, startListMetric } from "./list-metrics";
export const familyApi = personalApi;
export async function listFamilies(forceFull = false, suppliedMetric?: MetricArgument) {
  const metric = suppliedMetric === false ? undefined : suppliedMetric ?? (listMetricsConfigured() ? startListMetric("family.list") : undefined);
  return completeLists.read<FamilySummary, Page<FamilySummary>>("family.list", { limit: 50 }, (pagination, observer) => { const payload = { limit: 50, ...pagination }; return observer ? familyApi.read("family.list", payload, observer) : familyApi.read("family.list", payload); }, undefined, forceFull, metric);
}
export async function listManagedVirtualMembers(familyId:string):Promise<VirtualDTO[]> {
  const results=await Promise.all((["active","inactive"] as const).map(async status=>{
    const metric=listMetricsConfigured()?startListMetric("virtualMember.list"):undefined;
    try { const result=await collect<VirtualDTO,Page<VirtualDTO>>(cursor=>metricRequest(metric,observer=>{const payload={familyId,status,limit:50,...(cursor?{cursor}:{})};return observer?familyApi.read("virtualMember.list",payload,observer):familyApi.read("virtualMember.list",payload);}),undefined,metric);metric?.finish("success");return result; }
    catch(error){metric?.finishError(error);throw error;}
  }));
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
