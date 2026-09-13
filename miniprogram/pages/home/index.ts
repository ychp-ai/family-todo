import type { ReminderDTO, TaskListInput, TaskListItem, FamilySummary, Subject } from "@family-todo/contracts";
import { personalApi, PersonalApiError, isAccessDenied } from "../../services/personal-api";
import { listReminders, listTasks } from "../../services/personal-lists";
import { dateAt, dateCaption, errorMessage, navigationMetrics, occurrenceRef, personalDraft, readySession } from "../../services/personal-view";

import { familyApi, listFamilies } from "../../services/family-api";
import { occurrenceGroup, accessInput, permissionRows, subjectOptions, subjectNotice } from "../../services/collaboration-draft";
import type { Roster, PermissionRow, SubjectOption } from "../../services/collaboration-draft";
type Card = TaskListItem & { id: string; statusLabel: string; group:string };
function cards(items: TaskListItem[],families:FamilySummary[],userId:string): Card[] { return items.map(item => ({...item,id:item.task.id,statusLabel:item.occurrence.status === "completed" ? `由${item.occurrence.operatorName ?? "家人"}记录完成` : item.occurrence.status === "skipped" ? `由${item.occurrence.operatorName ?? "家人"}跳过本次` : "",group:occurrenceGroup(item.occurrence,userId,families)})); }
function groups(items:Card[]) {return ["我来做","帮家人","关心一下"].map(name=>({name,items:items.filter(i=>i.group===name)})).filter(g=>g.items.length);}
Page({
  data: {statusHeight:0,navHeight:44,capsuleWidth:100,status:"loading",error:"",today:"",tomorrow:"",todayDay:"",tomorrowDay:"",greeting:"",tab:"today",selectedDate:"",familyOptions:["全部家庭","仅个人"],familyIndex:0,
    families:[] as FamilySummary[],groups:[] as {name:string;items:Card[]}[],pendingCount:0,quickFamilyIndex:0,quickFamilyOptions:["个人事项"],quickSubjectOptions:[] as SubjectOption[],quickSubjectNames:["自己"],quickSubjectIndex:0,quickRows:[] as PermissionRow[],quickNotice:"个人事项 · 仅自己可见",quickLoading:false,items:[] as Card[],visibleItems:[] as Card[],backlog:[] as Card[],reminders:[] as (ReminderDTO & {id:string})[],reminderCount:0,reminderError:"",summaryText:"—",progress:0,hideCompleted:false,
    sheet:"",quickTitle:"",quickDate:"today",quickTime:"",quickNote:"",quickReminder:true,expanded:false,quickError:"",quickSuccess:"",saving:false,uncertain:false,writing:false,includeDismissed:false},
  quickRoster:null as Roster|null,quickSubject:{kind:"self"} as Subject,quickEpoch:0,visible:false,alive:true,epoch:0,pendingWrite:null as null | {key:string;run:()=>Promise<unknown>;done:()=>void},timer:undefined as ReturnType<typeof setTimeout> | undefined,lastRefresh:0,retries:0,
  onLoad() { this.setData(navigationMetrics()); },
  onShow() { this.visible = true; this.setData({pendingCount:personalApi.pendingCount}); void this.refresh(); },
  onHide() { this.stop();this.quickEpoch++;this.quickRoster=null;this.setData({sheet:"",items:[],visibleItems:[],groups:[],backlog:[],reminders:[],quickRows:[],quickSubjectOptions:[]}); }, onUnload() { this.alive=false; this.stop(); },
  stop() { this.visible = false; this.epoch++; if (this.timer) clearTimeout(this.timer); },
  schedule(delay: number) { if (this.timer) clearTimeout(this.timer); if (this.visible) this.timer=setTimeout(() => {void this.refresh();},delay); },
  async refresh() {
    if (!this.visible || this.pendingWrite || this.data.writing || this.data.saving) return; const epoch=++this.epoch; this.lastRefresh=Date.now(); if (this.timer) clearTimeout(this.timer);
    this.setData({status:"loading",error:"",items:[],visibleItems:[],groups:[],backlog:[],reminders:[],summaryText:"—",progress:0});
    try {
      const user=await readySession();
      const familyResult=await listFamilies();
      if(epoch!==this.epoch||!this.visible)return;
      const selectedId=this.data.familyIndex>1?this.data.families[this.data.familyIndex-2]?.id:undefined;
      const familyIndex=this.data.familyIndex===1?1:selectedId&&familyResult.items.some(f=>f.id===selectedId)?familyResult.items.findIndex(f=>f.id===selectedId)+2:0;
      const familyId=familyIndex===1?null:familyIndex>1?familyResult.items[familyIndex-2]?.id:undefined;
      this.setData({families:familyResult.items,familyOptions:["全部家庭","仅个人",...familyResult.items.map(f=>f.name)],familyIndex,quickFamilyOptions:["个人事项",...familyResult.items.map(f=>f.name)]});
      const scope=familyId===undefined?{}:{familyId};
      const input: TaskListInput = this.data.tab === "unscheduled" ? {unscheduled:true} : this.data.tab === "tomorrow" ? {dateFrom:this.data.tomorrow,dateTo:this.data.tomorrow} : this.data.tab === "calendar" ? {dateFrom:this.data.selectedDate,dateTo:this.data.selectedDate} : {};
      const [tasks,reminders,backlog] = await Promise.allSettled([listTasks({...input,...scope}),listReminders(this.data.includeDismissed),listTasks({overdue:true,...scope})]);
      if (epoch !== this.epoch || !this.visible) return;
      if (tasks.status === "rejected") throw tasks.reason;
      const failed=tasks.value.last.scopes.some(scope=>scope.status!=="ok");const items=cards(tasks.value.items,familyResult.items,user.id); const summary=tasks.value.last.summary; const today=dateAt(tasks.value.last.asOf); const tomorrow=dateAt(tasks.value.last.asOf,1);
      this.setData({status:items.length ? "ready" : failed ? "error" : "empty",items,groups:groups(items.filter(i=>!this.data.hideCompleted||i.occurrence.status==="pending")),visibleItems:items.filter(i => !this.data.hideCompleted || i.occurrence.status === "pending"),today,tomorrow,todayDay:String(Number(today.slice(-2))),tomorrowDay:String(Number(tomorrow.slice(-2))),greeting:dateCaption(today),
        summaryText:summary ? `已完成 ${summary.completed} / ${summary.denominator} 件${summary.skipped ? ` · 跳过 ${summary.skipped}` : ""}` : "数据未完整加载 · 暂不汇总",progress:summary?.denominator ? summary.completed/summary.denominator*100 : 0,
        ...(reminders.status === "fulfilled" ? {reminders:reminders.value.items.map(item=>({...item,id:item.occurrence.id})),reminderCount:reminders.value.items.filter(i => !i.dismissedAt).length,reminderError:reminders.value.last.scopes.some(s=>s.status!=="ok")?"部分家庭提醒暂未加载，点击重试":""} : {reminders:[],reminderCount:0,reminderError:"提醒暂未加载，点击重试"}),
        ...(backlog.status === "fulfilled" ? {backlog:cards(backlog.value.items,familyResult.items,user.id)} : {}),error:failed ? "部分家庭未完整加载，请重试。" : backlog.status === "rejected" || backlog.value.last.scopes.some(s=>s.status!=="ok") ? "过去未完成暂未完整加载，请重试。" : ""});
      this.retries=0; this.schedule(30000);
    } catch (error) {
      if (epoch !== this.epoch || !this.visible) return;
      this.setData({status:"error",error:errorMessage(error),summaryText:"—",progress:0,items:[],visibleItems:[],groups:[],backlog:[],reminders:[],reminderCount:0,reminderError:"提醒暂未加载，点击重试"});
      const delay=[5000,15000,30000][this.retries++]; if (delay && (!(error instanceof PersonalApiError) || error.retryable || error.code === "CURSOR_EXPIRED")) this.schedule(delay);
    }
  },
  retry() { this.retries=0; void this.refresh(); },
  changeTab(event: WechatMiniprogram.TouchEvent) { const tab: unknown=event.currentTarget.dataset.tab; if (typeof tab !== "string" || !this.data.today) return; this.setData({tab,items:[],visibleItems:[]}); void this.refresh(); },
  pickDate(event: WechatMiniprogram.PickerChange) { const value=event.detail.value; if (typeof value !== "string") return; this.setData({tab:"calendar",selectedDate:value,items:[],visibleItems:[]}); void this.refresh(); },
  familyChange(event: WechatMiniprogram.PickerChange) { this.epoch++;this.setData({familyIndex:Number(event.detail.value),items:[],visibleItems:[],groups:[],backlog:[]}); void this.refresh(); },
  toggleCompleted() { const hideCompleted=!this.data.hideCompleted; const visibleItems=this.data.items.filter(i => !hideCompleted || i.occurrence.status === "pending");this.setData({hideCompleted,visibleItems,groups:groups(visibleItems)}); },
  futureFeature() { wx.showToast({title:"批量共享尚未开放，可在事项设置中逐项共享",icon:"none"}); },
  openFamilies(){wx.navigateTo({url:"/pages/families/index"});},
  async retryPending(){if(this.data.writing)return;this.setData({writing:true});try{await personalApi.retryPending();this.pendingWrite=null;this.setData({uncertain:false,quickError:"",sheet:""});wx.showToast({title:"操作结果已确认",icon:"success"});}catch(error){if(isAccessDenied(error)){this.pendingWrite=null;this.clearSensitive();}this.setData({quickError:errorMessage(error)});}finally{this.setData({writing:false,pendingCount:personalApi.pendingCount});if(!personalApi.pendingCount)void this.refresh();}},
  openTask(event: WechatMiniprogram.TouchEvent) { const id:unknown=event.currentTarget.dataset.id; if (typeof id === "string") {this.setData({sheet:""}); wx.navigateTo({url:`/pages/detail/index?id=${encodeURIComponent(id)}`});} },
  async runWrite(key:string,run:()=>Promise<unknown>,done:()=>void=()=>{}) {
    if(this.data.writing || this.data.saving)return;
    if(this.pendingWrite && this.pendingWrite.key!==key){wx.showToast({title:"请先重试上次操作，确认结果",icon:"none"});return;}
    this.pendingWrite??={key,run,done};this.epoch++;if(this.timer)clearTimeout(this.timer);
    this.setData({writing:true,quickError:""});
    try{await this.pendingWrite.run();const finish=this.pendingWrite.done;this.pendingWrite=null;if(this.alive){this.setData({uncertain:false});finish();}}
    catch(error){const uncertain=error instanceof PersonalApiError&&error.retryable;if(!uncertain)this.pendingWrite=null;if(this.alive){if(isAccessDenied(error))this.clearSensitive();this.setData({quickError:errorMessage(error),uncertain});wx.showToast({title:errorMessage(error),icon:"none"});}}
    finally{if(this.alive)this.setData({writing:false});if(this.alive)this.setData({pendingCount:personalApi.pendingCount});if(!this.pendingWrite&&this.visible)void this.refresh();}
  },
  clearSensitive(){this.epoch++;this.quickEpoch++;this.quickRoster=null;this.quickSubject={kind:"self"};this.setData({status:"error",items:[],visibleItems:[],groups:[],backlog:[],reminders:[],reminderCount:0,summaryText:"—",progress:0,sheet:"",quickTitle:"",quickNote:"",quickTime:"",quickRows:[],quickSubjectOptions:[],quickSubjectNames:["自己"],quickNotice:"",quickLoading:false});},
  async toggleTask(event: WechatMiniprogram.TouchEvent) {
    const id:unknown=event.currentTarget.dataset.id;const item=[...this.data.items,...this.data.backlog].find(i=>i.task.id===id);if(!item||!item.occurrence.canRecord)return;
    const payload={occurrence:occurrenceRef(item.occurrence),expectedVersion:item.occurrence.version};
    await this.runWrite(`toggle:${item.task.id}`,()=>item.occurrence.status==="pending"?personalApi.write("occurrence.record",{...payload,status:"completed"}):personalApi.write("occurrence.undo",payload));
  },
  openQuick() { if (!this.data.today) return; this.setData({sheet:"quick",quickDate:this.data.tab === "tomorrow" ? "tomorrow" : this.data.tab === "unscheduled" ? "unscheduled" : "today",quickSuccess:""}); if(!this.data.uncertain){this.setData({quickFamilyIndex:this.data.familyIndex>1?this.data.familyIndex-1:0});void this.loadQuickFamily();} },
  openReminders() { this.setData({sheet:"reminders"}); if (this.data.reminderError) void this.refresh(); },
  openBacklog() { this.setData({sheet:"backlog"}); },
  closeSheet() { if (this.data.writing || this.data.saving || this.data.uncertain) {wx.showToast({title:"请先重试确认本次保存结果",icon:"none"});return;} this.setData({sheet:""}); }, noop() {},
  quickTitleInput(e: WechatMiniprogram.Input) { this.setData({quickTitle:e.detail.value}); },
  quickNoteInput(e: WechatMiniprogram.Input) { this.setData({quickNote:e.detail.value}); },
  quickDateChange(e: WechatMiniprogram.TouchEvent) { if (this.data.uncertain) return; const value:unknown=e.currentTarget.dataset.date; if (typeof value === "string") this.setData({quickDate:value,...(value === "unscheduled" ? {quickTime:""} : {})}); },
  quickTimeChange(e: WechatMiniprogram.PickerChange) { if (typeof e.detail.value === "string") this.setData({quickTime:e.detail.value}); },
  quickReminderChange(e: WechatMiniprogram.CheckboxGroupChange) { this.setData({quickReminder:e.detail.value.includes("enabled")}); },
  expand() { this.setData({expanded:!this.data.expanded}); },
  async saveQuick(e: WechatMiniprogram.TouchEvent) {
    if(this.data.quickLoading)return;
    if(!this.data.quickTitle.trim()){this.setData({quickError:"先写下要做的事情。"});return;}
    const keep:unknown=e.currentTarget.dataset.keep;
    const date=this.data.quickDate==="unscheduled"?null:this.data.quickDate==="tomorrow"?this.data.tomorrow:this.data.today;
    const draft=personalDraft(this.data.quickTitle,date,this.data.quickTime||null,this.data.quickNote,this.data.quickReminder);draft.familyId=this.quickRoster?.family.id??null;draft.subject=this.quickSubject;draft.access=accessInput(this.data.quickRows,this.data.quickReminder);const payload={draft};
    await this.runWrite("quick",()=>personalApi.write("task.create",payload),()=>this.setData({quickTitle:"",quickNote:"",quickError:"",quickSuccess:"已保存，继续记下一件吧。",...(keep==="yes"?{}:{sheet:""})}));
  },
  async dismissReminder(e: WechatMiniprogram.TouchEvent) {
    const id:unknown=e.currentTarget.dataset.id;const item=this.data.reminders.find(i=>i.occurrence.id===id);if(!item)return;
    const payload={occurrence:item.occurrence};await this.runWrite(`dismiss:${item.occurrence.id}`,()=>personalApi.write("reminder.dismiss",payload));
  },
  async reminderDetail(e: WechatMiniprogram.TouchEvent) {
    const id:unknown=e.currentTarget.dataset.id;const item=this.data.reminders.find(i=>i.occurrence.taskId===id);if(!item)return;
    const payload={occurrence:item.occurrence};await this.runWrite(`read:${item.occurrence.id}`,()=>personalApi.write("reminder.markRead",payload),()=>{if(this.visible)this.openTask(e);});
  },
  toggleDismissed() {this.setData({includeDismissed:!this.data.includeDismissed});void this.refresh();},
  quickFamilyChange(e:WechatMiniprogram.PickerChange){if(this.data.uncertain||this.data.writing)return;this.setData({quickFamilyIndex:Number(e.detail.value)});void this.loadQuickFamily();},
  async loadQuickFamily(){const epoch=++this.quickEpoch;const family=this.data.families[this.data.quickFamilyIndex-1];this.setData({quickLoading:true,quickRows:[],quickError:""});this.quickRoster=null;try{const roster=family?await familyApi.read("family.get",{id:family.id}):null;if(!this.alive||epoch!==this.quickEpoch)return;this.quickRoster=roster;this.quickSubject=roster?{kind:"member",membershipId:roster.family.myMembershipId}:{kind:"self"};const options=roster?subjectOptions(roster):[{name:"自己",subject:{kind:"self" as const}}];const index=roster?options.findIndex(o=>o.subject.kind==="member"&&o.subject.membershipId===roster.family.myMembershipId):0;this.setData({quickSubjectOptions:options,quickSubjectNames:options.map(o=>o.name),quickSubjectIndex:index,quickRows:roster?permissionRows(roster,this.quickSubject):[],quickNotice:subjectNotice(this.quickSubject,roster),quickLoading:false});}catch(error){if(this.alive&&epoch===this.quickEpoch)this.setData({quickError:errorMessage(error),quickLoading:true});}},
  retryQuickFamily(){void this.loadQuickFamily();},
  quickSubjectChange(e:WechatMiniprogram.PickerChange){if(this.data.uncertain||this.data.writing)return;const index=Number(e.detail.value);const option=this.data.quickSubjectOptions[index];if(!option)return;this.quickSubject=option.subject;this.setData({quickSubjectIndex:index,quickRows:this.quickRoster?permissionRows(this.quickRoster,this.quickSubject,this.data.quickRows):[],quickNotice:subjectNotice(this.quickSubject,this.quickRoster)});},
  quickViewersChange(e:WechatMiniprogram.CheckboxGroupChange){if(this.data.uncertain||this.data.writing)return;this.setData({quickRows:this.data.quickRows.map(r=>({...r,canView:r.requiredViewer||e.detail.value.includes(r.membershipId)}))});},
  openRecycle() {wx.navigateTo({url:"/pages/recycle/index"});},
});
