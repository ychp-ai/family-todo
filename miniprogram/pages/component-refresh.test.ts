import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { applyNativeData } from "../../tests/helpers/native-data";
import type { OccurrenceDTO, TaskDTO } from "@family-todo/contracts";
import type { ListMetricContext, ListMetricRecord } from "../services/list-metrics";

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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const last = { items: [], nextCursor: null, complete: true, asOf: "2026-09-14T00:00:00.000Z", scopes: [], summary: null };

async function cachedHome() {
  await import("./home/index");
  const now = new Date().toISOString();
  const cache = { token: "page-token", expiresAt: new Date(Date.now()+900000).toISOString(), nextInvalidationAt: new Date(Date.now()+60000).toISOString() };
  const lists = await import("../services/personal-lists");
  const tasks = vi.spyOn(lists, "listTasks").mockResolvedValue({ items: [], last: { ...last, asOf: now, cache } });
  vi.spyOn(lists, "listReminders").mockResolvedValue({ items: [], last: { ...last, asOf: now, cache } });
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockResolvedValue({ items: [], last: { ...last, asOf: now, cache } });

  await invoke("onShow");
  return tasks;
}

it("首页切回复用缓存，下拉刷新读取最新列表并结束动画", async () => {
  const tasks = await cachedHome();
  expect(tasks).toHaveBeenCalledTimes(1);
  await invoke("onHide");
  await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(1);
  await invoke("pullRefresh");
  expect(tasks).toHaveBeenCalledTimes(2);
  expect(tasks).toHaveBeenLastCalledWith({},expect.any(Function),true);
  expect(page().data.refreshing).toBe(false);
});

it("首页缓存命中记录一个父操作和三个显式子操作", async () => {
  await cachedHome();
  const metrics = await import("../services/list-metrics");
  const records: ListMetricRecord[] = [];
  let id = 0;
  metrics.configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:async()=>`home-${++id}`});
  try {
    await invoke("onHide");
    await invoke("onShow");
    expect(records).toHaveLength(4);
    const parent = records.find(record => record.action === "home.refresh");
    const children = records.filter(record => record.parentOperationId === parent?.operationId);
    expect(parent).toMatchObject({source:"cache",result:"success",attempts:0});
    expect(parent?.childOperationIds).toHaveLength(3);
    expect(children.map(record => [record.action,record.source,record.result])).toEqual([
      ["family.list","cache","success"],
      ["task.list","cache","success"],
      ["reminder.list","cache","success"],
    ]);
  } finally { metrics.configureListMetrics(null); }
});

it("首页子列表失败记录 error 子操作和 partial 父操作", async () => {
  await import("./home/index");
  const metrics = await import("../services/list-metrics"), lists = await import("../services/personal-lists"), families = await import("../services/family-api");
  const records: ListMetricRecord[] = []; let id=0;
  metrics.configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:async()=>`partial-${++id}`});
  const finish = (metric: unknown, result: "success"|"error", error?: unknown) => (metric as ListMetricContext|undefined)?.finish(result,error);
  vi.spyOn(families,"listFamilies").mockImplementation(async (_force,metric)=>{finish(metric,"success");return {items:[],last};});
  vi.spyOn(lists,"listTasks").mockImplementation(async (_input,_active,_force,metric)=>{finish(metric,"success");return {items:[],last};});
  vi.spyOn(lists,"listReminders").mockImplementation(async (_dismissed,_active,_force,metric)=>{const error=new Error("reminder unavailable");finish(metric,"error",error);throw error;});
  page().visible=true;
  try {
    await invoke("refresh");
    expect(records.find(record=>record.action==="home.refresh")).toMatchObject({result:"partial",complete:true});
    expect(records.find(record=>record.action==="reminder.list")).toMatchObject({result:"error",error:"unknown",complete:true});
    expect(records.filter(record=>record.parentOperationId)).toHaveLength(3);
  } finally { metrics.configureListMetrics(null); }
});

