import type { OccurrenceDTO, OccurrenceRef, PersonalDraft } from "@family-todo/contracts";
import type { AppOptions } from "../types/app";

export function readySession() { return getApp<AppOptions>().globalData.session.ensure(); }
export function navigationMetrics() {
  const window = wx.getWindowInfo(); const capsule = wx.getMenuButtonBoundingClientRect();
  return {statusHeight:window.statusBarHeight,navHeight:Math.max(44,(capsule.top-window.statusBarHeight)*2+capsule.height),capsuleWidth:window.windowWidth-capsule.left+8};
}
export function dateAt(instant: string,offsetDays = 0): string { return new Date(Date.parse(instant)+8*3600000+offsetDays*86400000).toISOString().slice(0,10); }
export function dateCaption(date: string): string { const d = new Date(date+"T00:00:00Z"); return `${d.getUTCMonth()+1} 月 ${d.getUTCDate()} 日 · 星期${"日一二三四五六"[d.getUTCDay()]}`; }
export function instantCaption(value: string | null): string { return value ? new Date(Date.parse(value)+8*3600000).toISOString().slice(0,16).replace("T"," ") : ""; }
export function occurrenceRef(o: OccurrenceDTO): OccurrenceRef { return {id:o.id,taskId:o.taskId,segmentId:o.segmentId,localDate:o.localDate,slot:o.slot}; }
export function personalDraft(title: string,date: string | null,time: string | null = null,note = "",remindMe = true): PersonalDraft { return {title,note,familyId:null,subject:{kind:"self"},schedule:{kind:"once",date,time},access:{viewerMembershipIds:[],helperMembershipIds:[],reminderMembershipIds:[],remindMe}}; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "暂时未能加载，请稍后重试。"; }
export function back(): void { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({url:"/pages/home/index"}); }
