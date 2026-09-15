import { readCreateFamily, rememberCreateFamily } from "../../services/create-family";
import { patchData } from "../../services/patch-data";
import { componentActions } from "../../services/component-events";
import { InputRecovery, captureRecoveryIdentity, isRecoveryIdentityCurrent } from "../../services/input-recovery";
import type { DraftInput, RecoveryIdentity } from "../../services/input-recovery";
import { draftSchedule } from "../../services/schedule-draft";
import { saveEditorSeed } from "../../services/editor-seed";
import { batchPayload, retryFailedBatch, selectTask } from "../../services/batch-viewers";
import type { BatchGroup } from "../../services/batch-viewers";
import type { ReminderDTO, TaskListInput, TaskListItem, FamilySummary, Subject, TaskDTO, BatchItemResult } from "@family-todo/contracts";
import { personalApi, PersonalApiError, isAccessDenied } from "../../services/personal-api";
import { listReminders, listTasks } from "../../services/personal-lists";
import { dateAt, dateCaption, errorMessage, navigationMetrics, occurrenceUrl, occurrenceRef, personalDraft, readySession } from "../../services/personal-view";

import { familyApi, listFamilies } from "../../services/family-api";
import { occurrenceGroup, accessInput, permissionRows, subjectOptions, subjectNotice } from "../../services/collaboration-draft";
import type { Roster, PermissionRow, SubjectOption } from "../../services/collaboration-draft";
type Card = TaskListItem & { id: string; statusLabel: string; group:string; selected:boolean };
function cards(items: TaskListItem[],families:FamilySummary[],userId:string): Card[] { return items.map(item => ({...item,id:item.occurrence.id,selected:false,statusLabel:item.occurrence.status === "completed" ? `由${item.occurrence.operatorName ?? "家人"}记录完成` : item.occurrence.status === "skipped" ? `由${item.occurrence.operatorName ?? "家人"}跳过本次` : "",group:occurrenceGroup(item.occurrence,userId,families)})); }
function groups(items:Card[]) {return ["我来做","帮家人","关心一下"].map(name=>({name,items:items.filter(i=>i.group===name)})).filter(g=>g.items.length);}
Page({
  onComponentAction: componentActions(["batchFamilyChange", "batchViewersChange", "changeTab", "dismissReminder", "expand", "familyChange", "fullEditor", "futureFeature", "openReminders", "openTask", "pickDate", "quickDateChange", "quickFamilyChange", "quickNoteInput", "quickReminderChange", "quickRepeatChange", "quickSubjectChange", "quickTimeChange", "quickTitleInput", "quickViewersChange", "reminderDetail", "retryQuickFamily", "saveQuick", "toggleTask"]),
  data: {listRefreshing:false,refreshing:false,batchMode:false,selectedTasks:[] as TaskDTO[],selectedIds:[] as string[],batchGroups:[] as BatchGroup[],batchResults:[] as (BatchItemResult&{label:string})[],batchComplete:false,batchHasFailures:false,batchBusy:false,batchError:"",batchFamilyOptions:["请选择家庭"],statusHeight:0,navHeight:44,capsuleWidth:100,status:"loading",error:"",today:"",tomorrow:"",greeting:"",tab:"today",selectedDate:"",familyOptions:["全部家庭","仅个人"],familyIndex:0,
    families:[] as FamilySummary[],groups:[] as {name:string;items:Card[]}[],pendingCount:0,quickFamilyIndex:0,quickFamilyOptions:["个人事项"],quickSubjectOptions:[] as SubjectOption[],quickSubjectNames:["自己"],quickSubjectIndex:0,quickRows:[] as PermissionRow[],quickNotice:"个人事项 · 仅自己可见",quickLoading:false,items:[] as Card[],visibleItems:[] as Card[],backlog:[] as Card[],reminders:[] as (ReminderDTO & {id:string})[],reminderCount:0,reminderError:"",summaryText:"—",progress:0,hideCompleted:true,
    sheet:"",quickTitle:"",quickDate:"today",quickTime:"",quickRepeatIndex:0,quickRepeatOptions:["不重复","每天"],quickNote:"",quickReminder:true,expanded:false,quickError:"",quickSuccess:"",saving:false,uncertain:false,writing:false,writingKey:"",includeDismissed:false},
  quickIdentity:null as RecoveryIdentity|null,quickRecovery:null as InputRecovery|null,quickDirty:false,quickTransferred:false,batchEpoch:0,quickRoster:null as Roster|null,quickSubject:{kind:"self"} as Subject,quickEpoch:0,visible:false,alive:true,epoch:0,pendingWrite:null as null | {key:string;run:()=>Promise<unknown>;done:()=>void},timer:undefined as ReturnType<typeof setTimeout> | undefined,lastRefresh:0,retries:0,
  cacheUserId:"",cacheRevision:-1,cacheAt:0,
  onLoad() { patchData(this, navigationMetrics()); },
  async onShow() {
    this.visible = true; const epoch=this.epoch;
    try {
      const user=await readySession();
      if(!this.visible||epoch!==this.epoch)return;
      if(this.cacheUserId&&this.cacheUserId!==user.id){this.clearSensitive();patchData(this, {families:[],familyIndex:0,familyOptions:["全部家庭","仅个人"]});}
      this.syncBatch();patchData(this, {pendingCount:personalApi.pendingCount});
      const age=Date.now()-this.cacheAt;
      if(this.cacheUserId===user.id&&this.cacheRevision===personalApi.readRevision&&this.cacheAt>0&&age>=0&&age<30000&&this.data.today===dateAt(new Date().toISOString())){this.schedule(30000-age);return;}
      await this.refresh();
    } catch(error) { if(this.visible&&epoch===this.epoch){this.clearSensitive();patchData(this, {error:errorMessage(error)});} }
  },
  async pullRefresh() {
    if(this.data.refreshing)return;
    patchData(this, {refreshing:true});
    try { this.retries=0;await this.refresh(); }
    finally { if(this.alive)patchData(this, {refreshing:false}); }
  },
  onHide() { this.persistQuick();this.stop();this.batchEpoch++;this.quickEpoch++;this.quickRoster=null;patchData(this, {batchMode:false,sheet:"",refreshing:false,listRefreshing:false,items:this.data.items.map(i=>({...i,selected:false})),visibleItems:this.data.visibleItems.map(i=>({...i,selected:false})),groups:groups(this.data.visibleItems.map(i=>({...i,selected:false}))),backlog:this.data.backlog.map(i=>({...i,selected:false})),quickRows:[],quickSubjectOptions:[],selectedTasks:[],selectedIds:[],batchGroups:[],batchResults:[]}); }, onUnload() { this.persistQuick();this.alive=false; this.stop();this.batchEpoch++; },
  stop() { this.visible = false; this.epoch++; if (this.timer) clearTimeout(this.timer); },
  schedule(delay: number) { if (this.timer) clearTimeout(this.timer); if (this.visible) this.timer=setTimeout(() => {void this.refresh();},delay); },
  async refresh(mode: "all" | {tasks:boolean;backlog:boolean} = "all") {
    if (!this.visible || this.pendingWrite || this.data.writing || this.data.saving || this.data.batchBusy || this.data.batchMode) return; this.cacheAt=0;const epoch=++this.epoch;const reminderEpoch=this.reminderEpoch; this.lastRefresh=Date.now(); if (this.timer) clearTimeout(this.timer);
    const completeData=["ready","empty"].includes(this.data.status)&&!this.data.error;
    patchData(this, {error:"",...(!["ready","empty"].includes(this.data.status)?{status:"loading"}:{})});
    try {
      const user=await readySession();
      if(epoch!==this.epoch||!this.visible)return;
      if(this.cacheUserId&&this.cacheUserId!==user.id){this.clearSensitive();return;}
      const revision=personalApi.readRevision;
      this.syncBatch();
      patchData(this, {pendingCount:personalApi.pendingCount,quickError:personalApi.recoveryError});
      const current=()=>this.visible&&epoch===this.epoch;
      const selectedId=this.data.familyIndex>1?this.data.families[this.data.familyIndex-2]?.id:undefined;
      const personalOnly=this.data.familyIndex===1;
      const input: TaskListInput = this.data.tab === "unscheduled" ? {unscheduled:true} : this.data.tab === "tomorrow" ? {dateFrom:dateAt(new Date().toISOString(),1),dateTo:dateAt(new Date().toISOString(),1)} : this.data.tab === "calendar" ? {dateFrom:this.data.selectedDate,dateTo:this.data.selectedDate} : {};
      // Recording an occurrence does not change families; business reads still check access.
      const reuseFamilies=mode!=="all"&&this.cacheUserId===user.id&&completeData&&this.data.today===dateAt(new Date().toISOString());
      const refreshTasks=!reuseFamilies||mode.tasks;
      const refreshBacklog=!reuseFamilies||mode.backlog;
      const familiesPromise=reuseFamilies?Promise.resolve({items:this.data.families}):listFamilies();
      // Only a selected family needs the membership list to resolve its scope.
      const scopePromise=selectedId?familiesPromise.then(result=>result.items.some(f=>f.id===selectedId)?{familyId:selectedId}:{}):Promise.resolve(personalOnly?{familyId:null}:{});
      const reads=Promise.allSettled([
        refreshTasks?scopePromise.then(scope=>current()?listTasks({...input,...scope},current):Promise.reject(new Error("已切换查看范围。"))):Promise.resolve(null),
        listReminders(this.data.includeDismissed,current),
        refreshBacklog?scopePromise.then(scope=>current()?listTasks({overdue:true,...scope},current):Promise.reject(new Error("已切换查看范围。"))):Promise.resolve(null)
      ]);
      const familyResult=await familiesPromise;
      if(!current())return;
      const familyIndex=personalOnly?1:selectedId&&familyResult.items.some(f=>f.id===selectedId)?familyResult.items.findIndex(f=>f.id===selectedId)+2:0;
      patchData(this, {families:familyResult.items,familyOptions:["全部家庭","仅个人",...familyResult.items.map(f=>f.name)],familyIndex,quickFamilyOptions:["个人事项",...familyResult.items.map(f=>f.name)]});
      const [tasks,reminders,backlog] = await reads;
      if (epoch !== this.epoch || !this.visible) return;
      if (tasks.status === "rejected") throw tasks.reason;
      const failed=tasks.value?.last.scopes.some(scope=>scope.status!=="ok")??false;
      if(tasks.value){
        const items=cards(tasks.value.items,familyResult.items,user.id),summary=tasks.value.last.summary;
        const today=dateAt(tasks.value.last.asOf),tomorrow=dateAt(tasks.value.last.asOf,1);
        const visibleItems=items.filter(i=>!this.data.hideCompleted||i.occurrence.status==="pending");
        patchData(this, {status:items.length ? "ready" : failed ? "error" : "empty",items,groups:groups(visibleItems),visibleItems,today,tomorrow,greeting:dateCaption(today),
          summaryText:summary ? `已完成 ${summary.completed} / ${summary.denominator} 件${summary.skipped ? ` · 跳过 ${summary.skipped}` : ""}` : "数据未完整加载 · 暂不汇总",progress:summary?.denominator ? summary.completed/summary.denominator*100 : 0});
      }
      patchData(this, {
        ...(reminderEpoch!==this.reminderEpoch?{}:reminders.status === "fulfilled" ? {reminders:reminders.value.items.map(item=>({...item,id:item.occurrence.id})),reminderCount:reminders.value.items.filter(i => !i.dismissedAt).length,reminderError:reminders.value.last.scopes.some(s=>s.status!=="ok")?"部分家庭提醒暂未加载，点击重试":""} : {reminders:[],reminderCount:0,reminderError:"提醒暂未加载，点击重试"}),
        ...(backlog.status === "fulfilled" && backlog.value ? {backlog:cards(backlog.value.items,familyResult.items,user.id)} : {}),error:failed ? "部分家庭未完整加载，请重试。" : backlog.status === "rejected" || backlog.value?.last.scopes.some(s=>s.status!=="ok") ? "过去未完成暂未完整加载，请重试。" : ""});
      this.cacheUserId=user.id;this.cacheRevision=revision;this.cacheAt=failed||this.data.error||this.data.reminderError?0:Date.now();
      this.retries=0; this.schedule(30000);
    } catch (error) {
      if (epoch !== this.epoch || !this.visible) return;
      patchData(this, {status:"error",error:errorMessage(error),summaryText:"—",progress:0,items:[],visibleItems:[],groups:[],backlog:[],reminders:[],reminderCount:0,reminderError:"提醒暂未加载，点击重试"});
      const delay=[5000,15000,30000][this.retries++]; if (delay && (!(error instanceof PersonalApiError) || error.retryable || error.code === "CURSOR_EXPIRED")) this.schedule(delay);
    } finally {
      if(this.alive&&epoch===this.epoch)patchData(this, {listRefreshing:false});
    }
  },
  retry() { this.retries=0; void this.refresh(); },
  changeTab(event: WechatMiniprogram.TouchEvent) { const tab: unknown=event.currentTarget.dataset.tab; if (typeof tab !== "string" || !this.data.today) return; this.resetBatchSelection();this.cacheAt=0;this.epoch++;patchData(this, {tab,items:[],visibleItems:[],groups:[]}); void this.refresh(); },
  pickDate(event: WechatMiniprogram.PickerChange) { const value=event.detail.value; if (typeof value !== "string") return; this.resetBatchSelection();this.cacheAt=0;this.epoch++;patchData(this, {tab:"calendar",selectedDate:value,items:[],visibleItems:[],groups:[]}); void this.refresh(); },
  familyChange(event: WechatMiniprogram.PickerChange) { this.resetBatchSelection();this.cacheAt=0;this.epoch++;patchData(this, {familyIndex:Number(event.detail.value),items:[],visibleItems:[],groups:[],backlog:[]}); void this.refresh(); },
  toggleCompleted() { const hideCompleted=!this.data.hideCompleted; const visibleItems=this.data.items.filter(i => !hideCompleted || i.occurrence.status === "pending");patchData(this, {hideCompleted,visibleItems,groups:groups(visibleItems)}); },
  resetBatchSelection(){this.batchEpoch++;patchData(this, {batchMode:false,selectedTasks:[],selectedIds:[],batchGroups:[],batchError:""});},
  futureFeature() {if(this.data.writing||this.data.batchBusy)return;patchData(this, {batchMode:!this.data.batchMode,selectedTasks:[],selectedIds:[],batchError:""});if(!this.data.batchMode)void this.refresh();},
  selectTask(e:WechatMiniprogram.TouchEvent){const item=[...this.data.items,...this.data.backlog].find(i=>i.occurrence.id===e.currentTarget.dataset.id);if(!item||this.data.batchBusy)return;try{const selectedTasks=selectTask(this.data.selectedTasks,item.task);patchData(this, {selectedTasks,selectedIds:selectedTasks.map(t=>t.id),items:this.data.items.map(i=>({...i,selected:selectedTasks.some(t=>t.id===i.task.id)})),backlog:this.data.backlog.map(i=>({...i,selected:selectedTasks.some(t=>t.id===i.task.id)})),batchError:""});patchData(this, {groups:groups(this.data.items.filter(i=>!this.data.hideCompleted||i.occurrence.status==="pending"))});}catch(error){patchData(this, {batchError:errorMessage(error)});}},
  async openBatch(){if(!this.data.selectedTasks.length||this.data.batchBusy)return;const epoch=++this.batchEpoch;const groups:BatchGroup[]=[];for(const task of this.data.selectedTasks){const key=task.familyId??"personal";const group=groups.find(g=>g.key===key);if(group)group.taskIds.push(task.id);else groups.push({key,name:task.familyName??"个人事项",taskIds:[task.id],targetFamilyId:task.familyId??"",familyIndex:0,viewers:[],loading:!!task.familyId,error:""});}patchData(this, {sheet:"batch",batchGroups:groups,batchFamilyOptions:["请选择家庭",...this.data.families.map(f=>f.name)],batchError:"",batchResults:[],batchComplete:false});await Promise.all(groups.filter(group=>group.targetFamilyId).map(group=>this.loadBatchGroup(group.key,group.targetFamilyId,epoch)));},
  clearFamilyAccess(familyId:string){this.cacheAt=0;this.epoch++;this.quickEpoch++;if(this.timer)clearTimeout(this.timer);const selectedTasks=this.data.selectedTasks.filter(t=>t.familyId!==familyId),items=this.data.items.filter(i=>i.task.familyId!==familyId),visibleItems=this.data.visibleItems.filter(i=>i.task.familyId!==familyId),families=this.data.families.filter(f=>f.id!==familyId),reminders=this.data.reminders.filter(r=>r.familyId!==familyId);const deniedTasks=new Set([...this.data.selectedTasks,...this.data.items.map(i=>i.task),...this.data.backlog.map(i=>i.task)].filter(t=>t.familyId===familyId).map(t=>t.id));if(this.quickRoster?.family.id===familyId){this.discardQuick();this.quickRoster=null;this.quickSubject={kind:"self"};patchData(this, {quickTitle:"",quickNote:"",quickRows:[],quickSubjectOptions:[],quickSubjectNames:[],quickNotice:"",quickLoading:false});}patchData(this, {families,familyOptions:["全部家庭","仅个人",...families.map(f=>f.name)],familyIndex:0,quickFamilyOptions:["个人事项",...families.map(f=>f.name)],quickFamilyIndex:0,batchFamilyOptions:["请选择家庭",...families.map(f=>f.name)],selectedTasks,selectedIds:selectedTasks.map(t=>t.id),items,visibleItems,groups:groups(visibleItems),backlog:this.data.backlog.filter(i=>i.task.familyId!==familyId),reminders,reminderCount:reminders.filter(r=>!r.dismissedAt).length,batchGroups:this.data.batchGroups.filter(g=>g.key!==familyId&&g.targetFamilyId!==familyId),batchResults:this.data.batchResults.filter(r=>!deniedTasks.has(r.taskId)),summaryText:"—",progress:0,...(!selectedTasks.length?{batchMode:false,sheet:""}:{})});},
  async loadBatchGroup(key:string,familyId:string,epoch:number){try{const roster=await familyApi.read("family.get",{id:familyId});if(!this.visible||epoch!==this.batchEpoch)return;patchData(this, {batchGroups:this.data.batchGroups.map(g=>g.key===key?{...g,loading:false,viewers:roster.members.map(m=>({id:m.id,name:m.name,checked:false}))}:g)});}catch(error){if(this.visible&&epoch===this.batchEpoch){if(isAccessDenied(error))this.clearFamilyAccess(familyId);else patchData(this, {batchGroups:this.data.batchGroups.map(g=>g.key===key?{...g,loading:false,viewers:[],error:errorMessage(error)}:g)});patchData(this, {batchError:errorMessage(error)});}}},
  async batchFamilyChange(e:WechatMiniprogram.PickerChange){if(this.data.batchBusy||personalApi.pendingCount)return;if(this.data.batchGroups.some(g=>g.key!=="personal"&&g.loading))return;const index=Number(e.detail.value);const family=this.data.families[index-1];const epoch=++this.batchEpoch;patchData(this, {batchGroups:this.data.batchGroups.map(g=>g.key==="personal"?{...g,familyIndex:index,targetFamilyId:family?.id??"",viewers:[],loading:!!family,error:""}:g)});if(family)await this.loadBatchGroup("personal",family.id,epoch);},
  batchViewersChange(e:WechatMiniprogram.CheckboxGroupChange){if(this.data.batchBusy||personalApi.pendingCount)return;patchData(this, {batchGroups:this.data.batchGroups.map(g=>g.key===e.currentTarget.dataset.key?{...g,viewers:g.viewers.map(v=>({...v,checked:e.detail.value.includes(v.id)}))}:g)});},
  syncBatch(){const batch=personalApi.batch;const results=batch?.result?.results??[];const succeeded=new Set(results.filter(r=>r.status==="succeeded").map(r=>r.taskId));const denied=new Set(results.filter(r=>r.status==="failed"&&["FORBIDDEN","NOT_FOUND","FAMILY_NOT_FOUND"].includes(r.error.code)).map(r=>r.taskId));const selectedTasks=this.data.selectedTasks.filter(t=>!succeeded.has(t.id)&&!denied.has(t.id));patchData(this, {batchResults:results.map(r=>({...r,label:r.status==="succeeded"?"已增加可见人":r.status==="pending"?"待继续确认":r.error.message})),batchComplete:batch?.result?.complete??false,batchHasFailures:results.some(r=>r.status==="failed"),selectedTasks,selectedIds:selectedTasks.map(t=>t.id),items:this.data.items.filter(i=>!denied.has(i.task.id)),visibleItems:this.data.visibleItems.filter(i=>!denied.has(i.task.id)),backlog:this.data.backlog.filter(i=>!denied.has(i.task.id)),batchGroups:denied.size?[]:this.data.batchGroups,pendingCount:personalApi.pendingCount});if(denied.size)patchData(this, {groups:groups(this.data.visibleItems)});},
  async submitBatch(e:WechatMiniprogram.TouchEvent){if(this.data.batchBusy)return;const mode:unknown=e.currentTarget.dataset.mode;const epoch=++this.batchEpoch;patchData(this, {batchBusy:true,batchError:""});try{if(mode==="continue")await personalApi.continueBatch();else if(mode==="failed")await retryFailedBatch();else await personalApi.write("task.batchAddViewers",batchPayload(this.data.selectedTasks,this.data.batchGroups));if(this.visible&&epoch===this.batchEpoch){this.syncBatch();patchData(this, {sheet:"batch",batchMode:false});}}catch(error){if(this.visible&&epoch===this.batchEpoch){if(isAccessDenied(error)){const affectedFamilies=new Set(this.data.batchGroups.map(g=>g.targetFamilyId).filter(Boolean));for(const familyId of affectedFamilies)this.clearFamilyAccess(familyId);patchData(this, {selectedTasks:[],selectedIds:[],batchGroups:[],batchResults:[],batchMode:false,sheet:""});}patchData(this, {batchError:errorMessage(error)});}}finally{if(this.alive){patchData(this, {batchBusy:false,pendingCount:personalApi.pendingCount});}}},
  showBatchResult(){this.syncBatch();patchData(this, {sheet:"batch",batchGroups:[]});},
  async retryPending(){if(this.data.writing||this.data.batchBusy)return;patchData(this, {writing:true});try{await personalApi.retryPending();this.pendingWrite=null;this.syncBatch();patchData(this, {uncertain:false,quickError:"",sheet:personalApi.batch?"batch":""});wx.showToast({title:personalApi.pendingCount?"仍有待确认项目，请继续":"操作结果已确认",icon:"none"});}catch(error){if(isAccessDenied(error)){this.pendingWrite=null;this.clearSensitive();}patchData(this, {quickError:errorMessage(error)});}finally{patchData(this, {writing:false,pendingCount:personalApi.pendingCount});if(!personalApi.pendingCount)void this.refresh();}},
  openTask(event: WechatMiniprogram.TouchEvent) { if(this.data.batchMode){this.selectTask(event);return;}const id:unknown=event.currentTarget.dataset.id;const item=[...this.data.items,...this.data.backlog].find(i=>i.occurrence.id===id);if(item){patchData(this, {sheet:""});wx.navigateTo({url:occurrenceUrl(item.occurrence)});} },
  async runWrite(key:string,run:()=>Promise<unknown>,done:()=>void=()=>{}) {
    if(this.data.writing || this.data.saving || this.data.listRefreshing)return;
    if(this.pendingWrite && this.pendingWrite.key!==key){wx.showToast({title:"请先重试上次操作，确认结果",icon:"none"});return;}
    let succeeded=false;
    this.pendingWrite??={key,run,done};this.epoch++;if(this.timer)clearTimeout(this.timer);
    patchData(this, {writing:true,writingKey:key,listRefreshing:key.startsWith("toggle:"),quickError:""});
    try{await this.pendingWrite.run();succeeded=true;const finish=this.pendingWrite.done;this.pendingWrite=null;if(this.alive){patchData(this, {uncertain:false});finish();}}
    catch(error){const uncertain=error instanceof PersonalApiError&&error.retryable;if(!uncertain)this.pendingWrite=null;if(this.alive){if(isAccessDenied(error))this.clearSensitive();patchData(this, {quickError:errorMessage(error),uncertain});wx.showToast({title:errorMessage(error),icon:"none"});}}
    finally{if(this.alive)patchData(this, {writing:false,writingKey:""});if(this.alive)patchData(this, {pendingCount:personalApi.pendingCount});if(!this.pendingWrite&&this.visible){if(key.startsWith("dismiss:")||key.startsWith("read:"))void this.refreshReminders();else await this.refresh(succeeded&&key.startsWith("toggle:")?this.occurrenceRefreshScope(key.slice("toggle:".length)):"all");}else if(this.alive)patchData(this, {listRefreshing:false});}
  },
  clearSensitive(){this.cacheAt=0;this.cacheUserId="";this.discardQuick();this.epoch++;this.batchEpoch++;this.quickEpoch++;this.quickRoster=null;this.quickSubject={kind:"self"};patchData(this, {listRefreshing:false,status:"error",selectedTasks:[],selectedIds:[],batchGroups:[],batchResults:[],batchMode:false,items:[],visibleItems:[],groups:[],backlog:[],reminders:[],reminderCount:0,summaryText:"—",progress:0,sheet:"",quickTitle:"",quickNote:"",quickTime:"",quickRows:[],quickSubjectOptions:[],quickSubjectNames:["自己"],quickNotice:"",quickLoading:false});},
  occurrenceRefreshScope(id:string): "all" | {tasks:boolean;backlog:boolean} {
    const item=[...this.data.items,...this.data.backlog].find(i=>i.occurrence.id===id);
    if(!item)return "all";
    return {
      tasks:this.data.items.some(i=>i.occurrence.id===id),
      // An undone historical occurrence returns to backlog even when it was absent before the write.
      backlog:this.data.backlog.some(i=>i.occurrence.id===id)||(item.occurrence.localDate!==null&&item.occurrence.localDate<this.data.today)
    };
  },
  async toggleTask(event: WechatMiniprogram.TouchEvent) {
    if(this.data.batchMode){this.selectTask(event);return;}const id:unknown=event.currentTarget.dataset.id;const item=[...this.data.items,...this.data.backlog].find(i=>i.occurrence.id===id);if(!item||!item.occurrence.canRecord)return;
    const payload={occurrence:occurrenceRef(item.occurrence),expectedVersion:item.occurrence.version};
    await this.runWrite(`toggle:${item.occurrence.id}`,()=>item.occurrence.status==="pending"?personalApi.write("occurrence.record",{...payload,status:"completed"}):personalApi.write("occurrence.undo",payload));
  },
  quickDraftLocked(){return this.data.saving||(this.data.writing&&!this.data.listRefreshing)||this.data.uncertain;},
  async openQuick() { if (!this.data.today||this.quickDraftLocked()) return; patchData(this, {sheet:"quick",quickDate:this.data.tab === "tomorrow" ? "tomorrow" : this.data.tab === "unscheduled" ? "unscheduled" : "today",quickSuccess:""}); if(!this.data.uncertain){patchData(this, {quickFamilyIndex:this.data.familyIndex>1?this.data.familyIndex-1:0});await this.restoreQuick();} },
  reminderEpoch: 0,
  async refreshReminders() {
    const epoch=++this.reminderEpoch,pageEpoch=this.epoch;
    const current=()=>this.visible&&epoch===this.reminderEpoch&&pageEpoch===this.epoch;
    try {
      const result=await listReminders(this.data.includeDismissed,current);
      if(current())patchData(this, {reminders:result.items.map(item=>({...item,id:item.occurrence.id})),reminderCount:result.items.filter(item=>!item.dismissedAt).length,reminderError:result.last.scopes.some(scope=>scope.status!=="ok")?"部分家庭提醒暂未加载，点击重试":""});
    } catch(error) { if(current())patchData(this, {reminders:[],reminderCount:0,reminderError:errorMessage(error)}); }
    finally { if(current())this.schedule(30000); }
  },
  openReminders() { patchData(this, {sheet:"reminders"}); if (this.data.reminderError) void this.refreshReminders(); },
  openBacklog() { patchData(this, {sheet:"backlog"}); },
  async closeSheet() { if (this.data.batchBusy || (this.data.sheet === "quick" ? this.quickDraftLocked() : this.data.writing || this.data.saving || this.data.uncertain)) {wx.showToast({title:"请先重试确认本次保存结果",icon:"none"});return;} if(this.data.sheet==="quick"&&this.quickDirty){const answer=await wx.showModal({title:"保留未保存的输入？",content:"下次新增可恢复；放弃会删除本地草稿。",confirmText:"保留",cancelText:"放弃"});if(answer.confirm){if(!this.persistQuick())return;}else if(!this.discardQuick())return;}this.batchEpoch++;patchData(this, {sheet:""}); }, noop() {},
  quickTitleInput(e: WechatMiniprogram.Input) { if(this.quickDraftLocked())return;patchData(this, {quickTitle:e.detail.value}); this.quickDirty=true;this.persistQuick();},
  quickNoteInput(e: WechatMiniprogram.Input) { if(this.quickDraftLocked())return;patchData(this, {quickNote:e.detail.value}); this.quickDirty=true;this.persistQuick();},
  quickDateChange(e: WechatMiniprogram.TouchEvent) { if (this.quickDraftLocked()) return; const value:unknown=e.currentTarget.dataset.date; if (typeof value === "string") patchData(this, {quickDate:value,...(value === "unscheduled" ? {quickTime:""} : {})}); this.quickDirty=true;this.persistQuick();},
  quickTimeChange(e: WechatMiniprogram.PickerChange) { if(this.quickDraftLocked())return;if (typeof e.detail.value === "string") patchData(this, {quickTime:e.detail.value}); this.quickDirty=true;this.persistQuick();},
  quickReminderChange(e: WechatMiniprogram.CheckboxGroupChange) { if(this.quickDraftLocked())return;patchData(this, {quickReminder:e.detail.value.includes("enabled")}); this.quickDirty=true;this.persistQuick();},
  expand() { if(this.quickDraftLocked())return;patchData(this, {expanded:!this.data.expanded}); },
  quickRepeatChange(e:WechatMiniprogram.PickerChange){if(this.quickDraftLocked())return;patchData(this, {quickRepeatIndex:Number(e.detail.value)===1?1:0});this.quickDirty=true;this.persistQuick();},
  quickDraft(){const date=this.data.quickDate==="unscheduled"?null:this.data.quickDate==="tomorrow"?this.data.tomorrow:this.data.quickDate==="today"?this.data.today:this.data.quickDate;if(this.data.quickRepeatIndex===1&&!date)throw new Error("每日事项需要选择开始日期。");const draft=personalDraft(this.data.quickTitle,date,this.data.quickTime||null,this.data.quickNote,this.data.quickReminder);draft.schedule=draftSchedule({repeat:this.data.quickRepeatIndex===1?"daily":"once",date:date??"",time:this.data.quickTime,endDate:"",times:this.data.quickTime?[this.data.quickTime]:[],weekdays:[]});draft.familyId=this.quickRoster?.family.id??null;draft.subject=this.quickSubject;draft.access=accessInput(this.data.quickRows,this.data.quickReminder);return draft;},
  async saveQuick(e: WechatMiniprogram.TouchEvent) {
    if(this.data.quickLoading||this.data.saving||this.data.writing||this.data.listRefreshing)return;if(this.quickRecovery&&!this.quickRecovery.current){patchData(this, {quickError:"账号已变更，请重新进入后编辑。"});return;}if(this.quickRecovery&&personalApi.pendingCount&&!this.pendingWrite){patchData(this, {quickError:"请先重试确认上一次操作的结果。"});return;}
    if(this.pendingWrite){await this.runWrite("quick",async()=>{});return;}
    if(!this.data.quickTitle.trim()){patchData(this, {quickError:"先写下要做的事情。"});return;}
    const keep:unknown=e.currentTarget.dataset.keep;const epoch=this.quickEpoch;patchData(this, {saving:true,quickError:""});let payload;
    try{const draft=this.quickDraft();if(draft.schedule.kind!=="once"){const preview=await personalApi.read("task.previewSchedule",{schedule:draft.schedule});if(preview.excludedPastSlots)throw new Error("今天这个时刻已过，请选择未来时刻或从明天开始。");}if(!this.alive||epoch!==this.quickEpoch)return;payload={draft};}catch(error){if(this.alive&&epoch===this.quickEpoch)patchData(this, {quickError:errorMessage(error)});return;}finally{if(this.alive)patchData(this, {saving:false});}
    if(this.quickRecovery&&!this.persistQuick(true))return;const recovery=this.quickRecovery;const options=recovery?.record?{draftId:recovery.record.id}:undefined;await this.runWrite("quick",async()=>{const result=await personalApi.write("task.create",payload,...(options?[options]:[]));if(recovery?.current){recovery.remove();await recovery.start();}if(!recovery||recovery.current)this.quickDirty=false;return result;},()=>patchData(this, {quickTitle:"",quickNote:"",quickError:"",quickSuccess:"已保存，继续记下一件吧。",...(keep==="yes"?{}:{sheet:""})}));
  },
  async dismissReminder(e: WechatMiniprogram.TouchEvent) {
    const id:unknown=e.currentTarget.dataset.id;const item=this.data.reminders.find(i=>i.occurrence.id===id);if(!item)return;
    const payload={occurrence:item.occurrence};await this.runWrite(`dismiss:${item.occurrence.id}`,()=>personalApi.write("reminder.dismiss",payload));
  },
  async reminderDetail(e: WechatMiniprogram.TouchEvent) {
    const id:unknown=e.currentTarget.dataset.id;const item=this.data.reminders.find(i=>i.occurrence.id===id);if(!item)return;
    const payload={occurrence:item.occurrence};await this.runWrite(`read:${item.occurrence.id}`,()=>personalApi.write("reminder.markRead",payload),()=>{if(this.visible)wx.navigateTo({url:occurrenceUrl(item.occurrence)});});
  },
  toggleDismissed() {patchData(this, {includeDismissed:!this.data.includeDismissed});void this.refreshReminders();},
  async quickFamilyChange(e:WechatMiniprogram.PickerChange){if(this.quickDraftLocked())return;patchData(this, {quickFamilyIndex:Number(e.detail.value)});await this.loadQuickFamily(true);this.quickDirty=true;this.persistQuick();},
  async loadQuickFamily(remember=false){const identity=this.quickIdentity??captureRecoveryIdentity();if(!this.checkQuickIdentity(identity))return;if(this.quickDraftLocked())return;const epoch=++this.quickEpoch;const family=this.data.families[this.data.quickFamilyIndex-1];patchData(this, {quickLoading:true,quickRows:[],quickError:""});this.quickRoster=null;try{const roster=family?await familyApi.read("family.get",{id:family.id}):null;if(!this.checkQuickIdentity(identity)||!this.alive||epoch!==this.quickEpoch)return;this.quickRoster=roster;if(remember)rememberCreateFamily(identity,roster?.family.id??null);this.quickSubject=roster?{kind:"member",membershipId:roster.family.myMembershipId}:{kind:"self"};const options=roster?subjectOptions(roster):[{name:"自己",subject:{kind:"self" as const}}];const index=roster?options.findIndex(o=>o.subject.kind==="member"&&o.subject.membershipId===roster.family.myMembershipId):0;patchData(this, {quickSubjectOptions:options,quickSubjectNames:options.map(o=>o.name),quickSubjectIndex:index,quickRows:roster?permissionRows(roster,this.quickSubject):[],quickNotice:subjectNotice(this.quickSubject,roster),quickLoading:false});}catch(error){if(this.checkQuickIdentity(identity)&&this.alive&&epoch===this.quickEpoch){if(isAccessDenied(error))this.discardQuick();patchData(this, {quickError:errorMessage(error),quickLoading:true});}}},
  retryQuickFamily(){void this.loadQuickFamily();},
  quickSubjectChange(e:WechatMiniprogram.PickerChange){if(this.quickDraftLocked())return;const index=Number(e.detail.value);const option=this.data.quickSubjectOptions[index];if(!option)return;this.quickSubject=option.subject;patchData(this, {quickSubjectIndex:index,quickRows:this.quickRoster?permissionRows(this.quickRoster,this.quickSubject,this.data.quickRows):[],quickNotice:subjectNotice(this.quickSubject,this.quickRoster)});this.quickDirty=true;this.persistQuick();},
  quickViewersChange(e:WechatMiniprogram.CheckboxGroupChange){if(this.quickDraftLocked())return;patchData(this, {quickRows:this.data.quickRows.map(r=>({...r,canView:r.requiredViewer||e.detail.value.includes(r.membershipId)}))});this.quickDirty=true;this.persistQuick();},
  fullEditor(){if(this.quickDraftLocked()||this.data.quickLoading)return;try{if(this.quickRecovery){if(!this.persistQuick(true))return;this.quickTransferred=true;wx.navigateTo({url:"/pages/editor/index?draft=quick",fail:()=>{this.quickTransferred=false;}});return;}saveEditorSeed(this.quickDraft());wx.navigateTo({url:"/pages/editor/index?seed=1"});}catch(error){patchData(this, {quickError:errorMessage(error)});}},
  checkQuickIdentity(identity:RecoveryIdentity|null){if(!identity||isRecoveryIdentityCurrent(identity))return true;if(!this.quickIdentity||this.quickIdentity===identity){this.epoch++;this.quickEpoch++;this.batchEpoch++;this.quickRecovery=null;this.quickRoster=null;this.quickSubject={kind:"self"};this.quickDirty=false;this.pendingWrite=null;patchData(this, {status:"error",error:"账号已变更，请重新进入后编辑。",quickError:"账号已变更，请重新进入后编辑。",quickLoading:true,quickTitle:"",quickNote:"",quickTime:"",quickRows:[],quickSubjectOptions:[],quickSubjectNames:[],quickNotice:"",families:[],familyOptions:["全部家庭","仅个人"],quickFamilyOptions:["个人事项"],batchFamilyOptions:["请选择家庭"],familyIndex:0,quickFamilyIndex:0,quickSubjectIndex:0,summaryText:"—",progress:0,reminderCount:0,items:[],visibleItems:[],groups:[],backlog:[],reminders:[],selectedTasks:[],selectedIds:[],batchGroups:[],batchResults:[]});}return false;},
  quickSnapshot():DraftInput {return {title:this.data.quickTitle,note:this.data.quickNote,familyId:this.quickRoster?.family.id??null,subject:this.quickSubject,viewers:this.data.quickRows.filter(r=>r.canView).map(r=>r.membershipId),remindMe:this.data.quickReminder,repeat:this.data.quickRepeatIndex===1?"daily":"once",date:this.data.quickDate==="unscheduled"?"":this.data.quickDate==="today"?this.data.today:this.data.quickDate==="tomorrow"?this.data.tomorrow:this.data.quickDate,time:this.data.quickTime,endDate:"",times:this.data.quickTime?[this.data.quickTime]:[],weekdays:[]};},
  persistQuick(force=false){if(!force&&this.data.sheet!=="quick")return true;if(this.data.quickLoading)return false;if(!this.quickRecovery||this.quickTransferred||(!this.quickDirty&&!force))return true;if(!this.quickRecovery.current)return false;try{this.quickRecovery.save(this.quickSnapshot(),0);return true;}catch(error){patchData(this, {quickError:errorMessage(error)});return false;}},
  discardQuick(){try{if(this.quickRecovery?.current)this.quickRecovery.remove();this.quickDirty=false;patchData(this, {quickTitle:"",quickNote:"",quickTime:""});return true;}catch(error){patchData(this, {quickError:errorMessage(error)});return false;}},
  async restoreQuick(){if(this.quickIdentity&&!isRecoveryIdentityCurrent(this.quickIdentity))this.checkQuickIdentity(this.quickIdentity);let identity:RecoveryIdentity|null=null;const epoch=++this.quickEpoch;this.quickTransferred=false;this.quickDirty=false;patchData(this, {quickLoading:true});try{await readySession();identity=captureRecoveryIdentity();if(!this.checkQuickIdentity(identity)||!this.alive||epoch!==this.quickEpoch)return;this.quickIdentity=identity;if(!this.checkQuickIdentity(identity))return;const families=await listFamilies();if(!this.checkQuickIdentity(identity)||!this.alive||epoch!==this.quickEpoch)return;const preferredFamily=readCreateFamily(identity,families.items);patchData(this, {...(preferredFamily!==undefined?{quickFamilyIndex:preferredFamily?families.items.findIndex(f=>f.id===preferredFamily)+1:0}:{}),families:families.items,quickFamilyOptions:["个人事项",...families.items.map(f=>f.name)]});this.quickRecovery=personalApi.recoveryContext?new InputRecovery("quick"):null;const saved=this.quickRecovery?.load();if(this.quickRecovery&&!this.quickRecovery.record)await this.quickRecovery.start();if(!this.checkQuickIdentity(identity)||!this.alive||epoch!==this.quickEpoch)return;if(saved){const input=saved.input;const index=input.familyId?families.items.findIndex(f=>f.id===input.familyId)+1:0;if(input.familyId&&!index){this.discardQuick();throw new Error("原家庭已不可访问，输入无法恢复。");}patchData(this, {quickFamilyIndex:index});await this.loadQuickFamily();if(!this.checkQuickIdentity(identity)||!this.alive||!this.quickRecovery?.current||this.data.quickLoading)return;const modalEpoch=this.quickEpoch;const answer=await wx.showModal({title:"恢复未保存的输入？",content:"恢复后请重新核对日程和家人，不会自动提交。",confirmText:"恢复",cancelText:"放弃"});if(!this.checkQuickIdentity(identity)||!this.alive||modalEpoch!==this.quickEpoch||!this.quickRecovery.current)return;if(!answer.confirm){if(this.discardQuick())await this.quickRecovery.start();return;}if(input.repeat==="weekly"||input.endDate||input.times.length>1||input.times.some(t=>!t)||(input.date&&input.date!==this.data.today&&input.date!==this.data.tomorrow)){this.quickTransferred=true;wx.navigateTo({url:"/pages/editor/index?draft=quick"});return;}const selected=this.data.quickSubjectOptions.findIndex(o=>JSON.stringify(o.subject)===JSON.stringify(input.subject));if(selected>=0){this.quickSubject=input.subject;patchData(this, {quickSubjectIndex:selected,quickRows:this.quickRoster?permissionRows(this.quickRoster,input.subject):[]});}patchData(this, {quickTitle:input.title,quickNote:input.note,quickDate:input.date===this.data.today?"today":input.date===this.data.tomorrow?"tomorrow":input.date||"unscheduled",quickTime:input.repeat==="once"?input.time:input.times[0]??"",quickRepeatIndex:input.repeat==="daily"?1:0,quickReminder:input.remindMe,quickRows:this.data.quickRows.map(r=>({...r,canView:r.requiredViewer||input.viewers.includes(r.membershipId)})),quickError:selected>=0?"已恢复输入，请核对日程和家人；代记和家人提醒需在完整编辑中重新核对。":"原执行对象已不可用，请重新选择执行对象。"});this.quickDirty=true;}else{patchData(this, {quickTitle:"",quickNote:"",quickTime:"",quickReminder:true,quickRepeatIndex:0});await this.loadQuickFamily();}}catch(error){if(this.checkQuickIdentity(identity)&&this.alive){patchData(this, {quickError:errorMessage(error),quickLoading:true});}}},
  openRecycle() {wx.navigateTo({url:"/pages/recycle/index"});},
});