it.each(["partial","failed"] as const)("首页提醒 fulfilled %s 时子操作和父操作都记 partial", async status => {
  await import("./home/index");
  const metrics=await import("../services/list-metrics"),lists=await import("../services/personal-lists"),families=await import("../services/family-api");
  const records:ListMetricRecord[]=[];let id=0;
  metrics.configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:async()=>`reminder-partial-${++id}`});
  const finish=(metric:unknown,result:"success"|"partial")=>(metric as ListMetricContext|undefined)?.finish(result);
  vi.spyOn(families,"listFamilies").mockImplementation(async(_force,metric)=>{finish(metric,"success");return {items:[],last};});
  vi.spyOn(lists,"listTasks").mockImplementation(async(_input,_active,_force,metric)=>{finish(metric,"success");return {items:[],last};});
  const reminderLast={...last,scopes:[{familyId:"family",status}]};
  vi.spyOn(lists,"listReminders").mockImplementation(async(_dismissed,_active,_force,metric)=>{finish(metric,"partial");return {items:[],last:reminderLast};});
  page().visible=true;
  try{
    await invoke("refresh");
    expect(records.find(record=>record.action==="task.list")).toMatchObject({result:"success"});
    expect(records.find(record=>record.action==="reminder.list")).toMatchObject({result:"partial"});
    expect(records.find(record=>record.action==="home.refresh")).toMatchObject({result:"partial"});
  }finally{metrics.configureListMetrics(null);}
});

it("首页采样只决定一次，排除父操作时不独立采样子列表",async()=>{
  await import("./home/index");
  const metrics=await import("../services/list-metrics"),api=(await import("../services/personal-api")).personalApi;
  const random=vi.fn().mockReturnValueOnce(.9).mockReturnValue(.1),createOperationId=vi.fn(async()=>"unexpected"),records:ListMetricRecord[]=[];
  const reads=vi.spyOn(api,"read").mockImplementation(((action:string,_payload:unknown,observer?: (event:{requestId:string;reusedInFlight:boolean})=>void)=>{
    observer?.({requestId:`${action}-request`,reusedInFlight:false});
    const base={items:[],complete:true,nextCursor:null,asOf:"2026-09-16T00:00:00.000Z"};
    return Promise.resolve(action==="family.list"?base:{...base,scopes:[],summary:null});
  }) as typeof api.read);
  metrics.configureListMetrics({sampleRate:.5,random,sink:record=>{records.push(record);},createOperationId});
  page().visible=true;
  try{
    await invoke("refresh");
    expect(random).toHaveBeenCalledTimes(1);
    expect(createOperationId).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(reads.mock.calls.map(call=>call[0]).sort()).toEqual(["family.list","reminder.list","task.list"]);
  }finally{metrics.configureListMetrics(null);}
});

it("首页采样命中后创建三个关联子操作且不重复抽样",async()=>{
  await import("./home/index");
  const metrics=await import("../services/list-metrics"),api=(await import("../services/personal-api")).personalApi;
  const random=vi.fn(()=>.1),records:ListMetricRecord[]=[];let id=0;
  vi.spyOn(api,"read").mockImplementation(((action:string,_payload:unknown,observer?: (event:{requestId:string;reusedInFlight:boolean})=>void)=>{
    observer?.({requestId:`${action}-request`,reusedInFlight:false});
    const base={items:[],complete:true,nextCursor:null,asOf:"2026-09-16T00:00:00.000Z"};
    return Promise.resolve(action==="family.list"?base:{...base,scopes:[],summary:null});
  }) as typeof api.read);
  metrics.configureListMetrics({sampleRate:.5,random,sink:record=>{records.push(record);},createOperationId:async()=>`sampled-${++id}`});
  page().visible=true;
  try{
    await invoke("refresh");
    expect(random).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(4);
    const parent=records.find(record=>record.action==="home.refresh");
    expect(records.filter(record=>record.parentOperationId===parent?.operationId)).toHaveLength(3);
  }finally{metrics.configureListMetrics(null);}
});

