import { seedLegacyTask } from "./support/legacy-task";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isFamilyData, isPersonalData } from "@family-todo/contracts";
import type { FamilyAction, FamilyActionMap, PersonalAction, PersonalActionMap, TaskDraft } from "@family-todo/contracts";
import { FamilyService, registerFamilyHandlers } from "../packages/application/src/family";
import { CollaborativeTaskService } from "../packages/application/src/collaborative-tasks";
import { ActionRouter } from "../packages/application/src/router";
import { CloudBasePersonalStore } from "../packages/infra-cloudbase/src/personal-store";
import { familyFixture } from "./support/family-fixture";

type Fixture = Awaited<ReturnType<typeof familyFixture>>;
async function client(database?: Fixture["database"], name = "家人") {
  const f = await familyFixture(database, name); let time = new Date(f.now);
  const clock = { now: () => time };
  return { ...f, setTime: (value: string) => { time = new Date(value); },
    async call<A extends FamilyAction>(action: A, payload: FamilyActionMap[A]["payload"], requestId = randomUUID()): Promise<FamilyActionMap[A]["data"]> {
      const result = await new FamilyService(f.store(), clock, { generate: randomUUID }).execute(action, payload, requestId);
      if (!isFamilyData(action, result)) throw new Error("Invalid test response"); return result;
    },
    async task<A extends PersonalAction>(action: A, payload: PersonalActionMap[A]["payload"], requestId = randomUUID()): Promise<PersonalActionMap[A]["data"]> {
      const service = new CollaborativeTaskService(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-secret-32-characters-long"), clock, { generate: randomUUID });
      const result = action === "task.create" && "draft" in payload && !payload.draft.familyId ? await seedLegacyTask(f.store(), new CloudBasePersonalStore(f.database, f.identity, "test-family-secret-32-characters-long"), clock, { generate: randomUUID }, payload.draft, requestId) : await service.execute(action, payload, requestId); if (!isPersonalData(action, result)) throw new Error("Invalid task test response"); return result;
    }
  };
}
type Client = Awaited<ReturnType<typeof client>>;
async function household() {
  const owner = await client(undefined, "拥有人"); const member = await client(owner.database, "普通成员");
  const { family } = await owner.call("family.create", { name: "我们的家", myName: "拥有人" });
  const invite = await owner.call("invitation.create", { familyId: family.id, expectedFamilyVersion: family.version });
  const joined = await member.call("invitation.accept", { token: invite.token, myName: "普通成员" });
  return { owner, member, familyId: family.id, ownerId: family.myMembershipId, memberId: joined.membershipId, invite };
}
async function exit(c: Client, familyId: string, targetMembershipId: string, mode: "leave" | "remove" = "leave", requestId = randomUUID()) {
  const input = { familyId, targetMembershipId, mode };
  let result = await c.call("family.previewExit", input);
  while (!result.complete) result = await c.call("family.previewExit", { ...input, cursor: result.nextCursor });
  const payload = { ...input, previewToken: result.preview.previewToken, expectedFamilyVersion: result.preview.familyVersion };
  return { result: await c.call("family.exit", payload, requestId), payload, preview: result.preview };
}
async function transfer(c: Client, familyId: string, toMembershipId: string, requestId = randomUUID()) {
  const input = { familyId, toMembershipId }; let result = await c.call("family.previewTransfer", input);
  while (!result.complete) result = await c.call("family.previewTransfer", { ...input, cursor: result.nextCursor });
  const payload = { ...input, previewToken: result.preview.previewToken, expectedFamilyVersion: result.preview.familyVersion };
  return { result: await c.call("family.transferOwnership", payload, requestId), payload };
}
function draft(familyId: string): TaskDraft { return { title: "只有本人可见的秘密", note: "私密内容", familyId, subject: { kind: "self" }, schedule: { kind: "once", date: "2026-09-12", time: "09:00" }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } }; }

