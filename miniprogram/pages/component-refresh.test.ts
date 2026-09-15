import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { applyNativeData } from "../../tests/helpers/native-data";
import type { TaskDTO } from "@family-todo/contracts";

type NativePage = Record<string, unknown> & { data: Record<string, unknown>; setData(patch: Record<string, unknown>): void };
let captured: NativePage | undefined;
function page() { if (!captured) throw new Error("Page missing"); return captured; }
async function invoke(name: string, ...args: unknown[]) {
  const p = page(), fn = p[name];
  if (typeof fn !== "function") throw new Error(name);
  await fn.apply(p, args);
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("Page", (p: NativePage) => { captured = p; p.setData = vi.fn(patch => applyNativeData(p.data, patch)); });
  vi.stubGlobal("wx", { showToast: vi.fn(), showModal: vi.fn().mockResolvedValue({ confirm: true }) });
  vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ id: "me", displayName: "我" }) } } }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const last = { items: [], nextCursor: null, complete: true, asOf: "2026-09-14T00:00:00.000Z", scopes: [], summary: null };

async function cachedHome() {
  await import("./home/index");
  const now = new Date().toISOString();
  const lists = await import("../services/personal-lists");
  const tasks = vi.spyOn(lists, "listTasks").mockResolvedValue({ items: [], last: { ...last, asOf: now } });
  vi.spyOn(lists, "listReminders").mockResolvedValue({ items: [], last: { ...last, asOf: now } });
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockResolvedValue({ items: [], last: { ...last, asOf: now } });
  page().schedule = vi.fn();
  await invoke("onShow");
  return tasks;
}

it("首页切回复用缓存，下拉刷新读取最新列表并结束动画", async () => {
  const tasks = await cachedHome();
  expect(tasks).toHaveBeenCalledTimes(2);
  await invoke("onHide");
  await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(2);
  await invoke("pullRefresh");
  expect(tasks).toHaveBeenCalledTimes(4);
  expect(page().data.refreshing).toBe(false);
});

it("首页缓存到期或账号上下文失效后重新加载", async () => {
  const tasks = await cachedHome();
  page().cacheAt = Date.now() - 30001;
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(4);
  (await import("../services/personal-api")).personalApi.unbindRecovery();
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(6);
});

it("首页跨天及切换账号不会复用旧缓存", async () => {
  const tasks = await cachedHome();
  page().setData({ today: "2000-01-01" });
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(4);
  vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ id: "another", displayName: "家人" }) } } }));
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(6);
  expect(page().cacheUserId).toBe("another");
});

it("首页隐藏保留卡片，下拉失败也结束动画", async () => {
  await cachedHome();
  const item = { id: "one", selected: true, group: "我来做" };
  page().setData({ items: [item], visibleItems: [item], backlog: [item] });
  await invoke("onHide");
  expect(page().data.items).toEqual([{ ...item, selected: false }]);
  page().visible = true;
  page().refresh = vi.fn().mockRejectedValue(new Error("offline"));
  await expect(invoke("pullRefresh")).rejects.toThrow("offline");
  expect(page().data.refreshing).toBe(false);
});

it("首页默认隐藏已完成并支持切换查看", async () => {
  await import("./home/index");
  expect(page().data.hideCompleted).toBe(true);
  const pending = { id: "pending", group: "我", occurrence: { status: "pending" } };
  const completed = { id: "completed", group: "我", occurrence: { status: "completed" } };
  page().setData({ items: [pending, completed] });
  await invoke("toggleCompleted");
  expect(page().data.visibleItems).toEqual([pending, completed]);
  await invoke("toggleCompleted");
  expect(page().data.visibleItems).toEqual([pending]);
});

it("reminder refresh leaves task cards and their loading status untouched", async () => {
  await import("./home/index");
  const lists = await import("../services/personal-lists");
  const reminders = vi.spyOn(lists, "listReminders").mockResolvedValue({ items: [], last });
  const tasks = vi.spyOn(lists, "listTasks");
  const families = vi.spyOn(await import("../services/family-api"), "listFamilies");
  page().visible = true; page().schedule = vi.fn();
  page().setData({ status: "ready", items: [{ id: "untouched" }], summaryText: "已完成 1 / 2 件" });
  vi.mocked(page().setData).mockClear();
  await invoke("toggleDismissed");
  await vi.waitFor(() => expect(page().schedule).toHaveBeenCalled());
  expect(reminders).toHaveBeenCalledWith(true, expect.any(Function));
  expect(tasks).not.toHaveBeenCalled(); expect(families).not.toHaveBeenCalled();
  expect(page().data).toMatchObject({ status: "ready", items: [{ id: "untouched" }], summaryText: "已完成 1 / 2 件" });
  expect(vi.mocked(page().setData).mock.calls).toEqual([[{ includeDismissed: true }]]);
});