it("首页诊断 ID 未就绪不阻塞业务启动或隐藏取消",async()=>{
  await import("./home/index");
  const metrics=await import("../services/list-metrics"),lists=await import("../services/personal-lists"),families=await import("../services/family-api");
  const releases:((value:string)=>void)[]=[],records:ListMetricRecord[]=[];
  metrics.configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:()=>new Promise(resolve=>{releases.push(resolve);})});
  const finish=(metric:unknown)=>(metric as ListMetricContext|undefined)?.finish("success");
  const familyRead=vi.spyOn(families,"listFamilies").mockImplementation(async(_force,metric)=>{finish(metric);return {items:[],last};});
  vi.spyOn(lists,"listTasks").mockImplementation(async(_input,_active,_force,metric)=>{finish(metric);return {items:[],last};});
  vi.spyOn(lists,"listReminders").mockImplementation(async(_dismissed,_active,_force,metric)=>{finish(metric);return {items:[],last};});
  page().visible=true;
  try{
    let settled=false;const refresh=invoke("refresh").then(()=>{settled=true;});
    await Promise.resolve();
    expect(familyRead).toHaveBeenCalledTimes(1);
    await invoke("onHide");
    await vi.waitFor(()=>expect(settled).toBe(true));
    expect(records).toEqual([]);
    expect(releases).toHaveLength(4);
    releases.forEach((release,index)=>release(`delayed-${index}`));
    await refresh;
    await vi.waitFor(()=>expect(records).toHaveLength(4));
  }finally{metrics.configureListMetrics(null);}
});

it("首页家庭早失败后仍记录兄弟任务的全部分页请求",async()=>{
  await import("./home/index");
  const metrics=await import("../services/list-metrics"),api=(await import("../services/personal-api")).personalApi;
  const records:ListMetricRecord[]=[];let id=0,releaseFirst:(()=>void)|undefined,releaseSecond:(()=>void)|undefined;
  metrics.configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:async()=>`early-${++id}`});
  vi.spyOn(api,"read").mockImplementation(((action:string,payload:{cursor?:string},observer?: (event:{requestId:string;reusedInFlight:boolean})=>void)=>{
    if(action==="family.list"){observer?.({requestId:"family-request",reusedInFlight:false});return Promise.reject(new Error("family unavailable"));}
    if(action==="reminder.list"){observer?.({requestId:"reminder-request",reusedInFlight:false});return Promise.resolve({...last,items:[]});}
    if(payload.cursor){observer?.({requestId:"task-page-2",reusedInFlight:false});return new Promise<unknown>(resolve=>{releaseSecond=()=>resolve({...last,items:[],complete:true,nextCursor:null});});}
    observer?.({requestId:"task-page-1",reusedInFlight:false});return new Promise<unknown>(resolve=>{releaseFirst=()=>resolve({...last,items:[],complete:false,nextCursor:"next"});});
  }) as typeof api.read);
  page().visible=true;
  try{
    await invoke("refresh");
    expect(records.some(record=>record.action==="home.refresh")).toBe(false);
    releaseFirst?.();
    await vi.waitFor(()=>expect(releaseSecond).toBeTypeOf("function"));
    releaseSecond?.();
    await vi.waitFor(()=>expect(records.some(record=>record.action==="home.refresh")).toBe(true));
    expect(records.find(record=>record.action==="task.list")).toMatchObject({result:"success",attempts:2,pages:2,requests:[
      {requestId:"task-page-1",reusedInFlight:false},{requestId:"task-page-2",reusedInFlight:false},
    ]});
  }finally{metrics.configureListMetrics(null);}
});

