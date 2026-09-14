import type { Page, TaskListItem, ReminderDTO, TaskDTO, TaskEventDTO, AggregatePage, TaskListInput, ScopeResult } from "@family-todo/contracts";
import { personalApi, PersonalApiError } from "./personal-api";

export async function collect<T, P extends Page<T>>(fetch: (cursor?: string) => Promise<P>, active:()=>boolean = ()=>true): Promise<{ items: T[]; last: P }> {
  let items: T[] = []; let cursor: string | undefined; let restarted=false;
  const seen = new Set<string>();
  for (;;) {
    if (!active()) throw new Error("已切换查看范围。");
    let result:P;
    try { result=await fetch(cursor); } catch(error) {
      if(active() && !restarted && error instanceof PersonalApiError && error.code === "CURSOR_EXPIRED") {items=[];cursor=undefined;seen.clear();restarted=true;continue;}
      throw error;
    }
    if (!active()) throw new Error("已切换查看范围。");
    items.push(...result.items);
    if (result.complete) return {items,last:result};
    if (!result.nextCursor || seen.has(result.nextCursor)) throw new Error("列表未完整加载，请重试。");
    cursor = result.nextCursor; seen.add(cursor);
  }
}
export function authorizedItems<T>(items:T[], scopes:ScopeResult[], family:(item:T)=>string|null):T[] { return items.filter(item=>scopes.some(scope=>scope.familyId===family(item)&&scope.status==="ok")); }
export async function listTasks(input: TaskListInput, active?:()=>boolean) { const result=await collect<TaskListItem,AggregatePage<TaskListItem>>(cursor => personalApi.read("task.list",{...input,limit:50,...(cursor ? {cursor} : {})}),active); return {...result,items:authorizedItems(result.items,result.last.scopes,item=>item.task.familyId)}; }
export async function listReminders(includeDismissed = false, active?:()=>boolean) { const result=await collect<ReminderDTO,AggregatePage<ReminderDTO>>(cursor => personalApi.read("reminder.list",{includeDismissed,limit:50,...(cursor ? {cursor} : {})}),active); return {...result,items:authorizedItems(result.items,result.last.scopes,item=>item.familyId)}; }
export function listRecycle(familyId?: string | null) { return collect<TaskDTO,Page<TaskDTO>>(cursor => personalApi.read("task.recycleList",{...(familyId === undefined ? {} : {familyId}),limit:50,...(cursor ? {cursor} : {})})); }
export function listHistory(taskId: string, active?:()=>boolean) { return collect<TaskEventDTO,Page<TaskEventDTO>>(cursor => personalApi.read("task.history",{taskId,limit:50,...(cursor ? {cursor} : {})}),active); }