it("discards a reminder response after its page context changes", async () => {
  await import("./home/index");
  let resolve: ((value: { items: []; last: typeof last }) => void) | undefined;
  vi.spyOn(await import("../services/personal-lists"), "listReminders").mockImplementation(() => new Promise(done => { resolve = done; }));
  page().visible = true; page().schedule = vi.fn();
  const reading = invoke("refreshReminders");
  page().epoch = 100;
  page().setData({ reminderCount: 7 });
  resolve?.({ items: [], last }); await reading;
  expect(page().data.reminderCount).toBe(7);
  expect(page().schedule).not.toHaveBeenCalled();
});

it("restoring one item removes only that item without reading the page again", async () => {
  await import("./recycle/index");
  const task = { id: "a", version: 1, schedule: { kind: "once", date: null, time: null }, capabilities: { canRestore: true } } as TaskDTO;
  vi.spyOn((await import("../services/personal-api")).personalApi, "write").mockResolvedValue({ task, removedParticipantCount: 0 });
  const read = vi.spyOn(await import("../services/personal-lists"), "listRecycle");
  page().visible = true; page().setData({ status: "ready", items: [task, { ...task, id: "b" }] });
  vi.mocked(page().setData).mockClear();
  await invoke("restore", { currentTarget: { dataset: { id: "a" } } });
  expect(page().data.items).toEqual([{ ...task, id: "b" }]);
  expect(read).not.toHaveBeenCalled();
  expect(vi.mocked(page().setData).mock.calls.some(([patch]) => "status" in patch)).toBe(false);
});

it("family refresh keeps mounted content while awaiting the new response", async () => {
  await import("./families/index");
  let resolve: ((value: { items: []; last: typeof last }) => void) | undefined;
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockImplementation(() => new Promise(done => { resolve = done; }));
  page().visible = true; page().setData({ status: "ready", families: [{ id: "a", name: "家" }] });
  const reading = invoke("load");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  expect(page().data).toMatchObject({ status: "ready", families: [{ id: "a", name: "家" }] });
  resolve?.({ items: [], last }); await reading;
  expect(page().data.status).toBe("empty");
});

it("switching editor family keeps form mounted and blocks save until the roster resolves", async () => {
  await import("./editor/index");
  const api = (await import("../services/personal-api")).personalApi;
  const write = vi.spyOn(api, "write");
  let reject: ((error: Error) => void) | undefined;
  vi.spyOn((await import("../services/family-api")).familyApi, "read").mockImplementation(() => new Promise((_done, fail) => { reject = fail; }));
  page().setData({ status: "ready", title: "保留标题", families: [{ id: "a", name: "家" }] });
  const loading = invoke("familyChange", { detail: { value: "1" } });
  expect(page().data).toMatchObject({ status: "ready", title: "保留标题", rosterLoading: true });
  await invoke("save"); expect(write).not.toHaveBeenCalled();
  reject?.(new Error("offline")); await loading;
  expect(page().data).toMatchObject({ status: "ready", title: "保留标题", familyIndex: 0, rosterLoading: false });
});

it("family detail shows member and virtual-member progress in their own rows", async () => {
  await import("./families/index");
  const progress = await import("../services/family-progress");
  vi.spyOn(progress, "familyProgress").mockResolvedValue([
    { subject: { kind: "member", membershipId: "m" }, name: "家人", completed: 2, pending: 1, skipped: 1, denominator: 3 },
    { subject: { kind: "virtual", virtualMemberId: "v" }, name: "孩子", completed: 1, pending: 0, skipped: 0, denominator: 1 },
  ]);
  page().visible = true;
  page().setData({ id: "f", family: { id: "f" }, progressDate: "2026-09-14", members: [{ id: "m" }, { id: "empty" }], virtualMembers: [{ id: "v" }] });
  await invoke("loadProgress");
  expect(page().data.members).toEqual([expect.objectContaining({ id: "m", progress: expect.objectContaining({ completed: 2 }) }), { id: "empty", progress: null }]);
  expect(page().data.virtualMembers).toEqual([expect.objectContaining({ id: "v", progress: expect.objectContaining({ completed: 1 }) })]);
  expect(progress.familyProgress).toHaveBeenCalledWith("f", "2026-09-14", expect.any(Function));
});

it("old family progress cannot fill a newly selected family's rows", async () => {
  await import("./families/index");
  let resolve: ((value: []) => void) | undefined;
  vi.spyOn(await import("../services/family-progress"), "familyProgress").mockImplementation(() => new Promise(done => { resolve = done; }));
  page().visible = true;
  page().setData({ family: { id: "old" }, progressDate: "2026-09-14", members: [{ id: "old-member" }] });
  const reading = invoke("loadProgress");
  page().setData({ family: { id: "new" }, members: [{ id: "new-member" }] });
  resolve?.([]); await reading;
  expect(page().data.members).toEqual([{ id: "new-member" }]);
});