it("首页取消等待 pending 请求 settle 后记录真实 requestId", async () => {
  await import("./home/index");
  const metrics = await import("../services/list-metrics"), lists = await import("../services/personal-lists"), families = await import("../services/family-api");
  const records: ListMetricRecord[] = [];let id=0,release:(()=>void)|undefined;
  metrics.configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:async()=>`cancel-${++id}`});
  vi.spyOn(families,"listFamilies").mockImplementation(async (_force,metric)=>{(metric as ListMetricContext|undefined)?.finish("success");return {items:[],last};});
  vi.spyOn(lists,"listReminders").mockImplementation(async (_dismissed,_active,_force,metric)=>{(metric as ListMetricContext|undefined)?.finish("success");return {items:[],last};});
  vi.spyOn(lists,"listTasks").mockImplementation(async (_input,active,_force,metricArgument)=>{
    const metric=metricArgument as ListMetricContext|undefined;
    await metrics.metricRequest(metric,async observer=>{await new Promise<void>(resolve=>{release=resolve;});observer?.({requestId:"late-home-request",reusedInFlight:false});});
    if (!active?.()) {const error=new metrics.ListCancelledError();metric?.finishError(error);throw error;}
    metric?.finish("success");return {items:[],last};
  });
  page().visible=true;
  try {
    const refresh=invoke("refresh");
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    await invoke("onHide");
    expect(records.some(record=>record.action==="task.list")).toBe(false);
    release?.();await refresh;
    expect(records.find(record=>record.action==="task.list")).toMatchObject({result:"cancelled",complete:false,requests:[{requestId:"late-home-request",reusedInFlight:false}]});
    expect(records.find(record=>record.action==="home.refresh")).toMatchObject({result:"cancelled",complete:false});
  } finally { metrics.configureListMetrics(null); }
});

it("首页缓存到期或账号上下文失效后重新加载", async () => {
  const tasks = await cachedHome();
  page().cacheAt = Date.now() - 30001;
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(2);
  (await import("../services/personal-api")).personalApi.unbindRecovery();
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(3);
});

it("首页跨天及切换账号不会复用旧缓存", async () => {
  const tasks = await cachedHome();
  page().setData({ today: "2000-01-01" });
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(2);
  vi.stubGlobal("getApp", () => ({ globalData: { session: { ensure: async () => ({ id: "another", displayName: "家人" }) } } }));
  await invoke("onHide");await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(3);
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
  page().visible = true;
  page().setData({ status: "ready", items: [{ id: "untouched" }], summaryText: "已完成 1 / 2 件" });
  vi.mocked(page().setData).mockClear();
  await invoke("toggleDismissed");
  await vi.waitFor(() => expect(reminders).toHaveBeenCalled());
  expect(reminders).toHaveBeenCalledWith(true, expect.any(Function));
  expect(tasks).not.toHaveBeenCalled(); expect(families).not.toHaveBeenCalled();
  expect(page().data).toMatchObject({ status: "ready", items: [{ id: "untouched" }], summaryText: "已完成 1 / 2 件" });
  expect(vi.mocked(page().setData).mock.calls).toEqual([[{ includeDismissed: true }]]);
});

