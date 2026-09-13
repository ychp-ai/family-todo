import type { OccurrenceDTO, TaskDTO, TaskEventDTO } from "@family-todo/contracts";
import { personalApi, PersonalApiError } from "../../services/personal-api";
import { listHistory } from "../../services/personal-lists";
import { back, errorMessage, instantCaption, navigationMetrics, occurrenceRef, readySession } from "../../services/personal-view";
const labels: Record<string,string> = {"task.created":"创建事项","task.updated":"更新安排","task.deleted":"删除事项","task.restored":"恢复事项","task.accessChanged":"更新提醒设置","occurrence.completed":"记录完成","occurrence.skipped":"跳过本次","occurrence.undone":"撤销本次记录"};
Page({
  data:{statusHeight:0,navHeight:44,capsuleWidth:100,status:"loading",error:"",id:"",task:null as TaskDTO | null,occurrence:null as OccurrenceDTO | null,events:[] as (TaskEventDTO & {label:string;recordedLabel:string;actualLabel:string})[],viewerNames:"",helperNames:"",completionLabel:"",recordedLabel:"",actualLabel:"",writing:false,sheet:"",recordDate:"",recordTime:"",recordNote:"",writeError:"",uncertain:false},
  visible:false,alive:true,epoch:0,pendingWrite:null as null | {key:string;run:()=>Promise<unknown>;done:()=>void},timer:undefined as ReturnType<typeof setTimeout> | undefined,lastRefresh:0,retries:0,
  onLoad(query: Record<string,string | undefined>) {this.setData({...navigationMetrics(),id:query.id ?? ""});},
  onShow() {this.visible=true;void this.refresh();},
  onHide() {this.stop();},onUnload() {this.alive=false;this.stop();},
  stop(){this.visible=false;this.epoch++;if(this.timer)clearTimeout(this.timer);},
  schedule(delay:number){if(this.timer)clearTimeout(this.timer);if(this.visible)this.timer=setTimeout(()=>{void this.refresh();},delay);},
  back,
  async refresh(){
    if(!this.visible||this.pendingWrite||this.data.writing)return;const epoch=++this.epoch;this.lastRefresh=Date.now();if(this.timer)clearTimeout(this.timer);this.setData({status:"loading",task:null,occurrence:null,events:[],sheet:""});
    try{await readySession();const [result,history]=await Promise.all([personalApi.read("task.get",{id:this.data.id}),listHistory(this.data.id)]);if(!this.visible||epoch!==this.epoch)return;
      const o=result.occurrence;const serverNow=history.last.asOf;const local=instantCaption(serverNow);
      this.setData({status:"ready",error:"",task:result.task,occurrence:o,viewerNames:result.task.familyId?result.task.participants.filter(p=>p.canView).map(p=>p.name).join("、"):"仅自己可见",helperNames:result.task.familyId?result.task.participants.filter(p=>p.canHelp).map(p=>p.name).join("、")||"未指定":"仅自己",completionLabel:o?.status==="completed"?"已完成":o?.status==="skipped"?"已跳过":"待完成",recordedLabel:instantCaption(o?.recordedAt??null),actualLabel:instantCaption(o?.actualCompletedAt??null),events:history.items.map(e=>({...e,label:labels[e.kind]??e.kind,recordedLabel:instantCaption(e.recordedAt),actualLabel:instantCaption(e.actualCompletedAt)})),...(this.data.sheet==="record"?{}:{recordDate:local.slice(0,10),recordTime:local.slice(11,16)})});this.retries=0;this.schedule(30000);
    }catch(error){if(!this.visible||epoch!==this.epoch)return;this.setData({status:"error",error:errorMessage(error),task:null,occurrence:null,events:[],sheet:"",viewerNames:"",helperNames:""});const delay=[5000,15000,30000][this.retries++];if(delay&&(!(error instanceof PersonalApiError)||error.retryable||error.code==="CURSOR_EXPIRED"))this.schedule(delay);}
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
    this.pendingWrite??={key,run,done};this.epoch++;if(this.timer)clearTimeout(this.timer);this.setData({writing:true,writeError:""});
    try{await this.pendingWrite.run();const finish=this.pendingWrite.done;this.pendingWrite=null;if(this.alive){this.setData({uncertain:false});finish();}}
    catch(error){const uncertain=error instanceof PersonalApiError&&error.retryable;if(!uncertain)this.pendingWrite=null;if(this.alive){const denied=error instanceof PersonalApiError&&["NOT_FOUND","FORBIDDEN","FAMILY_NOT_FOUND"].includes(error.code);this.setData({writeError:errorMessage(error),uncertain,...(denied?{task:null,occurrence:null,events:[],sheet:"",status:"error",error:errorMessage(error)}:{})});wx.showToast({title:errorMessage(error),icon:"none"});}}
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
  async toggleReminder(){const task=this.data.task;if(!task)return;const payload={taskId:task.id,enabled:!task.myReminder.enabled,expectedVersion:task.myReminder.version};await this.runWrite("reminder",()=>personalApi.write("reminder.setMine",payload));},
  async deleteTask(){const task=this.data.task;if(!task||!task.capabilities.canDelete||this.data.writing)return;
    if(!this.pendingWrite){const answer=await wx.showModal({title:"删除整个事项",content:"事项将放入回收站，完成记录和历史会保留，可在回收站恢复。",confirmText:"删除事项",confirmColor:"#9e4c4c"});if(!answer.confirm||!this.visible)return;}
    const payload={id:task.id,expectedVersion:task.version};await this.runWrite("delete",()=>personalApi.write("task.delete",payload),()=>{if(this.visible)wx.redirectTo({url:"/pages/recycle/index"});});
  },
});
