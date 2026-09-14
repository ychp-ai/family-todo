import { isOccurrenceRef } from "../../shared/contracts";
import type { OccurrenceDTO, TaskDTO, TaskEventDTO, OccurrenceRef, Page as ContractPage } from "@family-todo/contracts";
import { personalApi, PersonalApiError, isAccessDenied } from "../../services/personal-api";
import { collect, listHistory } from "../../services/personal-lists";
import { back, dateAt, errorMessage, instantCaption, navigationMetrics, occurrenceRef, readySession } from "../../services/personal-view";
const labels: Record<string,string> = {"task.paused":"暂停周期","task.resumed":"继续周期","task.stopped":"停止后续","task.created":"创建事项","task.updated":"更新安排","task.deleted":"删除事项","task.restored":"恢复事项","task.accessChanged":"更新提醒设置","occurrence.completed":"记录完成","occurrence.skipped":"跳过本次","occurrence.undone":"撤销本次记录"};
Page({
  data:{historyDate:"",occurrences:[] as OccurrenceDTO[],occurrencesLoading:false,occurrencesError:"",seriesLabel:"",hasTimes:false,statusHeight:0,navHeight:44,capsuleWidth:100,status:"loading",error:"",id:"",task:null as TaskDTO | null,occurrence:null as OccurrenceDTO | null,events:[] as (TaskEventDTO & {label:string;recordedLabel:string;actualLabel:string})[],viewerNames:"",helperNames:"",completionLabel:"",recordedLabel:"",actualLabel:"",writing:false,sheet:"",recordDate:"",recordTime:"",recordNote:"",writeError:"",uncertain:false},
  selectedOccurrence:null as OccurrenceRef|null,occurrencesEpoch:0,visible:false,alive:true,epoch:0,pendingWrite:null as null | {key:string;run:()=>Promise<unknown>;done:()=>void},timer:undefined as ReturnType<typeof setTimeout> | undefined,lastRefresh:0,retries:0,
  onLoad(query: Record<string,string | undefined>) {this.setData({...navigationMetrics(),id:query.id ?? ""});if(query.occurrence){try{const ref:unknown=JSON.parse(decodeURIComponent(query.occurrence));if(!isOccurrenceRef(ref)||ref.taskId!==this.data.id)throw new Error("次数参数无效。");this.selectedOccurrence=ref;}catch{this.setData({status:"error",error:"次数参数无效，请返回列表重新打开。"});this.alive=false;}}},
  onShow() {if(!this.alive)return;this.visible=true;void this.refresh();},
  onHide() {this.stop();},onUnload() {this.alive=false;this.stop();},
  stop(){this.visible=false;this.epoch++;this.occurrencesEpoch++;if(this.timer)clearTimeout(this.timer);},
  schedule(delay:number){if(this.timer)clearTimeout(this.timer);if(this.visible)this.timer=setTimeout(()=>{void this.refresh();},delay);},
  back,
  async refresh(){
    if(!this.visible||this.pendingWrite||this.data.writing)return;const epoch=++this.epoch;this.occurrencesEpoch++;this.setData({occurrencesLoading:false,occurrencesError:""});this.lastRefresh=Date.now();if(this.timer)clearTimeout(this.timer);this.setData({status:"loading",task:null,occurrence:null,events:[],occurrences:[],viewerNames:"",helperNames:"",sheet:""});
    try{await readySession();const [result,history]=await Promise.all([personalApi.read("task.get",{id:this.data.id,...(this.selectedOccurrence?{occurrence:this.selectedOccurrence}:{})}),listHistory(this.data.id,()=>this.visible&&epoch===this.epoch)]);if(!this.visible||epoch!==this.epoch)return;
      const o=result.occurrence;const serverNow=history.last.asOf;const local=instantCaption(serverNow);
      this.setData({status:"ready",error:"",historyDate:this.data.historyDate||o?.localDate||dateAt(serverNow),seriesLabel:result.task.schedule.kind==="once"?"一次性事项":`${result.task.schedule.kind==="daily"?"每天":"每周"} · ${{active:"进行中",paused:"已暂停",stopped:"已停止",deleted:"已删除"}[result.task.lifecycle]}`,hasTimes:result.task.schedule.kind==="once"?!!result.task.schedule.time:result.task.schedule.times.length>0,task:result.task,occurrence:o,viewerNames:result.task.familyId?result.task.participants.filter(p=>p.canView).map(p=>p.name).join("、"):"仅自己可见",helperNames:result.task.familyId?result.task.participants.filter(p=>p.canHelp).map(p=>p.name).join("、")||"未指定":"仅自己",completionLabel:o?.status==="completed"?"已完成":o?.status==="skipped"?"已跳过":"待完成",recordedLabel:instantCaption(o?.recordedAt??null),actualLabel:instantCaption(o?.actualCompletedAt??null),events:history.items.map(e=>({...e,label:labels[e.kind]??e.kind,recordedLabel:instantCaption(e.recordedAt),actualLabel:instantCaption(e.actualCompletedAt)})),...(this.data.sheet==="record"?{}:{recordDate:local.slice(0,10),recordTime:local.slice(11,16)})});this.retries=0;this.schedule(30000);if(result.task.schedule.kind!=="once")void this.loadOccurrences();
    }catch(error){if(!this.visible||epoch!==this.epoch)return;if(isAccessDenied(error))this.clearAccess();this.setData({status:"error",error:errorMessage(error),task:null,occurrence:null,events:[],occurrences:[],sheet:"",viewerNames:"",helperNames:""});const delay=[5000,15000,30000][this.retries++];if(delay&&(!(error instanceof PersonalApiError)||error.retryable||error.code==="CURSOR_EXPIRED"))this.schedule(delay);}
  },
  retry(){this.retries=0;void this.refresh();},
  settings(){this.setData({sheet:"settings",writeError:""});},
  closeSheet(){if(this.data.writing||this.data.uncertain){wx.showToast({title:"请先重试确认操作结果",icon:"none"});return;}this.setData({sheet:""});},noop(){},
  edit(){if(this.data.uncertain||!this.data.task?.capabilities.canEdit)return;this.setData({sheet:""});wx.navigateTo({url:`/pages/editor/index?id=${encodeURIComponent(this.data.id)}`});},
  share(){if(this.data.uncertain||!this.data.task?.capabilities.canShare)return;this.setData({sheet:""});wx.navigateTo({url:`/pages/editor/index?id=${encodeURIComponent(this.data.id)}&share=1`});},
  recycle(){wx.navigateTo({url:"/pages/recycle/index"});},
  async runWrite(key:string,run:()=>Promise<unknown>,done:()=>void=()=>{}) {
    if(this.data.writing)return;
    if(this.pendingWrite&&this.pendingWrite.key!==key){wx.showToast({title:"请先重试上次操作，确认结果",icon:"none"});return;}
    this.pendingWrite??={key,run,done};this.epoch++;this.occurrencesEpoch++;this.setData({occurrencesLoading:false,occurrences:[],occurrencesError:""});if(this.timer)clearTimeout(this.timer);this.setData({writing:true,writeError:""});
    try{await this.pendingWrite.run();const finish=this.pendingWrite.done;this.pendingWrite=null;if(this.alive){this.setData({uncertain:false});finish();}}
    catch(error){const uncertain=error instanceof PersonalApiError&&error.retryable;if(!uncertain)this.pendingWrite=null;if(this.alive){const denied=isAccessDenied(error);if(denied)this.clearAccess();this.setData({writeError:errorMessage(error),uncertain,...(denied?{task:null,occurrence:null,events:[],occurrences:[],viewerNames:"",helperNames:"",sheet:"",status:"error",error:errorMessage(error)}:{})});wx.showToast({title:errorMessage(error),icon:"none"});}}
    finally{if(this.alive)this.setData({writing:false});if(!this.pendingWrite&&this.visible)void this.refresh();}
  },
  async complete(){const o=this.data.occurrence;if(!o||!o.canRecord)return;const payload={occurrence:occurrenceRef(o),expectedVersion:o.version};await this.runWrite("complete",()=>o.status==="pending"?personalApi.write("occurrence.record",{...payload,status:"completed"}):personalApi.write("occurrence.undo",payload));},
  openRecord(){if(this.data.uncertain||!this.data.occurrence?.canRecord)return;this.setData({sheet:"record",writeError:""});},
  recordDateChange(e:WechatMiniprogram.PickerChange){if(typeof e.detail.value==="string")this.setData({recordDate:e.detail.value});},
  recordTimeChange(e:WechatMiniprogram.PickerChange){if(typeof e.detail.value==="string")this.setData({recordTime:e.detail.value});},
  recordNoteInput(e:WechatMiniprogram.Input){this.setData({recordNote:e.detail.value});},
  async record(e:WechatMiniprogram.TouchEvent){
    const o=this.data.occurrence;if(!o||!o.canRecord)return;const status:"skipped"|"completed"=e.currentTarget.dataset.status==="skipped"?"skipped":"completed";
    const actual=new Date(`${this.data.recordDate}T${this.data.recordTime}:00+08:00`);if(status==="completed"&&!Number.isFinite(actual.getTime())){this.setData({writeError:"请选择实际完成时间。"});return;}
    const payload={occurrence:occurrenceRef(o),expectedVersion:o.version,status,note:this.data.recordNote,...(status==="completed"?{actualCompletedAt:actual.toISOString()}:{})};
    await this.runWrite("record",()=>personalApi.write("occurrence.record",payload),()=>this.setData({sheet:"",recordNote:""}));
  },
  clearAccess(){this.epoch++;this.occurrencesEpoch++;if(this.timer)clearTimeout(this.timer);this.setData({task:null,occurrence:null,events:[],occurrences:[],occurrencesLoading:false,occurrencesError:"",viewerNames:"",helperNames:"",sheet:"",recordNote:"",status:"error"});},
  async loadOccurrences(){if(!this.visible||!this.data.task)return;const epoch=++this.occurrencesEpoch;const mainEpoch=this.epoch;const date=this.data.historyDate;this.setData({occurrencesLoading:true,occurrences:[],occurrencesError:""});try{const result=await collect<OccurrenceDTO,ContractPage<OccurrenceDTO>>(cursor=>personalApi.read("occurrence.list",{taskId:this.data.id,dateFrom:date,dateTo:date,limit:50,...(cursor?{cursor}:{})}),()=>this.visible&&epoch===this.occurrencesEpoch&&mainEpoch===this.epoch);if(this.visible&&epoch===this.occurrencesEpoch&&mainEpoch===this.epoch)this.setData({occurrences:result.items,occurrencesLoading:false});}catch(error){if(this.visible&&epoch===this.occurrencesEpoch&&mainEpoch===this.epoch){const denied=isAccessDenied(error);if(denied)this.clearAccess();this.setData({occurrencesLoading:false,occurrences:[],occurrencesError:errorMessage(error),...(denied?{task:null,occurrence:null,events:[],occurrences:[],viewerNames:"",helperNames:"",sheet:"",status:"error",error:errorMessage(error)}:{})});}}},
  historyDateChange(e:WechatMiniprogram.PickerChange){if(typeof e.detail.value!=="string")return;this.setData({historyDate:e.detail.value});void this.loadOccurrences();},
  selectOccurrence(e:WechatMiniprogram.TouchEvent){if(this.pendingWrite||this.data.writing)return;const occurrence=this.data.occurrences.find(o=>o.id===e.currentTarget.dataset.id);if(!occurrence)return;this.selectedOccurrence=occurrenceRef(occurrence);void this.refresh();},
  async lifecycle(e:WechatMiniprogram.TouchEvent){const task=this.data.task;const action:unknown=e.currentTarget.dataset.action;if(!task||!task.capabilities.canEdit||task.schedule.kind==="once"||this.data.writing)return;if(action!=="pause"&&action!=="resume"&&action!=="stop")return;if(action==="resume"?!task.capabilities.canResume:action==="pause"?task.lifecycle!=="active":!["active","paused"].includes(task.lifecycle)||task.lifecycle==="paused"&&!task.capabilities.canResume)return;
    const epoch=this.epoch;const content=action==="pause"?"此前应做和历史继续保留；暂停期间不产生应做记录。":"历史和此前未完成保留；此系列不能直接继续，需要另建事项。";
    if(!this.pendingWrite){try{let message=content;if(action==="resume"){const preview=await personalApi.read("task.previewSchedule",{taskId:task.id,schedule:task.schedule});message=`下一次：${preview.nextOccurrences.map(o=>`${o.localDate??""} ${o.time??"不限定时刻"}`).join("、")||"当前规则下没有后续安排"}。只继续未来，不补暂停期间。`;}if(!this.visible||epoch!==this.epoch)return;const answer=await wx.showModal({title:action==="pause"?"暂停整个周期？":action==="resume"?"继续以后的安排？":"停止后续安排？",content:message,confirmText:"确认"});if(!answer.confirm||!this.visible||epoch!==this.epoch)return;}catch(error){if(this.visible&&epoch===this.epoch)this.setData({writeError:errorMessage(error)});return;}}
    const payload={id:task.id,expectedVersion:task.version};await this.runWrite(action,()=>personalApi.write(action==="pause"?"task.pause":action==="resume"?"task.resume":"task.stop",payload));
  },
  async toggleReminder(){const task=this.data.task;if(!task)return;const payload={taskId:task.id,enabled:!task.myReminder.enabled,expectedVersion:task.myReminder.version};await this.runWrite("reminder",()=>personalApi.write("reminder.setMine",payload));},
  async deleteTask(){const task=this.data.task;if(!task||!task.capabilities.canDelete||this.data.writing)return;
    if(!this.pendingWrite){const answer=await wx.showModal({title:"删除整个事项",content:"事项将放入回收站，完成记录和历史会保留，可在回收站恢复。",confirmText:"删除事项",confirmColor:"#9e4c4c"});if(!answer.confirm||!this.visible)return;}
    const payload={id:task.id,expectedVersion:task.version};await this.runWrite("delete",()=>personalApi.write("task.delete",payload),()=>{if(this.visible)wx.redirectTo({url:"/pages/recycle/index"});});
  },
});