it("family recycle requests only its fixed scope and cannot change to all families", async () => {
  await import("./recycle/index");
  const list = vi.spyOn(await import("../services/personal-lists"), "listRecycle").mockResolvedValue({ items: [], last });
  const families = vi.spyOn(await import("../services/family-api"), "listFamilies");
  page().visible = true; page().setData({ scopedFamilyId: "only-family" });
  await invoke("refresh");
  await invoke("familyChange", { detail: { value: "0" } });
  expect(list).toHaveBeenCalledExactlyOnceWith("only-family");
  expect(families).not.toHaveBeenCalled();
});

it("an inaccessible family recycle never falls back to another family's items", async () => {
  await import("./recycle/index");
  const { PersonalApiError } = await import("../services/personal-api");
  const list = vi.spyOn(await import("../services/personal-lists"), "listRecycle").mockRejectedValue(new PersonalApiError("FORBIDDEN", "无权限", false));
  page().visible = true; page().setData({ scopedFamilyId: "only-family", items: [{ id: "stale" }] });
  await invoke("refresh");
  expect(list).toHaveBeenCalledExactlyOnceWith("only-family");
  expect(page().data).toMatchObject({ status: "error", items: [], scopedFamilyId: "only-family" });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("not initialized"); };
  let reject: (reason: Error) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it("home starts tasks, backlog and reminders while families are still pending", async () => {
  await import("./home/index");
  const families = deferred<{ items: []; last: typeof last }>();
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockReturnValue(families.promise);
  const lists = await import("../services/personal-lists");
  const tasks = vi.spyOn(lists, "listTasks").mockResolvedValue({ items: [], last });
  const reminders = vi.spyOn(lists, "listReminders").mockResolvedValue({ items: [], last });
  page().visible = true; page().schedule = vi.fn();
  const reading = invoke("refresh");
  await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(2));
  expect(reminders).toHaveBeenCalledOnce();
  families.resolve({ items: [], last }); await reading;
  expect(page().data.status).toBe("empty");
});

it("editor starts the task read before the family list resolves and ignores both after unload", async () => {
  await import("./editor/index");
  const families = deferred<{ items: []; last: typeof last }>();
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockReturnValue(families.promise);
  const read = vi.spyOn((await import("../services/personal-api")).personalApi, "read").mockResolvedValue(last);
  const reading = invoke("load");
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith("task.list", { limit: 1 }));
  page().alive = false;
  families.resolve({ items: [], last }); await reading;
  expect(page().data.status).toBe("loading");
  expect(read).toHaveBeenCalledOnce();
});

it("recycle starts the global list while family options are pending", async () => {
  await import("./recycle/index");
  const families = deferred<{ items: []; last: typeof last }>();
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockReturnValue(families.promise);
  const read = vi.spyOn(await import("../services/personal-lists"), "listRecycle").mockResolvedValue({ items: [], last });
  page().visible = true;
  const reading = invoke("refresh");
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith(undefined));
  families.resolve({ items: [], last }); await reading;
  expect(page().data.status).toBe("empty");
});

it("progress starts statistics beside the roster and cannot publish after roster failure", async () => {
  await import("./progress/index");
  const roster = deferred<never>(), progress = deferred<[]>();
  vi.spyOn((await import("../services/family-api")).familyApi, "read").mockReturnValue(roster.promise);
  const read = vi.spyOn(await import("../services/family-progress"), "familyProgress").mockReturnValue(progress.promise);
  page().visible = true; page().setData({ familyId: "f", date: "2026-09-14" });
  const reading = invoke("loadScope", 0);
  expect(read).toHaveBeenCalledWith("f", "2026-09-14", expect.any(Function));
  roster.reject(new Error("roster unavailable")); await reading;
  expect(page().data.status).toBe("error");
  progress.resolve([]); await Promise.resolve();
  expect(page().data.status).toBe("error");
  expect(page().data.members).toBeNull();
});

it("batch viewer groups request all family rosters concurrently", async () => {
  await import("./home/index");
  const first = deferred<void>(), second = deferred<void>();
  page().loadBatchGroup = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  page().visible = true;
  page().setData({ selectedTasks: [{ id: "a", familyId: "one" }, { id: "b", familyId: "two" }] });
  const reading = invoke("openBatch");
  expect(page().loadBatchGroup).toHaveBeenCalledTimes(2);
  first.resolve(); second.resolve(); await reading;
});

