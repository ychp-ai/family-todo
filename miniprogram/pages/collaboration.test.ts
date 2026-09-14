import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatePage, FamilySummary, TaskListItem } from "@family-todo/contracts";

type NativePage = Record<string, unknown> & { data: Record<string, unknown>; setData: (patch: Record<string, unknown>) => void };
let captured: NativePage | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("Page", (definition: NativePage) => {
    captured = definition;
    definition.setData = patch => Object.assign(definition.data, patch);
  });
  vi.stubGlobal("wx", { reLaunch: vi.fn(), showToast: vi.fn(), navigateTo: vi.fn(), showModal: vi.fn().mockResolvedValue({ confirm: true }) });
});
function page(): NativePage { if (!captured) throw new Error("Page was not registered"); return captured; }
async function invoke(name: string, ...args: unknown[]): Promise<void> {
  const instance = page(); const method = instance[name];
  if (typeof method !== "function") throw new Error(`Missing page method ${name}`);
  await method.apply(instance, args);
}

describe("原生协作页面的授权边界", () => {
  it.each(["FORBIDDEN", "NOT_FOUND"])("回收站恢复返回 %s 后清空私密事项", async code => {
    await import("./recycle/index");
    const module = await import("../services/personal-api");
    vi.spyOn(module.personalApi, "write").mockRejectedValue(new module.PersonalApiError(code, "不可访问", false));
    page().visible = true;
    page().setData({ status: "ready", items: [{ id: "task", version: 1, title: "私密标题", schedule: { kind: "once", date: null, time: null }, capabilities: { canRestore: true } }] });
    await invoke("restore", { currentTarget: { dataset: { id: "task" } } });
    expect(page().data).toMatchObject({ status: "error", items: [] });
    expect(page().pendingRestore).toBeNull();
  });

  it.each(["run", "loadExit", "loadTransfer"])("家庭 %s 确认失权后清空名单、预览和草稿并失效旧请求", async action => {
    await import("./families/index");
    const module = await import("../services/personal-api");
    const families = await import("../services/family-api");
    const error = new module.PersonalApiError("FORBIDDEN", "不可访问", false);
    vi.spyOn(families, "previewExit").mockRejectedValue(error);
    vi.spyOn(families, "previewTransfer").mockRejectedValue(error);
    page().visible = true;
    page().exitInput = { familyId: "family", targetMembershipId: "member", mode: "leave" };
    page().setData({ status: "ready", id: "family", family: { name: "私密家庭" }, families: [{ id: "family" }, { id: "other" }], members: [{ name: "私密称呼" }], virtualMembers: [{ name: "孩子" }], targets: [{ id: "member" }], sheet: "exit", name: "草稿", myName: "称呼", exit: { previewToken: "old" }, transfer: { previewToken: "old" } });
    if (action === "run") await invoke(action, async () => { throw error; }); else await invoke(action);
    expect(page().data).toMatchObject({ status: "error", family: null, members: [], virtualMembers: [], families: [{ id: "other" }], targets: [], sheet: "", name: "", myName: "", exit: null, transfer: null, previewLoading: false });
    expect(page().exitInput).toBeNull();
    expect(page().transferInput).toBeNull();
    expect(page().epoch).toBeGreaterThan(0);
  });

  it("首页写与邀请写确认失权后清空对应敏感数据", async () => {
    await import("./home/index");
    let module = await import("../services/personal-api");
    page().setData({ items: [{ title: "事项" }], reminders: [{ title: "提醒" }], quickRows: [{ name: "称呼" }], quickTitle: "草稿", quickNote: "备注", sheet: "quick" });
    await invoke("runWrite", "write", async () => { throw new module.PersonalApiError("NOT_FOUND", "不可访问", false); });
    expect(page().data).toMatchObject({ items: [], reminders: [], quickRows: [], quickTitle: "", quickNote: "", sheet: "" });
    await import("./invitation/index");
    module = await import("../services/personal-api");
    page().setData({ family: { name: "家庭" }, invitations: [{ id: "invite" }], token: "secret", generatedToken: "secret", myName: "草稿", preview: { familyName: "家庭" } });
    await invoke("run", async () => { throw new module.PersonalApiError("FORBIDDEN", "不可访问", false); });
    expect(page().data).toMatchObject({ status: "error", family: null, invitations: [], token: "", generatedToken: "", myName: "", preview: null });
  });

  it("虚拟改真实后旧拥有人可在编辑矩阵取消本人查看，且连同代记与提醒一起清除", async () => {
    await import("./editor/index");
    page().setData({ rows: [{ membershipId: "old-owner", name: "我", isMe: true, isCreatorManager: false, requiredViewer: false, canView: true, canHelp: true, receivesReminder: true }] });
    await invoke("permissionChange", { currentTarget: { dataset: { id: "old-owner", field: "view" } }, detail: { value: [] } });
    expect(page().data.rows).toEqual([expect.objectContaining({ membershipId: "old-owner", canView: false, canHelp: false, receivesReminder: false })]);
    expect(wx.showModal).toHaveBeenCalled();
  });

  it("旧 DTO 缺少管理身份时禁止更换执行对象并提示刷新", async () => {
    await import("./editor/index");
    page().subject = { kind: "member", membershipId: "original" };
    page().setData({ subjectMetadataMissing: true, subjectOptions: [{ name: "其他人", subject: { kind: "member", membershipId: "next" } }] });
    await invoke("subjectChange", { detail: { value: "0" } });
    expect(page().subject).toEqual({ kind: "member", membershipId: "original" });
    expect(page().data.error).toContain("重新加载");
  });

  it("切换家庭后忽略旧家庭迟到结果，提醒读取不带家庭筛选", async () => {
    await import("./home/index");
    vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({}) } } }));
    const lists = await import("../services/personal-lists");
    const families = await import("../services/family-api");
    const familyItems: FamilySummary[] = ["a", "b"].map(id => ({ id, name: id, ownerName: "自己", myMembershipId: id, myRole: "owner", version: 1 }));
    const asOf = "2026-09-12T00:00:00.000Z";
    vi.spyOn(families, "listFamilies").mockResolvedValue({ items: familyItems, last: { items: familyItems, nextCursor: null, complete: true, asOf } });
    const result = (familyId: string, completed: number) => ({ items: [] as TaskListItem[], last: { items: [], nextCursor: null, complete: true, asOf, scopes: [{ familyId, status: "ok" as const }], summary: { completed, pending: 0, skipped: 0, denominator: completed } } });
    let finishOld: ((value: {items: TaskListItem[]; last: AggregatePage<TaskListItem>}) => void) | undefined;
    const old = new Promise<{items: TaskListItem[]; last: AggregatePage<TaskListItem>}>(resolve => { finishOld = resolve; });
    const tasks = vi.spyOn(lists, "listTasks").mockImplementation(input => input.familyId === "a" ? old : Promise.resolve(result("b", 2)));
    const reminders = vi.spyOn(lists, "listReminders").mockResolvedValue({ items: [], last: { items: [], nextCursor: null, complete: true, asOf, scopes: [], summary: null } });
    page().visible = true;
    page().setData({ families: familyItems, familyIndex: 2 });
    const first = invoke("refresh");
    await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(2));
    page().setData({ familyIndex: 3 });
    await invoke("refresh");
    if (!finishOld) throw new Error("Missing deferred first page");
    finishOld(result("a", 1));
    await first;
    expect(page().data).toMatchObject({ familyIndex: 3, summaryText: "已完成 2 / 2 件" });
    expect(reminders.mock.calls.map(call=>call[0])).toEqual([false, false]);
    await invoke("stop");
  });

  it("保存得到 accessLost 确认时清空正文并回首页，不再读取已失权事项", async () => {
    await import("./editor/index");
    const api = (await import("../services/personal-api")).personalApi;
    const read = vi.spyOn(api, "read");
    vi.spyOn(api, "write").mockResolvedValue({ id: "task", version: 2, updated: true, accessLost: true });
    page().setData({ id: "task", title: "家庭安排", note: "私密备注", version: 1 });
    await invoke("save");
    expect(page().data).toMatchObject({ title: "", note: "", rows: [], uncertain: false });
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/home/index" });
    expect(read).not.toHaveBeenCalled();
  });

  it("普通查看者的编辑、共享、记录和删除入口不会发请求", async () => {
    await import("./detail/index");
    const api = (await import("../services/personal-api")).personalApi;
    const write = vi.spyOn(api, "write");
    page().setData({ task: { capabilities: { canEdit: false, canShare: false, canDelete: false } }, occurrence: { canRecord: false } });
    for (const action of ["edit", "share", "complete", "openRecord", "deleteTask"]) await invoke(action);
    expect(write).not.toHaveBeenCalled();
    expect(wx.navigateTo).not.toHaveBeenCalled();
    expect(page().data.sheet).toBe("");
  });

  it("保存确认失权后清理草稿和权限，关闭保存入口", async () => {
    await import("./editor/index");
    const module = await import("../services/personal-api");
    vi.spyOn(module.personalApi, "write").mockRejectedValue(new module.PersonalApiError("FORBIDDEN", "已无权限", false));
    page().setData({ id: "task", title: "不可再读", note: "备注", version: 1 });
    await invoke("save");
    expect(page().data).toMatchObject({ status: "error", title: "", note: "", rows: [], uncertain: false });
  });
});
