import type { Page, TaskListItem, ReminderDTO, TaskDTO, TaskEventDTO, AggregatePage, TaskListInput, ScopeResult } from "@family-todo/contracts";
import { personalApi } from "./personal-api";

export async function collect<T, P extends Page<T>>(fetch: (cursor?: string) => Promise<P>): Promise<{ items: T[]; last: P }> {
  const items: T[] = []; let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const result = await fetch(cursor); items.push(...result.items);
    if (result.complete) return {items,last:result};
    if (!result.nextCursor || seen.has(result.nextCursor)) throw new Error("列表未完整加载，请重试。");
    cursor = result.nextCursor; seen.add(cursor);
  }
}
export function authorizedItems<T>(items:T[], scopes:ScopeResult[], family:(item:T)=>string|null):T[] { return items.filter(item=>scopes.some(scope=>scope.familyId===family(item)&&scope.status==="ok")); }
export async function listTasks(input: TaskListInput) { const result=await collect<TaskListItem,AggregatePage<TaskListItem>>(cursor => personalApi.read("task.list",{...input,limit:50,...(cursor ? {cursor} : {})})); return {...result,items:authorizedItems(result.items,result.last.scopes,item=>item.task.familyId)}; }
export async function listReminders(includeDismissed = false) { const result=await collect<ReminderDTO,AggregatePage<ReminderDTO>>(cursor => personalApi.read("reminder.list",{includeDismissed,limit:50,...(cursor ? {cursor} : {})})); return {...result,items:authorizedItems(result.items,result.last.scopes,item=>item.familyId)}; }
export function listRecycle(familyId?: string | null) { return collect<TaskDTO,Page<TaskDTO>>(cursor => personalApi.read("task.recycleList",{...(familyId === undefined ? {} : {familyId}),limit:50,...(cursor ? {cursor} : {})})); }
export function listHistory(taskId: string) { return collect<TaskEventDTO,Page<TaskEventDTO>>(cursor => personalApi.read("task.history",{taskId,limit:50,...(cursor ? {cursor} : {})})); }