it("family detail starts today's progress before the roster resolves", async () => {
  vi.spyOn(await import("../services/personal-view"), "dateAt").mockReturnValue("2026-09-14");
  await import("./families/index");
  const api = await import("../services/family-api");
  vi.spyOn(api, "listFamilies").mockResolvedValue({ items: [{ id: "f", name: "家", ownerName: "我", myMembershipId: "m", myRole: "owner", version: 1 }], last });
  const roster = deferred<never>();
  vi.spyOn(api.familyApi, "read").mockReturnValue(roster.promise);
  const progress = vi.spyOn(await import("../services/family-progress"), "familyProgress").mockResolvedValue([]);
  page().visible = true; page().setData({ id: "f" });
  const reading = invoke("load");
  await vi.waitFor(() => expect(progress).toHaveBeenCalledWith("f", "2026-09-14", expect.any(Function)));
  roster.reject(new Error("offline")); await reading;
  expect(page().data.status).toBe("error");
  expect(page().data.members).toEqual([]);
});

it("parallel progress merges roster and historical subjects after both resolve", async () => {
  await import("./progress/index");
  const api = await import("../services/family-api");
  vi.spyOn(api.familyApi, "read").mockResolvedValue({ family: { id: "f", name: "家", myMembershipId: "m", ownerMembershipId: "m", version: 1, authEpoch: 1 }, members: [], virtualMembers: [] });
  const progress = deferred<import("@family-todo/contracts").MemberProgress[]>();
  vi.spyOn(await import("../services/family-progress"), "familyProgress").mockReturnValue(progress.promise);
  page().visible = true; page().setData({ familyId: "f", date: "2026-09-14" });
  const reading = invoke("loadScope", 0);
  progress.resolve([{ subject: { kind: "member", membershipId: "former" }, name: "原成员", completed: 1, pending: 0, skipped: 0, denominator: 1 }]);
  await reading;
  expect(page().data.status).toBe("ready");
  expect(page().data.filterNames).toEqual(["全部执行对象", "原成员"]);
  expect(page().data.members).toEqual([expect.objectContaining({ percent: 100 })]);
});

it("完成事项的蒙层持续到列表刷新结束，并阻止重复操作", async () => {
  const tasks = await cachedHome();
  const writing = deferred<void>();
  const reading = deferred<{ items: []; last: typeof last }>();
  tasks.mockReturnValue(reading.promise);
  const item = { id: "one", group: "我来做", task: { id: "task-one" } };
  page().setData({ status: "ready", items: [item], visibleItems: [item] });
  const action = invoke("runWrite", "toggle:one", () => writing.promise);
  expect(page().data.listRefreshing).toBe(true);
  await invoke("openQuick");
  expect(page().data).toMatchObject({ sheet: "quick", quickLoading: false });
  await invoke("quickTitleInput", { detail: { value: "新的事项" } });
  expect(page().data.quickTitle).toBe("新的事项");
  const create = vi.spyOn((await import("../services/personal-api")).personalApi, "write");
  await invoke("saveQuick", { currentTarget: { dataset: {} } });
  expect(create).not.toHaveBeenCalled();
  writing.resolve();
  await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(4));
  expect(page().data).toMatchObject({ writing: false, listRefreshing: true, items: [item] });
  await invoke("saveQuick", { currentTarget: { dataset: {} } });
  expect(create).not.toHaveBeenCalled();
  const duplicate = vi.fn();
  await invoke("runWrite", "toggle:one", duplicate);
  expect(duplicate).not.toHaveBeenCalled();
  reading.resolve({ items: [], last });
  await action;
  expect(page().data).toMatchObject({ listRefreshing: false, status: "empty" });
});

it("完成后的刷新失败或页面隐藏会撤下蒙层", async () => {
  const tasks = await cachedHome();
  tasks.mockRejectedValue(new Error("offline"));
  await invoke("runWrite", "toggle:one", async () => {});
  expect(page().data).toMatchObject({ listRefreshing: false, status: "error" });
  const reading = deferred<{ items: []; last: typeof last }>();
  tasks.mockReturnValue(reading.promise);
  const action = invoke("runWrite", "toggle:one", async () => {});
  await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(6));
  expect(page().data.listRefreshing).toBe(true);
  await invoke("onHide");
  expect(page().data.listRefreshing).toBe(false);
  reading.resolve({ items: [], last });
  await action;
});

it("结果待确认时撤下蒙层并保留重试入口", async () => {
  await cachedHome();
  const { PersonalApiError } = await import("../services/personal-api");
  await invoke("runWrite", "toggle:one", async () => { throw new PersonalApiError("INTERNAL", "稍后重试", true); });
  expect(page().data).toMatchObject({ listRefreshing: false, writing: false, uncertain: true });
  expect(page().pendingWrite).not.toBeNull();
});
