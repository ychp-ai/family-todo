import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { isPersonalData, isPersonalPayload } from "@family-todo/contracts";
import type { PersonalAction, PersonalActionMap, PersonalDraft, OccurrenceDTO } from "@family-todo/contracts";
import { PersonalService } from "@family-todo/application";
import { createUser } from "@family-todo/domain";
import { CloudBaseIdentityStore } from "../packages/infra-cloudbase/src/identity-store";
import { CloudBasePersonalStore } from "../packages/infra-cloudbase/src/personal-store";
import { MemoryPersonalDatabase } from "./support/personal-database";

const now = new Date("2026-09-11T10:30:00.000Z");
const identity = {provider:"wechat" as const,appId:"wxee0f068c2e7cc49c",subject:"personal-test-user"};
const draft: PersonalDraft = {title:"买牛奶",note:"",familyId:null,subject:{kind:"self"},schedule:{kind:"once",date:"2026-09-11",time:"18:00"},access:{viewerMembershipIds:[],helperMembershipIds:[],reminderMembershipIds:[],remindMe:true}};
let database: MemoryPersonalDatabase; let service: PersonalService; let store: CloudBasePersonalStore;
async function call<A extends PersonalAction>(action: A,payload: PersonalActionMap[A]["payload"],requestId = randomUUID()): Promise<PersonalActionMap[A]["data"]> {
  const result = await service.execute(action,payload,requestId); if (!isPersonalData(action,result)) throw new Error("Bad result"); return result;
}
function ref(o: OccurrenceDTO) { return {id:o.id,taskId:o.taskId,segmentId:o.segmentId,localDate:o.localDate,slot:o.slot}; }
beforeEach(async () => {
  database = new MemoryPersonalDatabase();
  await new CloudBaseIdentityStore(database,identity).ensureUser(createUser(randomUUID(),now));
  store = new CloudBasePersonalStore(database,identity,"test-cursor-secret-32-characters-long");
  service = new PersonalService(store,{now:() => now},{generate:randomUUID});
});
describe("个人事项真实适配器 + 本地事务模拟", () => {
  it("重复创建只产生一件事项；改变操作或内容冲突",async () => {
    const id = randomUUID(); const first = await call("task.create",{draft},id);
    expect(await call("task.create",{draft},id)).toEqual(first);
    await expect(call("task.create",{draft:{...draft,title:"另一件"}},id)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    expect((await call("task.list",{})).items).toHaveLength(1);
    const scope = [...database.documents.entries()].find(([key]) => key.startsWith("user_scopes/"))?.[1]; expect(scope?.personalTaskCount).toBe(1);
  });
  it.each(["tasks","user_scopes","task_events","idempotency_receipts"])("%s 写失败时全事务回滚",async collection => {
    const before = structuredClone(database.documents); database.failCollection = collection;
    await expect(call("task.create",{draft})).rejects.toThrow(); expect(database.documents).toEqual(before);
  });
  it("并发相同请求重跑返回同一 ID",async () => {
    const id = randomUUID(); const [a,b] = await Promise.all([call("task.create",{draft},id),call("task.create",{draft},id)]);
    expect(a.task.id).toBe(b.task.id); expect(database.conflicts).toBeGreaterThan(0);
  });
  it("不同用户不能读、写或重放别人的事项",async () => {
    const item = await call("task.create",{draft});
    const other = {...identity,subject:"another-user"}; await new CloudBaseIdentityStore(database,other).ensureUser(createUser(randomUUID(),now));
    const otherService = new PersonalService(new CloudBasePersonalStore(database,other,"test-cursor-secret-32-characters-long"),{now:() => now},{generate:randomUUID});
    await expect(otherService.execute("task.get",{id:item.task.id},randomUUID())).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(otherService.execute("task.delete",{id:item.task.id,expectedVersion:1},randomUUID())).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it("完成阻止修改日程，撤销递增版本并保留真实事件",async () => {
    const item = await call("task.create",{draft}); const o = item.nextOccurrences[0]; if (!o) throw new Error("Missing occurrence");
    const done = await call("occurrence.record",{occurrence:ref(o),expectedVersion:0,status:"completed"});
    await expect(call("task.update",{id:item.task.id,expectedVersion:done.taskVersion,draft:{...draft,schedule:{kind:"once",date:null,time:null}}})).rejects.toMatchObject({code:"INVALID_STATE"});
    await expect(call("occurrence.undo",{occurrence:ref(o),expectedVersion:0})).rejects.toMatchObject({code:"VERSION_CONFLICT"});
    const undone = await call("occurrence.undo",{occurrence:ref(o),expectedVersion:done.occurrence.version}); expect(undone.occurrence.status).toBe("pending"); expect(undone.taskVersion).toBe(3);
    const history = await call("task.history",{taskId:item.task.id}); expect(history.items.map(e => e.kind)).toEqual(expect.arrayContaining(["task.created","occurrence.completed","occurrence.undone"]));
    expect(history.items.every(e => e.actorName === item.task.ownerName)).toBe(true);
  });
  it("旧日程的单次引用不可伪造或继续操作",async () => {
    const item = await call("task.create",{draft}); const o = item.nextOccurrences[0]; if (!o) throw new Error("Missing occurrence");
    const updated = await call("task.update",{id:item.task.id,expectedVersion:1,draft:{...draft,schedule:{kind:"once",date:null,time:null}}});
    if (!("nextOccurrences" in updated)) throw new Error("Unexpected access loss");
    expect(updated.nextOccurrences[0]?.id).not.toBe(o.id);
    await expect(call("occurrence.record",{occurrence:ref(o),expectedVersion:0,status:"completed"})).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(call("task.get",{id:item.task.id,occurrence:{...ref(o),taskId:randomUUID()}})).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it("版本竞争仅一个修改成功",async () => {
    const item = await call("task.create",{draft}); const outcomes = await Promise.allSettled([call("task.update",{id:item.task.id,expectedVersion:1,draft:{...draft,title:"A"}}),call("task.update",{id:item.task.id,expectedVersion:1,draft:{...draft,title:"B"}})]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(o => o.status === "rejected")).toMatchObject({reason:{code:"VERSION_CONFLICT"}});
  });
  it("删除隐藏并释放容量，恢复保留完成状态",async () => {
    const item = await call("task.create",{draft}); const o = item.nextOccurrences[0]; if (!o) throw new Error("Missing occurrence");
    const completed = await call("occurrence.record",{occurrence:ref(o),expectedVersion:0,status:"completed"});
    const deleted = await call("task.delete",{id:item.task.id,expectedVersion:completed.taskVersion});
    await expect(call("task.get",{id:item.task.id})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect((await call("task.list",{})).items).toHaveLength(0); expect((await call("task.recycleList",{})).items).toHaveLength(1);
    const restored = await call("task.restore",{id:item.task.id,expectedVersion:deleted.version}); expect(restored.task.lifecycle).toBe("active");
    expect((await call("task.get",{id:item.task.id})).occurrence?.status).toBe("completed");
  });
  it("分页签名、查询绑定、权限绑定与修改失效",async () => {
    for (let i=0;i<3;i++) await call("task.create",{draft:{...draft,title:String(i)}});
    const first = await call("task.list",{limit:2}); expect(first.items).toHaveLength(2); expect(first.complete).toBe(false); expect(first.summary).toBeNull(); if (!first.nextCursor) throw new Error("Missing cursor");
    const second = await call("task.list",{limit:2,cursor:first.nextCursor}); expect(second.items).toHaveLength(1); expect(second.summary?.pending).toBe(3); expect(second.asOf).toBe(first.asOf);
    await expect(call("task.list",{limit:1,cursor:first.nextCursor})).rejects.toMatchObject({code:"CURSOR_EXPIRED"});
    await expect(call("task.list",{limit:2,cursor:first.nextCursor.slice(0,-1)+"!"})).rejects.toMatchObject({code:"CURSOR_EXPIRED"});
    await call("task.create",{draft}); await expect(call("task.list",{limit:2,cursor:first.nextCursor})).rejects.toMatchObject({code:"CURSOR_EXPIRED"});
  });
  it("无时刻不制造午夜提醒，提醒收起不完成事项，关闭偏好保留",async () => {
    await call("task.create",{draft:{...draft,schedule:{kind:"once",date:"2026-09-10",time:null}}});
    const timed = await call("task.create",{draft}); const o=timed.nextOccurrences[0]; if (!o) throw new Error("Missing occurrence");
    expect((await call("reminder.list",{})).items).toHaveLength(1);
    await call("reminder.markRead",{occurrence:ref(o)}); await call("reminder.dismiss",{occurrence:ref(o)});
    expect((await call("reminder.list",{})).items).toHaveLength(0); expect((await call("reminder.list",{includeDismissed:true})).items[0]?.readAt).toBe(now.toISOString());
    expect((await call("task.get",{id:timed.task.id})).occurrence?.status).toBe("pending");
    const preference = await call("reminder.setMine",{taskId:timed.task.id,enabled:false,expectedVersion:1}); expect(preference.preference.selfDisabled).toBe(true);
  });
  it("500 条容量与恢复容量均由事务检查",async () => {
    const task = await call("task.create",{draft}); const deleted = await call("task.delete",{id:task.task.id,expectedVersion:1});
    for (const [key,record] of database.documents) if (key.startsWith("user_scopes/")) record.personalTaskCount = 500;
    await expect(call("task.create",{draft})).rejects.toMatchObject({code:"LIMIT_EXCEEDED"});
    await expect(call("task.restore",{id:task.task.id,expectedVersion:deleted.version})).rejects.toMatchObject({code:"LIMIT_EXCEEDED"});
  });
  it("上海日期边界、未安排和积压互不混淆",async () => {
    await call("task.create",{draft:{...draft,schedule:{kind:"once",date:null,time:null}}});
    await call("task.create",{draft:{...draft,schedule:{kind:"once",date:"2026-09-10",time:null}}});
    await call("task.create",{draft});
    expect((await call("task.list",{})).items).toHaveLength(1); expect((await call("task.list",{unscheduled:true})).items).toHaveLength(1); expect((await call("task.list",{overdue:true})).items).toHaveLength(1);
  });
});
it("运行时拒绝身份注入、非法日期、空游标、周期写入和响应私密字段",() => {
  expect(isPersonalPayload("task.create",{draft,userId:randomUUID()})).toBe(false);
  expect(isPersonalPayload("task.create",{draft:{...draft,familyId:randomUUID()}})).toBe(true);
  expect(isPersonalPayload("task.create",{draft:{...draft,schedule:{kind:"once",date:"2026-02-30",time:null}}})).toBe(false);
  expect(isPersonalPayload("task.create",{draft:{...draft,schedule:{kind:"daily",startDate:"2026-09-11",times:[]}}})).toBe(false);
  expect(isPersonalPayload("task.list",{cursor:""})).toBe(false);
  expect(isPersonalPayload("task.list",{dateFrom:"2026-01-01",dateTo:"2026-02-01"})).toBe(false);
  expect(isPersonalPayload("task.list",{overdue:true,status:"completed"})).toBe(false);
});
