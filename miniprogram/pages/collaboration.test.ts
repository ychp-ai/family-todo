import { applyNativeData } from "../../tests/helpers/native-data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatePage, FamilySummary, TaskListItem } from "@family-todo/contracts";

type NativePage = Record<string, unknown> & { data: Record<string, unknown>; setData: (patch: Record<string, unknown>) => void };
let captured: NativePage | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("Page", (definition: NativePage) => {
    captured = definition;
    definition.setData = patch => applyNativeData(definition.data, patch);
  });
  vi.stubGlobal("wx", { switchTab: vi.fn(), reLaunch: vi.fn(), showToast: vi.fn(), navigateTo: vi.fn(), showModal: vi.fn().mockResolvedValue({ confirm: true }) });
});
function page(): NativePage { if (!captured) throw new Error("Page was not registered"); return captured; }
async function invoke(name: string, ...args: unknown[]): Promise<void> {
  const instance = page(); const method = instance[name];
  if (typeof method !== "function") throw new Error(`Missing page method ${name}`);
  await method.apply(instance, args);
}

describe("原生协作页面的授权边界", () => {
  it("家庭 tab 展示会话昵称，丢弃已不属于本人的目标家庭", async () => {
    await import("./families/index");
    vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ displayName: "小明" }) } } }));
    const families = await import("../services/family-api");
    vi.spyOn(families, "listFamilies").mockResolvedValue({ items: [], last: { items: [], nextCursor: null, complete: true, asOf: "2026-09-14T00:00:00.000Z" } });
    const read = vi.spyOn(families.familyApi, "read");
    const navigation = await import("../services/family-navigation");
    navigation.openFamilyTab("inaccessible-family");
    await invoke("onShow");
    await vi.waitFor(() => expect(page().data.status).toBe("empty"));
    expect(page().data).toMatchObject({ displayName: "小明", avatarInitial: "小", id: "", family: null });
    expect(read).not.toHaveBeenCalled();
    expect(navigation.consumeFamilyDestination()).toBeNull();
  });

  it("接受邀请后切换到家庭 tab 并传递已加入家庭", async () => {
    await import("./invitation/index");
    page().setData({ joinedId: "joined-family" });
    await invoke("openFamily");
    expect(wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/families/index" }));
    const navigation = await import("../services/family-navigation");
    expect(navigation.consumeFamilyDestination()).toBe("joined-family");
  });

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
    page().setData({ status: "ready", id: "task", title: "家庭安排", note: "私密备注", version: 1 });
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
    page().setData({ status: "ready", id: "task", title: "不可再读", note: "备注", version: 1 });
    await invoke("save");
    expect(page().data).toMatchObject({ status: "error", title: "", note: "", rows: [], uncertain: false });
  });
});

describe("家庭页微信资料填写", () => {
  it("头像选择返回页面保留草稿，取消不写入资料", async () => {
    await import("./families/index");
    page().profileUserId = "user-one";
    page().setData({ displayName: "小明", avatarPath: "", status: "ready" });
    const profile = await import("../services/local-profile");
    const save = vi.spyOn(profile, "saveLocalProfile");
    await invoke("openProfile");
    await invoke("onHide");
    await invoke("chooseAvatar", { detail: { avatarUrl: "wxfile://temp/avatar" } });
    await invoke("onShow");
    expect(page().data).toMatchObject({ sheet: "profile", profileAvatar: "wxfile://temp/avatar", profileName: "小明" });
    await invoke("closeSheet");
    expect(save).not.toHaveBeenCalled();
    expect(page().data.displayName).toBe("小明");
  });
  it("保存使用表单最终昵称，成功后更新展示", async () => {
    await import("./families/index");
    page().profileUserId = "user-one";
    page().setData({ sheet: "profile", profileName: "旧值", profileAvatar: "wxfile://temp/avatar" });
    vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ id: "user-one" }) } } }));
    const profile = await import("../services/local-profile");
    const save = vi.spyOn(profile, "saveLocalProfile").mockReturnValue({ displayName: "微信昵称", avatarPath: "wxfile://usr/saved" });
    await invoke("saveProfile", { detail: { value: { nickname: "微信昵称" } } });
    expect(save).toHaveBeenCalledWith("user-one", "微信昵称", "wxfile://temp/avatar");
    expect(page().data).toMatchObject({ sheet: "", displayName: "微信昵称", avatarInitial: "微", avatarPath: "wxfile://usr/saved", profileSaving: false });
  });
  it("账号切换后禁止将编辑资料写给原账号", async () => {
    await import("./families/index");
    page().profileUserId = "user-one";
    page().setData({ sheet: "profile" });
    vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ id: "user-two" }) } } }));
    const profile = await import("../services/local-profile");
    const save = vi.spyOn(profile, "saveLocalProfile");
    await invoke("saveProfile", { detail: { value: { nickname: "小明" } } });
    expect(save).not.toHaveBeenCalled();
    expect(page().data.profileError).toContain("账号已变化");
  });
});