it("discards a reminder response after its page context changes", async () => {
  await import("./home/index");
  let resolve: ((value: { items: []; last: typeof last }) => void) | undefined;
  vi.spyOn(await import("../services/personal-lists"), "listReminders").mockImplementation(() => new Promise(done => { resolve = done; }));
  page().visible = true;
  const reading = invoke("refreshReminders");
  page().epoch = 100;
  page().setData({ reminderCount: 7 });
  resolve?.({ items: [], last }); await reading;
  expect(page().data.reminderCount).toBe(7);
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

it("home starts only current tasks and reminders while families are still pending", async () => {
  await import("./home/index");
  const families = deferred<{ items: []; last: typeof last }>();
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockReturnValue(families.promise);
  const lists = await import("../services/personal-lists");
  const tasks = vi.spyOn(lists, "listTasks").mockResolvedValue({ items: [], last });
  const reminders = vi.spyOn(lists, "listReminders").mockResolvedValue({ items: [], last });
  page().visible = true;
  const reading = invoke("refresh");
  await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(1));
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
  vi.mocked((await import("../services/family-api")).listFamilies).mockResolvedValue({items:[{id:"family",name:"家",ownerName:"我",myMembershipId:"me",myRole:"owner",version:1}],last});
  vi.spyOn((await import("../services/family-api")).familyApi,"read").mockResolvedValue({family:{id:"family",name:"家",myMembershipId:"me",version:1,ownerMembershipId:"me",authEpoch:1},members:[],virtualMembers:[]});
  const writing = deferred<void>();
  const reading = deferred<{ items: []; last: typeof last }>();
  tasks.mockReturnValue(reading.promise);
  const item = { id: "one", group: "我来做", task: { id: "task-one" }, occurrence: { id: "one", localDate: "2000-01-01" } };
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
  await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(2));
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
  await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(3));
  expect(page().data.listRefreshing).toBe(true);
  await invoke("onHide");
  expect(page().data.listRefreshing).toBe(false);
  reading.resolve({ items: [], last });
  await action;
});

it.each(["pending", "completed"] as const)("首页切换 %s 状态后只刷新事项与提醒，复用家庭筛选", async status => {
  const tasks = await cachedHome();
  const families = vi.mocked((await import("../services/family-api")).listFamilies);
  const reminders = vi.mocked((await import("../services/personal-lists")).listReminders);
  const occurrence: OccurrenceDTO = { id: "one", taskId: "task", segmentId: "segment", localDate: String(page().data.today), slot: "day", status, version: 2, canRecord: true, subject: { kind: "user", userId: "me" }, subjectName: "我", time: null, scheduledAt: null, actualCompletedAt: null, recordedAt: null, operatorName: null };
  page().setData({ families: [{ id: "family", name: "家" }], familyIndex: 1, items: [{ task: { id: "task" }, occurrence }] });
  const api = (await import("../services/personal-api")).personalApi;
  const write = vi.spyOn(api, "write").mockResolvedValue({ occurrence, taskVersion: 3 });
  tasks.mockClear(); families.mockClear(); reminders.mockClear();
  tasks.mockResolvedValue({ items: [], last: { ...last, summary: { completed: 1, pending: 0, skipped: 0, denominator: 1 } } });
  await invoke("toggleTask", { currentTarget: { dataset: { id: "one" } } });
  expect(write).toHaveBeenCalledWith(status === "pending" ? "occurrence.record" : "occurrence.undo", expect.objectContaining({ expectedVersion: 2 }));
  expect(families).not.toHaveBeenCalled();
  expect(tasks.mock.calls.map(([input]) => input)).toEqual([{ familyId: "family" }]);
  expect(reminders).toHaveBeenCalledOnce();
  expect(page().data).toMatchObject({ familyIndex: 1, summaryText: "已完成 1 / 1 件", progress: 100, listRefreshing: false });
  await invoke("pullRefresh");
  expect(families).toHaveBeenCalledOnce();
});

it("完成写入发生版本冲突时仍刷新家庭，未知结果不发读取请求", async () => {
  const tasks = await cachedHome();
  const families = vi.mocked((await import("../services/family-api")).listFamilies);
  const { PersonalApiError } = await import("../services/personal-api");
  families.mockClear();
  await invoke("runWrite", "toggle:one", async () => { throw new PersonalApiError("VERSION_CONFLICT", "版本冲突", false); });
  expect(families).toHaveBeenCalledOnce();
  families.mockClear(); tasks.mockClear();
  await invoke("runWrite", "toggle:one", async () => { throw new PersonalApiError("INTERNAL", "结果未知", true); });
  expect(families).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled();
  expect(page().data).toMatchObject({ listRefreshing: false, writing: false, uncertain: true });
  expect(page().pendingWrite).not.toBeNull();
});


