import type { PersonalActionMap, TaskSummaryDTO } from "@family-todo/contracts";
import { personalApi } from "./personal-api";
export type BatchPayload=PersonalActionMap["task.batchAddViewers"]["payload"];
export type BatchGroup={key:string;name:string;taskIds:string[];targetFamilyId:string;familyIndex:number;viewers:{id:string;name:string;checked:boolean}[];loading:boolean;error:string};
export function selectTask(selected:TaskSummaryDTO[],task:TaskSummaryDTO):TaskSummaryDTO[]{
  if(!(task.capabilities.canShare&&task.capabilities.canEdit))return selected;
  if(selected.some(item=>item.id===task.id))return selected.filter(item=>item.id!==task.id);
  if(selected.length>=20)throw new Error("一次最多选择 20 个事项。");
  return [...selected,task];
}
export function batchPayload(tasks:TaskSummaryDTO[],groups:BatchGroup[]):BatchPayload {
  return {items:tasks.map(task=>{const group=groups.find(g=>g.key===(task.familyId??"personal"));if(!group||group.loading||group.error)throw new Error("请先完整加载每个家庭的家人。");if(!task.familyId&&!group.targetFamilyId)throw new Error("请先明确选择个人事项归属的家庭。");const viewerMembershipIds=group.viewers.filter(v=>v.checked).map(v=>v.id);if(!viewerMembershipIds.length)throw new Error("请为每个家庭分组至少选择一位可见人。");return {taskId:task.id,expectedVersion:task.version,viewerMembershipIds,...(!task.familyId?{targetFamilyId:group.targetFamilyId}:{})};})};
}
/** A new operation is legal only after all original children have terminal receipts. */
export async function retryFailedBatch(){
  const batch=personalApi.batch;
  if(!batch?.result?.complete)throw new Error("请先继续确认整个批量操作。");
  const failed=new Set(batch.result.results.filter(item=>item.status==="failed").map(item=>item.taskId));
  const items:BatchPayload["items"]=[];
  for(const item of batch.payload.items){if(!failed.has(item.taskId))continue;const {task}=await personalApi.read("task.get",{id:item.taskId});if(!task.capabilities.canShare||!task.capabilities.canEdit)throw new Error("失败事项的共享权限已改变，请重新选择。");if(task.familyId&&item.targetFamilyId&&task.familyId!==item.targetFamilyId)throw new Error("事项归属已改变，请重新选择。");items.push({taskId:item.taskId,expectedVersion:task.version,viewerMembershipIds:item.viewerMembershipIds,...(!task.familyId&&item.targetFamilyId?{targetFamilyId:item.targetFamilyId}:{})});}
  if(!items.length)throw new Error("没有需要重试的失败事项。");
  // Remove the optional property entirely: exact runtime payloads cannot carry undefined.
  return personalApi.write("task.batchAddViewers",{items});
}
