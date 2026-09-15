import { patchData } from "../../services/patch-data";
import { componentActions } from "../../services/component-events";
import type { TaskSummaryDTO, FamilySummary } from "@family-todo/contracts";
import { PersonalApiError, personalApi, isAccessDenied } from "../../services/personal-api";
import { listFamilies } from "../../services/family-api";
import { listRecycle } from "../../services/personal-lists";
import { back, errorMessage, navigationMetrics, readySession } from "../../services/personal-view";

Page({
  onComponentAction: componentActions(["familyChange", "restore"]),
  data: { statusHeight: 0, navHeight: 44, capsuleWidth: 100, status: "loading", error: "", scopedFamilyId: "", families:[] as FamilySummary[],familyOptions:["全部家庭","仅个人"],familyIndex:0,items: [] as TaskSummaryDTO[], writing: false, restoringId: "" },
  visible: false, alive: true, epoch: 0,
  pendingRestore: null as { id: string; expectedVersion: number } | null,
  onLoad(query:Record<string,string|undefined> = {}) { patchData(this, {...navigationMetrics(),scopedFamilyId:query.familyId??""}); },
  onShow() { this.visible = true; if (!this.pendingRestore) void this.refresh(); },
  onHide() { this.visible = false; this.epoch++; },
  onUnload() { this.alive = false; this.visible = false; this.epoch++; },
  back,
  async refresh() {
    if (this.pendingRestore) return;
    const epoch = ++this.epoch;
    patchData(this, { error: "",...(!["ready","empty"].includes(this.data.status)?{status:"loading"}:{}) });
    try {
      await readySession();
      if(this.data.scopedFamilyId){
        const result=await listRecycle(this.data.scopedFamilyId);
        if(this.visible&&epoch===this.epoch)patchData(this, {status:result.items.length?"ready":"empty",items:result.items});
        return;
      }
      const selected=this.data.familyIndex>1?this.data.families[this.data.familyIndex-2]?.id:undefined;const personalOnly=this.data.familyIndex===1;const familiesPromise=listFamilies();const recyclePromise=selected?familiesPromise.then(families=>listRecycle(families.items.some(f=>f.id===selected)?selected:undefined)):listRecycle(personalOnly?null:undefined);const [families,result]=await Promise.all([familiesPromise,recyclePromise]);const index=personalOnly?1:selected&&families.items.some(f=>f.id===selected)?families.items.findIndex(f=>f.id===selected)+2:0;
      if (this.visible && epoch === this.epoch) patchData(this, { status: result.items.length ? "ready" : "empty", items: result.items,families:families.items,familyOptions:["全部家庭","仅个人",...families.items.map(f=>f.name)],familyIndex:index });
    } catch (error) {
      if (this.visible && epoch === this.epoch) patchData(this, { status: "error", error: errorMessage(error),items:[] });
    }
  },
  familyChange(e:WechatMiniprogram.PickerChange){if(this.data.scopedFamilyId||this.pendingRestore||this.data.writing)return;this.epoch++;patchData(this, {familyIndex:Number(e.detail.value),items:[]});void this.refresh();},
  async restore(e: WechatMiniprogram.TouchEvent) {
    const id: unknown = e.currentTarget.dataset.id;
    const task = this.data.items.find(item => item.id === id);
    if (!task || !task.capabilities.canRestore || this.data.writing) return;
    if (this.pendingRestore && this.pendingRestore.id !== id) {
      patchData(this, { error: "请先重试确认上一次恢复操作。" });
      return;
    }
    if(!this.pendingRestore){const answer=await wx.showModal({title:"恢复这件事？",content:task.schedule.kind==="once"?"历史记录保留，恢复时重新校验成员权限，不恢复已退出成员的访问权。":"历史及有效权限保留，周期恢复为暂停。曾停止的系列仅恢复历史，不能继续；已退出成员不会恢复访问权。",confirmText:"恢复事项"});if(!answer.confirm||!this.visible)return;}
    const intent = this.pendingRestore ?? { id: task.id, expectedVersion: task.version };
    this.pendingRestore = intent;
    this.epoch++;
    patchData(this, { writing: true, restoringId: intent.id, error: "" });
    try {
      const result=await personalApi.write("task.restore", intent);
      this.pendingRestore = null;
      if (this.visible) {
        if(result.removedParticipantCount)await wx.showModal({title:"事项已恢复",content:`已移除 ${result.removedParticipantCount} 位失效参与人，其他有效权限与历史记录保留。`,showCancel:false});else if(result.task.schedule.kind!=="once")await wx.showModal({title:"事项已恢复",content:result.task.capabilities.canResume?"周期已恢复为暂停，可在详情继续以后的安排。":"本系列曾停止，仅恢复历史，不能继续。",showCancel:false});else wx.showToast({ title: "事项已恢复", icon: "success" });
        const items=this.data.items.filter(item=>item.id!==intent.id);
        patchData(this, {items,status:items.length?"ready":"empty"});
      }
    } catch (error) {
      if (error instanceof PersonalApiError && !error.retryable) this.pendingRestore = null;
      if (this.alive && isAccessDenied(error)) { this.epoch++; patchData(this, { status: "error", error: errorMessage(error), items: [] }); }
      else if (this.visible) patchData(this, { error: errorMessage(error) });
    } finally {
      if (this.alive) patchData(this, { writing: false, restoringId: "" });
    }
  },
});