it.each([
  { name: "过期列表", inTasks: false, status: "pending" as const },
  { name: "历史日期与过期列表重叠", inTasks: true, status: "pending" as const },
  { name: "撤销历史完成重新进入过期列表", inTasks: true, status: "completed" as const },
])("按次数归属刷新：$name", async ({ inTasks, status }) => {
  const tasks = await cachedHome();
  const families = vi.mocked((await import("../services/family-api")).listFamilies);
  const reminders = vi.mocked((await import("../services/personal-lists")).listReminders);
  const occurrence: OccurrenceDTO = { id: "past", taskId: "task", segmentId: "segment", localDate: "2000-01-01", slot: "day", status, version: 2, canRecord: true, subject: { kind: "user", userId: "me" }, subjectName: "我", time: null, scheduledAt: null, actualCompletedAt: null, recordedAt: null, operatorName: null };
  const item = { id: "past", task: { id: "task" }, occurrence };
  page().setData({ items: [item], visibleItems: [item], summaryText: "原汇总", progress: 25, ...(inTasks ? { tab: "calendar", selectedDate: "2000-01-01" } : {tab:"overdue"}) });
  vi.spyOn((await import("../services/personal-api")).personalApi, "write").mockResolvedValue({ occurrence, taskVersion: 3 });
  tasks.mockClear(); families.mockClear(); reminders.mockClear();
  await invoke("toggleTask", { currentTarget: { dataset: { id: "past" } } });
  expect(tasks.mock.calls.map(([input]) => input)).toEqual(inTasks ? [{ dateFrom: "2000-01-01", dateTo: "2000-01-01" }] : [{ overdue: true }]);
  expect(families).not.toHaveBeenCalled();
  expect(reminders).toHaveBeenCalledOnce();
  expect(page().data.backlog).toEqual([]);
  expect(page().data.items).toEqual([]);
  expect(page().data.listRefreshing).toBe(false);
});

it("日期与超时 tab 按需查询，不重新读取家庭、提醒或后台积压", async () => {
  const tasks = await cachedHome();
  const families = vi.mocked((await import("../services/family-api")).listFamilies);
  const reminders = vi.mocked((await import("../services/personal-lists")).listReminders);
  tasks.mockClear(); families.mockClear(); reminders.mockClear();
  for (const tab of ["tomorrow", "unscheduled", "overdue", "today"]) {
    await invoke("changeTab", { currentTarget: { dataset: { tab } } });
    await vi.waitFor(() => expect(page().data.status).toBe("empty"));
  }
  await invoke("pickDate", { detail: { value: "2026-09-10" } });
  await vi.waitFor(() => expect(page().data.status).toBe("empty"));
  expect(tasks.mock.calls.map(([input]) => input)).toEqual([
    {dateFrom:page().data.tomorrow,dateTo:page().data.tomorrow},
    {unscheduled:true}, {overdue:true}, {}, {dateFrom:"2026-09-10",dateTo:"2026-09-10"},
  ]);
  expect(families).not.toHaveBeenCalled();
  expect(reminders).not.toHaveBeenCalled();
  await invoke("pickDate", { detail: { value: "2026-09-10" } });
  expect(tasks).toHaveBeenCalledTimes(5);
});

it("快速切换丢弃旧日期响应，日期失败保留独立提醒", async () => {
  const tasks = await cachedHome();
  const old = deferred<{items:[];last:typeof last}>();
  tasks.mockReturnValueOnce(old.promise);
  await invoke("changeTab", { currentTarget: { dataset: { tab:"overdue" } } });
  await vi.waitFor(() => expect(tasks).toHaveBeenLastCalledWith({overdue:true},expect.any(Function),false));
  await invoke("changeTab", { currentTarget: { dataset: { tab:"tomorrow" } } });
  await vi.waitFor(() => expect(page().data.status).toBe("empty"));
  old.resolve({items:[],last:{...last,asOf:"2000-01-01T00:00:00.000Z"}});
  await Promise.resolve();
  expect(page().data.tab).toBe("tomorrow");
  expect(page().data.today).not.toBe("2000-01-01");
  page().setData({reminders:[{id:"keep"}],reminderCount:1});
  tasks.mockRejectedValueOnce(new Error("offline"));
  await invoke("changeTab", { currentTarget: { dataset: { tab:"overdue" } } });
  await vi.waitFor(() => expect(page().data.status).toBe("error"));
  expect(page().data).toMatchObject({reminders:[{id:"keep"}],reminderCount:1});
});


