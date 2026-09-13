import type { TaskDTO, FamilySummary } from "@family-todo/contracts";
import { PersonalApiError, personalApi, isAccessDenied } from "../../services/personal-api";
import { listFamilies } from "../../services/family-api";
import { listRecycle } from "../../services/personal-lists";
import { back, errorMessage, navigationMetrics, readySession } from "../../services/personal-view";

Page({
  data: { statusHeight: 0, navHeight: 44, capsuleWidth: 100, status: "loading", error: "", families:[] as FamilySummary[],familyOptions:["全部家庭","仅个人"],familyIndex:0,items: [] as TaskDTO[], writing: false },
  visible: false, alive: true, epoch: 0,
  pendingRestore: null as { id: string; expectedVersion: number } | null,
  onLoad() { this.setData(navigationMetrics()); },
  onShow() { this.visible = true; if (!this.pendingRestore) void this.refresh(); },
  onHide() { this.visible = false; this.epoch++; },
  onUnload() { this.alive = false; this.visible = false; this.epoch++; },
  back,
  async refresh() {
    if (this.pendingRestore) return;
    const epoch = ++this.epoch;
    this.setData({ status: "loading", error: "",items:[] });
    try {
      await readySession();
      const families=await listFamilies();const selected=this.data.familyIndex>1?this.data.families[this.data.familyIndex-2]?.id:undefined;const index=this.data.familyIndex===1?1:selected&&families.items.some(f=>f.id===selected)?families.items.findIndex(f=>f.id===selected)+2:0;const result = await listRecycle(index===1?null:index>1?families.items[index-2]?.id:undefined);
      if (this.visible && epoch === this.epoch) this.setData({ status: result.items.length ? "ready" : "empty", items: result.items,families:families.items,familyOptions:["全部家庭","仅个人",...families.items.map(f=>f.name)],familyIndex:index });
    } catch (error) {
      if (this.visible && epoch === this.epoch) this.setData({ status: "error", error: errorMessage(error),items:[] });
    }
  },
  familyChange(e:WechatMiniprogram.PickerChange){if(this.pendingRestore||this.data.writing)return;this.epoch++;this.setData({familyIndex:Number(e.detail.value),items:[]});void this.refresh();},
  async restore(e: WechatMiniprogram.TouchEvent) {
    const id: unknown = e.currentTarget.dataset.id;
    const task = this.data.items.find(item => item.id === id);
    if (!task || !task.capabilities.canRestore || this.data.writing) return;
    if (this.pendingRestore && this.pendingRestore.id !== id) {
      this.setData({ error: "请先重试确认上一次恢复操作。" });
      return;
    }
    if(!this.pendingRestore){const answer=await wx.showModal({title:"恢复这件事？",content:"历史记录保留，恢复时重新校验成员权限，不恢复已退出成员的访问权。",confirmText:"恢复事项"});if(!answer.confirm||!this.visible)return;}
    const intent = this.pendingRestore ?? { id: task.id, expectedVersion: task.version };
    this.pendingRestore = intent;
    this.epoch++;
    this.setData({ writing: true, error: "" });
    try {
      const result=await personalApi.write("task.restore", intent);
      this.pendingRestore = null;
      if (this.visible) {
        if(result.removedParticipantCount)await wx.showModal({title:"事项已恢复",content:`已移除 ${result.removedParticipantCount} 位失效参与人，其他有效权限与历史记录保留。`,showCancel:false});else wx.showToast({ title: "事项已恢复", icon: "success" });
        await this.refresh();
      }
    } catch (error) {
      if (error instanceof PersonalApiError && !error.retryable) this.pendingRestore = null;
      if (this.alive && isAccessDenied(error)) { this.epoch++; this.setData({ status: "error", error: errorMessage(error), items: [] }); }
      else if (this.visible) this.setData({ error: errorMessage(error) });
    } finally {
      if (this.alive) this.setData({ writing: false });
    }
  },
});
