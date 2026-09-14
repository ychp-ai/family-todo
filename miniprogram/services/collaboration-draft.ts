import type { FamilyActionMap, ParticipantDTO, Subject, TaskDTO, AccessInput, OccurrenceDTO, FamilySummary } from "@family-todo/contracts";
export function occurrenceGroup(occurrence:Pick<OccurrenceDTO,"subject"|"canRecord">,userId:string,families:FamilySummary[]):string {
  const subject=occurrence.subject;
  const mine=subject.kind==="user" ? subject.userId===userId : subject.kind==="member" && families.some(family=>family.myMembershipId===subject.membershipId);
  return mine?"我来做":occurrence.canRecord?"帮家人":"关心一下";
}
export type Roster = FamilyActionMap["family.get"]["data"];
export type PermissionRow = ParticipantDTO & {isMe:boolean};
export type SubjectOption = {name:string; subject:Subject};
export function subjectOptions(roster: Roster): SubjectOption[] { return [...roster.members.map(m=>({name:m.isMe ? `${m.name} · 自己` : m.name,subject:{kind:"member" as const,membershipId:m.id}})),...roster.virtualMembers.map(m=>({name:`${m.name} · 无账号成员`,subject:{kind:"virtual" as const,virtualMemberId:m.id}}))]; }
export function subjectKey(subject:Subject): string { return subject.kind === "member" ? subject.membershipId : subject.kind === "virtual" ? subject.virtualMemberId : "self"; }
export function taskSubject(task:TaskDTO): Subject { return task.subject.kind === "user" ? {kind:"self"} : task.subject; }
export function permissionRows(roster:Roster,subject:Subject,previous:ParticipantDTO[] = [], existingTask = false, necessaryHistory:ParticipantDTO[] = []): PermissionRow[] {
  const legacyManagement=existingTask && previous.some(row=>row.isCreatorManager===undefined);
  return roster.members.map(member=>{
    const old=previous.find(p=>p.membershipId===member.id);
    const isCreatorManager=existingTask ? legacyManagement ? old?.isCreatorManager : old?.isCreatorManager===true : member.isMe;
    const requiredViewer=necessaryHistory.some(row=>row.membershipId===member.id&&row.requiredViewer) || (legacyManagement ? old?.requiredViewer===true : isCreatorManager===true || (subject.kind === "member" && member.id===subject.membershipId) || (subject.kind === "virtual" && member.id===roster.family.ownerMembershipId));
    return {membershipId:member.id,name:member.name,isMe:member.isMe,canView:requiredViewer || old?.canView === true,canHelp:old?.canHelp === true,requiredViewer,...(isCreatorManager===undefined?{}:{isCreatorManager}),receivesReminder:old?.receivesReminder === true,reminderSelfDisabled:old?.reminderSelfDisabled === true};
  });
}
export function accessInput(rows:PermissionRow[],remindMe:boolean):AccessInput { return {viewerMembershipIds:rows.filter(r=>r.canView).map(r=>r.membershipId),helperMembershipIds:rows.filter(r=>r.canView&&r.canHelp).map(r=>r.membershipId),reminderMembershipIds:rows.filter(r=>r.canView&&!r.isMe&&r.receivesReminder&&!r.reminderSelfDisabled).map(r=>r.membershipId),remindMe}; }
export function withoutViewer(row:PermissionRow):PermissionRow { return row.requiredViewer ? row : {...row,canView:false,canHelp:false,receivesReminder:false}; }
export function subjectNotice(subject:Subject, roster:Roster|null):string {
  if(!roster)return "个人事项仅自己可见。";
  if(subject.kind === "virtual")return `由家庭拥有人${roster.members.find(m=>m.id===roster.family.ownerMembershipId)?.name ?? ""}和创建者管理。其他家人不默认可见。`;
  const member=subject.kind === "member" ? roster.members.find(m=>m.id===subject.membershipId) : undefined;
  return member&&!member.isMe ? `${member.name}将能查看并记录完成，无需接受。不会自动开启对方提醒。` : "普通事项由创建者管理；查看、代记和提醒分别选择。";
}