describe("家庭生命周期：真实适配器与本地事务模拟", () => {
  it("注册全部 19 actions，拒绝客户端身份字段", async () => {
    const c = await client(); const router = new ActionRouter(); registerFamilyHandlers(router, async () => c.store(), { now: () => new Date(c.now) }, { generate: randomUUID });
    await expect(router.dispatch({ apiVersion: 1, requestId: randomUUID(), action: "family.create", payload: { name: "家", myName: "我", userId: c.user.id } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await router.dispatch({ apiVersion: 1, requestId: randomUUID(), action: "family.list", payload: {} })).toMatchObject({ items: [], complete: true });
  });
  it("家庭创建持久化幂等、同 ID 跨 action 冲突、只创建一个成员槽", async () => {
    const c = await client(); const id = randomUUID(); const input = { name: "家", myName: "我" };
    const [a, b] = await Promise.all([c.call("family.create", input, id), c.call("family.create", input, id)]);
    expect(a).toEqual(b); expect(c.database.conflicts).toBeGreaterThan(0);
    expect((await c.call("family.list", {})).items).toHaveLength(1);
    expect(await c.store().transaction(tx => tx.scope(c.user.id))).toMatchObject({ activeFamilyCount: 1 });
    await expect(c.call("family.update", { id: a.family.id, name: "另一家", expectedVersion: 1 }, id)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const { members } = await c.call("family.get", { id: a.family.id }); expect(members).toHaveLength(1); expect(members[0]).not.toHaveProperty("userId");
  });
  it.each(["families", "memberships", "membership_slots", "user_scopes", "family_events", "idempotency_receipts"])("创建时 %s 失败完整回滚", async collection => {
    const c = await client(); const before = structuredClone(c.database.documents); c.database.failCollection = collection;
    await expect(c.call("family.create", { name: "家", myName: "我" })).rejects.toThrow(); expect(c.database.documents).toEqual(before);
  });
  it("账号 10 家庭容量在并发创建下不超限", async () => {
    const c = await client(); for (let i = 0; i < 9; i++) await c.call("family.create", { name: `家${i}`, myName: "我" });
    const outcomes = await Promise.allSettled([c.call("family.create", { name: "十", myName: "我" }), c.call("family.create", { name: "十一", myName: "我" })]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1); expect(outcomes.find(x => x.status === "rejected")).toMatchObject({ reason: { code: "LIMIT_EXCEEDED" } });
    expect((await c.call("family.list", {})).items).toHaveLength(10);
  });
  it("邀请可转发、同用户并发接受唯一、摘要无 token，回执仅加密口令", async () => {
    const owner = await client(); const other = await client(owner.database); const third = await client(owner.database);
    const { family } = await owner.call("family.create", { name: "家", myName: "邀请人" }); const id = randomUUID(); const input = { familyId: family.id, expectedFamilyVersion: family.version };
    const invite = await owner.call("invitation.create", input, id); expect(invite.token).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(Date.parse(invite.expiresAt) - Date.parse(owner.now)).toBe(7 * 86400000);
    expect(await owner.call("invitation.create", input, id)).toEqual(invite);
    expect(JSON.stringify([...owner.database.documents.values()])).not.toContain(invite.token);
    expect(await other.call("invitation.preview", { token: invite.token })).toEqual({ familyName: "家", inviterName: "邀请人", expiresAt: invite.expiresAt, alreadyJoined: false });
    const [a, b] = await Promise.all([other.call("invitation.accept", { token: invite.token, myName: "甲" }), other.call("invitation.accept", { token: invite.token, myName: "乙" })]);
    expect(a.membershipId).toBe(b.membershipId); expect([a.alreadyJoined, b.alreadyJoined].sort()).toEqual([false, true]);
    await third.call("invitation.accept", { token: invite.token, myName: "丙" });
    expect((await owner.call("family.get", { id: family.id })).members).toHaveLength(3);
    expect(JSON.stringify(await owner.call("invitation.list", { familyId: family.id }))).not.toContain("token");
    await expect(other.call("invitation.list", { familyId: family.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("撤销与过期阻止后续加入和口令重放，不移除既有成员", async () => {
    const h = await household(); const outsider = await client(h.owner.database); const { family } = await h.owner.call("family.get", { id: h.familyId });
    const id = randomUUID(); const input = { familyId: h.familyId, expectedFamilyVersion: family.version }; const invite = await h.owner.call("invitation.create", input, id);
    await h.owner.call("invitation.revoke", { id: invite.id, expectedVersion: invite.version });
    for (const token of [invite.token, "AAAAAAAAAAAAAAAAAAAAAA"]) {
      await expect(outsider.call("invitation.preview", { token })).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
      await expect(outsider.call("invitation.accept", { token, myName: "我" })).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
    }
    await expect(h.owner.call("invitation.create", input, id)).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
    expect((await h.member.call("family.get", { id: h.familyId })).members).toHaveLength(2);
    outsider.setTime(h.invite.expiresAt); await expect(outsider.call("invitation.accept", { token: h.invite.token, myName: "我" })).rejects.toMatchObject({ code: "INVITATION_UNAVAILABLE" });
  });
  it("真实成员 20 名容量并发保护，重复加入不消耗额度", async () => {
    const h = await household(); for (let i = 0; i < 17; i++) { const c = await client(h.owner.database); await c.call("invitation.accept", { token: h.invite.token, myName: `成员${i}` }); }
    const a = await client(h.owner.database); const b = await client(h.owner.database);
    const outcomes = await Promise.allSettled([a.call("invitation.accept", { token: h.invite.token, myName: "甲" }), b.call("invitation.accept", { token: h.invite.token, myName: "乙" })]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1); expect(outcomes.find(x => x.status === "rejected")).toMatchObject({ reason: { code: "LIMIT_EXCEEDED" } });
    expect((await h.owner.call("family.get", { id: h.familyId })).members).toHaveLength(20);
    expect(await h.member.call("invitation.accept", { token: h.invite.token, myName: "我" })).toMatchObject({ membershipId: h.memberId, alreadyJoined: true });
  });
  it("当前家庭鉴权隔离：别家拥有人不能读取、改名、邀请、管理虚拟成员", async () => {
    const h = await household(); const stranger = await client(h.owner.database); await stranger.call("family.create", { name: "别家", myName: "拥有人" });
    await expect(stranger.call("family.get", { id: h.familyId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(stranger.call("member.rename", { id: h.memberId, name: "篡改", expectedVersion: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { family } = await h.member.call("family.get", { id: h.familyId });
    await expect(h.member.call("family.update", { id: h.familyId, name: "篡改", expectedVersion: family.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.member.call("virtualMember.create", { familyId: h.familyId, name: "孩子", expectedFamilyVersion: family.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await h.member.call("member.rename", { id: h.memberId, expectedVersion: 1, name: "爸爸" })).member.role).toBe("member");
    await expect(h.member.call("member.rename", { id: h.ownerId, name: "篡改", expectedVersion: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await h.owner.call("member.rename", { id: h.memberId, expectedVersion: 2, name: "新称呼" })).member.version).toBe(3);
  });
  it("虚拟成员独立 20 名容量、改名、停用释放名额且保留历史分页", async () => {
    const h = await household(); let first: FamilyActionMap["virtualMember.create"]["data"] | undefined;
    for (let i = 0; i < 20; i++) { const { family } = await h.owner.call("family.get", { id: h.familyId }); const created = await h.owner.call("virtualMember.create", { familyId: h.familyId, expectedFamilyVersion: family.version, name: `孩子${i}` }); first ??= created; }
    if (!first) throw new Error("Missing fixture"); const { family } = await h.owner.call("family.get", { id: h.familyId });
    await expect(h.owner.call("virtualMember.create", { familyId: h.familyId, expectedFamilyVersion: family.version, name: "超限" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const renamed = await h.owner.call("virtualMember.update", { id: first.member.id, expectedVersion: 1, name: "小宝" });
    await h.owner.call("virtualMember.deactivate", { id: first.member.id, expectedVersion: renamed.member.version });
    expect((await h.owner.call("family.get", { id: h.familyId })).virtualMembers).toHaveLength(19);
    expect((await h.member.call("virtualMember.list", { familyId: h.familyId, status: "inactive" })).items).toEqual([expect.objectContaining({ id: first.member.id, name: "小宝", status: "inactive" })]);
    const current = await h.owner.call("family.get", { id: h.familyId }); await h.owner.call("virtualMember.create", { familyId: h.familyId, expectedFamilyVersion: current.family.version, name: "新宝宝" });
  });
  it("列表游标绑定身份、条件、家庭版本、用户名单版本与 15 分钟有效期", async () => {
    const h = await household(); const input = { familyId: h.familyId, limit: 1 }; const first = await h.owner.call("member.list", input); if (!first.nextCursor) throw new Error("Missing cursor");
    expect((await h.owner.call("member.list", { ...input, cursor: first.nextCursor })).items).toHaveLength(1);
    await expect(h.member.call("member.list", { ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(h.owner.call("member.list", { ...input, status: "left", cursor: first.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    h.owner.setTime("2026-09-11T12:15:00.000Z"); await expect(h.owner.call("member.list", { ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" }); h.owner.setTime(h.owner.now);
    await h.member.call("member.rename", { id: h.memberId, expectedVersion: 1, name: "改名" }); await expect(h.owner.call("member.list", { ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await h.owner.call("family.create", { name: "第二家", myName: "我" }); const families = await h.owner.call("family.list", { limit: 1 }); if (!families.nextCursor) throw new Error("Missing cursor");
    await h.owner.call("family.create", { name: "第三家", myName: "我" }); await expect(h.owner.call("family.list", { limit: 1, cursor: families.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
  it("拥有人不能直接退出、成员不能移除他人或转交，跨家庭承接被拒绝", async () => {
    const h = await household(); const other = await h.owner.call("family.create", { name: "另一家", myName: "我" });
    await expect(h.owner.call("family.previewExit", { familyId: h.familyId, targetMembershipId: h.ownerId, mode: "leave" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(h.member.call("family.previewExit", { familyId: h.familyId, targetMembershipId: h.ownerId, mode: "remove" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.member.call("family.previewTransfer", { familyId: h.familyId, toMembershipId: h.ownerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.owner.call("family.previewTransfer", { familyId: h.familyId, toMembershipId: other.family.myMembershipId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("私密事项不向拥有人泄露标题，退出后承接历史、回收事项且剥夺原成员访问", async () => {
    const h = await household(); const active = await h.member.task("task.create", { draft: draft(h.familyId) });
    const deleted = await h.member.task("task.create", { draft: { ...draft(h.familyId), title: "回收秘密" } }); await h.member.task("task.delete", { id: deleted.task.id, expectedVersion: deleted.task.version });
    await expect(h.owner.task("task.get", { id: active.task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const checked = await h.owner.call("family.previewExit", { familyId: h.familyId, targetMembershipId: h.memberId, mode: "remove" });
    expect(checked).toMatchObject({ complete: true, preview: { ownedTaskCount: 2, privateTaskCount: 2, createdManagementCount: 2 } });
    expect(JSON.stringify(checked)).not.toContain(active.task.title); expect(JSON.stringify(checked)).not.toContain("回收秘密");
    await exit(h.member, h.familyId, h.memberId);
    expect((await h.owner.task("task.get", { id: active.task.id })).task.capabilities.canEdit).toBe(true);
    expect((await h.owner.task("task.restore", { id: deleted.task.id, expectedVersion: 2 })).task.lifecycle).toBe("active");
    await expect(h.member.task("task.get", { id: active.task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.member.call("family.get", { id: h.familyId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await h.member.call("family.list", {})).items).toEqual([]);
  });
  it("退出和转交失权后仅重放最小确认，旧邀请口令不能因重放再次泄露", async () => {
    const h = await household(); const inviteId = randomUUID(); const { family } = await h.owner.call("family.get", { id: h.familyId });
    const invitationInput = { familyId: h.familyId, expectedFamilyVersion: family.version }; await h.owner.call("invitation.create", invitationInput, inviteId);
    const transferId = randomUUID(); const moved = await transfer(h.owner, h.familyId, h.memberId, transferId);
    expect(await h.owner.call("family.transferOwnership", moved.payload, transferId)).toEqual(moved.result);
    await expect(h.owner.call("invitation.create", invitationInput, inviteId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const exitId = randomUUID(); const left = await exit(h.owner, h.familyId, h.ownerId, "leave", exitId);
    expect(await h.owner.call("family.exit", left.payload, exitId)).toEqual({ familyId: h.familyId, exitedMembershipId: h.ownerId, completed: true });
    expect(await h.owner.call("family.transferOwnership", moved.payload, transferId)).toEqual(moved.result);
    await expect(h.owner.call("family.exit", { ...left.payload, mode: "remove" }, exitId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(h.owner.call("family.get", { id: h.familyId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("退出预览绑定完整参数与操作者，5 分钟失效、家庭任意写后必须重新确认", async () => {
    const h = await household(); const input = { familyId: h.familyId, targetMembershipId: h.memberId, mode: "leave" as const };
    const preview = await h.member.call("family.previewExit", input); if (!preview.complete) throw new Error("Unexpected pagination");
    const payload = { ...input, previewToken: preview.preview.previewToken, expectedFamilyVersion: preview.preview.familyVersion };
    await expect(h.owner.call("family.exit", { ...payload, mode: "remove" })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    await expect(h.member.call("family.exit", { ...payload, previewToken: payload.previewToken.slice(0, -1) + "!" })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    h.member.setTime(preview.preview.expiresAt); await expect(h.member.call("family.exit", payload)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" }); h.member.setTime(h.member.now);
    await h.member.call("member.rename", { id: h.memberId, expectedVersion: 1, name: "改名" });
    await expect(h.member.call("family.exit", payload)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    expect((await h.member.call("family.get", { id: h.familyId })).members).toHaveLength(2);
  });
  it("超过 200 候选预览不伪称完整、分页包含回收站并拒绝串用户游标", async () => {
    const h = await household(); const first = await h.member.task("task.create", { draft: draft(h.familyId) });
    const source = await h.member.store().readTask(first.task.id); if (!source) throw new Error("Missing task");
    // Controlled volume fixture; user access and lifecycle operations still use the real service and adapter.
    for (let i = 1; i < 205; i++) await h.member.store().transaction(tx => tx.saveTask({ ...source, id: randomUUID(), occurrenceId: randomUUID(), segmentId: randomUUID(), lifecycle: i >= 202 ? "deleted" : "active" }));
    const input = { familyId: h.familyId, targetMembershipId: h.memberId, mode: "leave" as const };
    const firstPage = await h.member.call("family.previewExit", input); expect(firstPage).toMatchObject({ complete: false, preview: null }); if (firstPage.complete) throw new Error("Expected continuation");
    await expect(h.owner.call("family.previewExit", { ...input, mode: "remove", cursor: firstPage.nextCursor })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    const complete = await h.member.call("family.previewExit", { ...input, cursor: firstPage.nextCursor }); expect(complete).toMatchObject({ complete: true, preview: { ownedTaskCount: 205, createdManagementCount: 205, privateTaskCount: 205 } });
    const expired = await h.member.call("family.previewExit", input); if (expired.complete) throw new Error("Expected continuation");
    h.member.setTime("2026-09-11T12:15:00.000Z"); await expect(h.member.call("family.previewExit", { ...input, cursor: expired.nextCursor })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  });
  it("重新加入使用新成员 ID，旧权限不复活；多次转交退出后承接链完整", async () => {
    const h = await household(); const third = await client(h.owner.database); const thirdJoin = await third.call("invitation.accept", { token: h.invite.token, myName: "第三人" });
    const created = await h.member.task("task.create", { draft: draft(h.familyId) });
    await exit(h.member, h.familyId, h.memberId);
    const rejoined = await h.member.call("invitation.accept", { token: h.invite.token, myName: "重新加入" }); expect(rejoined.membershipId).not.toBe(h.memberId);
    await expect(h.member.task("task.get", { id: created.task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const historical = await h.owner.call("member.list", { familyId: h.familyId, status: "left" }); expect(historical.items).toEqual([expect.objectContaining({ id: h.memberId, status: "left", role: "member" })]);
    await transfer(h.owner, h.familyId, thirdJoin.membershipId);
    const preview = await h.owner.call("family.previewExit", { familyId: h.familyId, targetMembershipId: h.ownerId, mode: "leave" }); expect(preview).toMatchObject({ preview: { ownedTaskCount: 1, createdManagementCount: 1 } });
    await exit(h.owner, h.familyId, h.ownerId);
    const inherited = await third.task("task.get", { id: created.task.id }); expect(inherited.task.ownerName).toBe("第三人"); expect(inherited.task.capabilities.canEdit).toBe(true);
    expect((await third.store().readTask(created.task.id))?.collaboration?.creatorMembershipId).toBe(h.memberId);
  });
  it("虚拟事项转交归属跟随新拥有人、原创建者保留管理，执行对象和历史不改写", async () => {
    const h = await household(); const { family } = await h.owner.call("family.get", { id: h.familyId }); const virtual = await h.owner.call("virtualMember.create", { familyId: h.familyId, expectedFamilyVersion: family.version, name: "宝宝" });
    const created = await h.owner.task("task.create", { draft: { ...draft(h.familyId), subject: { kind: "virtual", virtualMemberId: virtual.member.id } } });
    const preview = await h.owner.call("family.previewTransfer", { familyId: h.familyId, toMembershipId: h.memberId }); expect(preview).toMatchObject({ complete: true, preview: { virtualTaskCount: 1 } });
    await transfer(h.owner, h.familyId, h.memberId);
    expect((await h.member.task("task.get", { id: created.task.id })).task).toMatchObject({ ownerName: "普通成员", subject: { kind: "virtual", virtualMemberId: virtual.member.id }, capabilities: { canEdit: true } });
    expect((await h.owner.task("task.get", { id: created.task.id })).task.capabilities.canEdit).toBe(true);
    expect((await h.member.call("family.get", { id: h.familyId })).members).toHaveLength(2);
  });
  it("移除事务失败不造成半次交接、成功后计数和权限 epoch 一起更新", async () => {
    const h = await household(); const before = await h.owner.call("family.get", { id: h.familyId });
    const preview = await h.owner.call("family.previewExit", { familyId: h.familyId, targetMembershipId: h.memberId, mode: "remove" }); if (!preview.complete) throw new Error("Unexpected continuation");
    const input = { familyId: h.familyId, targetMembershipId: h.memberId, mode: "remove" as const, expectedFamilyVersion: preview.preview.familyVersion, previewToken: preview.preview.previewToken };
    const snapshot = structuredClone(h.owner.database.documents); h.owner.database.failCollection = "family_events";
    await expect(h.owner.call("family.exit", input)).rejects.toThrow(); expect(h.owner.database.documents).toEqual(snapshot); h.owner.database.failCollection = null;
    await h.owner.call("family.exit", input);
    const after = await h.owner.call("family.get", { id: h.familyId }); expect(after.members).toHaveLength(1); expect(after.family.authEpoch).toBe(before.family.authEpoch + 1); expect(after.family.version).toBe(before.family.version + 1);
    expect(await h.member.store().transaction(tx => tx.scope(h.member.user.id))).toMatchObject({ activeFamilyCount: 0 });
  });
  it("家庭与个人写共享幂等命名空间，退出不改变其他家庭、个人事项或本人关闭偏好", async () => {
    const h = await household(); const otherFamily = await h.member.call("family.create", { name: "另一个家", myName: "我" });
    const personalDraft: TaskDraft = { ...draft(h.familyId), familyId: null };
    const id = randomUUID(); const personal = await h.member.task("task.create", { draft: personalDraft }, id);
    await expect(h.member.call("family.create", { name: "冲突", myName: "我" }, id)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const familyRequestId = randomUUID(); const familyTask = await h.member.task("task.create", { draft: draft(h.familyId) }, familyRequestId);
    await h.member.task("reminder.setMine", { taskId: familyTask.task.id, enabled: false, expectedVersion: familyTask.task.myReminder.version });
    const before = await h.member.store().transaction(tx => tx.preference(familyTask.task.id, h.member.user.id));
    await exit(h.member, h.familyId, h.memberId);
    await expect(h.member.task("task.create", { draft: draft(h.familyId) }, familyRequestId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await h.member.task("task.get", { id: personal.task.id })).task.id).toBe(personal.task.id);
    expect((await h.member.call("family.get", { id: otherFamily.family.id })).family.id).toBe(otherFamily.family.id);
    await h.member.call("invitation.accept", { token: h.invite.token, myName: "重新加入" });
    expect(await h.member.store().transaction(tx => tx.preference(familyTask.task.id, h.member.user.id))).toEqual(before);
    expect(before).toMatchObject({ selfDisabled: true, enabled: false });
  });
  it("新加入也检查账号 10 家庭额度；旧接受回执在退出再加入后不可重放旧关系", async () => {
    const h = await household(); const c = await client(h.owner.database);
    for (let i = 0; i < 10; i++) await c.call("family.create", { name: `家庭${i}`, myName: "我" });
    await expect(c.call("invitation.accept", { token: h.invite.token, myName: "我" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const id = randomUUID(); const payload = { token: h.invite.token, myName: "普通成员" };
    await h.member.call("invitation.accept", payload, id);
    await exit(h.member, h.familyId, h.memberId);
    await expect(h.member.call("invitation.accept", payload, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const newJoin = await h.member.call("invitation.accept", payload);
    expect(newJoin.membershipId).not.toBe(h.memberId);
    await expect(h.member.call("invitation.accept", payload, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

});