describe("家庭成员删除", () => {
  async function setup() {
    await import("./families/index");
    page().visible = true;
    page().setData({ id: "family", owner: true, virtualMembers: [{ id: "child", name: "小宝", status: "active", version: 3 }] });
    page().load = vi.fn();
    const families = await import("../services/family-api");
    return vi.spyOn(families.familyApi, "write").mockResolvedValue({ member: { id: "child", familyId: "family", name: "小宝", status: "inactive", version: 4 } });
  }
  const event = { currentTarget: { dataset: { id: "child" } } };
  it("确认后停用无账号成员，保留版本并刷新列表", async () => {
    const write = await setup();
    await invoke("deleteVirtual", event);
    expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("历史记录保留"), confirmText: "删除成员" }));
    expect(write).toHaveBeenCalledWith("virtualMember.deactivate", { id: "child", expectedVersion: 3 });
    expect(page().load).toHaveBeenCalledOnce();
  });
  it("取消删除不写入", async () => {
    const write = await setup();
    vi.mocked(wx.showModal).mockResolvedValue({ confirm: false, cancel: true, errMsg: "" });
    await invoke("deleteVirtual", event);
    expect(write).not.toHaveBeenCalled();
  });
  it("普通成员不能删除无账号成员或其他真实成员", async () => {
    const write = await setup();
    page().setData({ owner: false, family: { id: "family", myMembershipId: "me" }, members: [{ id: "child", isMe: false, role: "member" }] });
    await invoke("deleteVirtual", event);
    await invoke("startExit", event);
    expect(wx.showModal).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(page().exitInput).toBeNull();
  });
  it("确认期间切换家庭使删除失效", async () => {
    const write = await setup();
    vi.mocked(wx.showModal).mockImplementationOnce(async () => {
      page().setData({ id: "other-family" });
      return { confirm: true, cancel: false, errMsg: "" };
    });
    await invoke("deleteVirtual", event);
    expect(write).not.toHaveBeenCalled();
  });
  it("重新读取家庭时隐藏已删除的无账号成员", async () => {
    await import("./families/index");
    page().visible = true;
    page().setData({ id: "family" });
    vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ displayName: "我" }) } } }));
    const families = await import("../services/family-api");
    const family = { id: "family", name: "家", ownerName: "我", myMembershipId: "me", ownerMembershipId: "me", authEpoch: 1, myRole: "owner" as const, version: 1 };
    vi.spyOn(families, "listFamilies").mockResolvedValue({ items: [family], last: { items: [family], nextCursor: null, complete: true, asOf: "2026-09-14T00:00:00.000Z" } });
    vi.spyOn(families.familyApi, "read").mockResolvedValue({ family, members: [], virtualMembers: [] });
    vi.spyOn(families, "listManagedVirtualMembers").mockResolvedValue([
      { id: "active", familyId: "family", name: "小宝", status: "active", version: 1 },
      { id: "deleted", familyId: "family", name: "旧成员", status: "inactive", version: 2 },
    ]);
    await invoke("load");
    expect(page().data.virtualMembers).toEqual([expect.objectContaining({ id: "active" })]);
  });
});