it("recycle family picker has no personal option and keeps selected family after reordering", async () => {
  await import("./recycle/index");
  const oldFamilies = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }].map(family => ({ ...family, ownerName: "家人", myMembershipId: "me", myRole: "owner" as const, version: 1 }));
  vi.spyOn(await import("../services/family-api"), "listFamilies").mockResolvedValue({ items: [...oldFamilies].reverse(), last });
  const list = vi.spyOn(await import("../services/personal-lists"), "listRecycle").mockResolvedValue({ items: [], last });
  page().visible = true; page().setData({ families: oldFamilies, familyIndex: 1 });
  await invoke("refresh");
  expect(list).toHaveBeenCalledExactlyOnceWith("a");
  expect(page().data).toMatchObject({ familyOptions: ["全部家庭", "乙", "甲"], familyIndex: 2 });
});

it("首页切回时即使不足30秒，已过时间边界也重新读取", async () => {
  const tasks = await cachedHome();
  page().cacheBoundary = Date.now();
  await invoke("onHide"); await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(2);
});

it("首页在时间边界前隐藏再显示仍复用缓存", async () => {
  const tasks = await cachedHome();
  const start = Date.now();
  page().cacheAt = start;
  page().cacheBoundary = start + 10000;
  await invoke("onHide");
  vi.spyOn(Date, "now").mockReturnValue(start + 5000);
  await invoke("onShow");
  expect(tasks).toHaveBeenCalledTimes(1);
});

it("首页静置跨过刷新和缓存边界也不请求，手动刷新仍有效", async () => {
  vi.useFakeTimers();
  const tasks = await cachedHome();
  const lists = await import("../services/personal-lists");
  await invoke("refreshReminders");
  const reminders = vi.mocked(lists.listReminders);
  const count = reminders.mock.calls.length;
  await invoke("onHide"); await invoke("onShow");
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(tasks).toHaveBeenCalledTimes(1);
  expect(reminders).toHaveBeenCalledTimes(count);
  await invoke("pullRefresh");
  expect(tasks).toHaveBeenCalledTimes(2);
});

it("首页读取失败后静置不重试，点击重试仍读取", async () => {
  vi.useFakeTimers();
  const tasks = await cachedHome();
  tasks.mockRejectedValue(new Error("offline"));
  await invoke("pullRefresh");
  expect(page().data.status).toBe("error");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(tasks).toHaveBeenCalledTimes(2);
  await invoke("retry");
  await vi.advanceTimersByTimeAsync(0);
  expect(tasks).toHaveBeenCalledTimes(3);
});

it.each([false, true])("详情加载失败=%s 时静置不轮询，重新显示仍读取", async failed => {
  vi.useFakeTimers();
  await import("./detail/index");
  const api = (await import("../services/personal-api")).personalApi;
  const read = vi.spyOn(api, "read");
  if (failed) read.mockRejectedValue(new Error("offline"));
  else read.mockResolvedValue({ task: { schedule: { kind: "once", date: null, time: null } } as TaskDTO, occurrence: null });
  vi.spyOn(await import("../services/personal-lists"), "listHistory").mockResolvedValue({ items: [], last });
  await invoke("onShow");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(page().data.status).toBe(failed ? "error" : "ready");
  await invoke("onHide"); await invoke("onShow");
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
});
