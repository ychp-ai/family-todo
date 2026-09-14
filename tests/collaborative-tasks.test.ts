import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPersonalData } from "@family-todo/contracts";
import type { PersonalAction, PersonalActionMap, TaskDraft, TaskDTO } from "@family-todo/contracts";
import type { Family, Membership } from "@family-todo/domain";
import { CollaborativeTaskService } from "../packages/application/src/collaborative-tasks";
import { CloudBasePersonalStore } from "../packages/infra-cloudbase/src/personal-store";
import { familyFixture } from "./support/family-fixture";

type Actor = Awaited<ReturnType<typeof familyFixture>> & { member: Membership };
async function setup() {
  const owner = await familyFixture(undefined, "拥有人"); const creator = await familyFixture(owner.database, "创建人"); const viewer = await familyFixture(owner.database, "查看人");
  const familyId = randomUUID();
  const actors: Actor[] = [owner, creator, viewer].map(f => ({ ...f, member: { id: randomUUID(), familyId, userId: f.user.id, name: f.user.displayName, status: "active", successorMembershipId: null, version: 1, createdAt: f.now, updatedAt: f.now } }));
  const [a, b, c] = actors; if (!a || !b || !c) throw new Error("Missing actors");
  const family: Family = { id: familyId, name: "测试家庭", ownerMembershipId: a.member.id, version: 1, authEpoch: 1, taskCount: 0, memberCount: 3, virtualMemberCount: 0, createdAt: a.now, updatedAt: a.now };
  await a.store().transaction(async tx => {
    await tx.saveFamily(family);
    for (const actor of actors) {
      await tx.saveMember(actor.member); await tx.saveSlot({ familyId, userId: actor.user.id, activeMembershipId: actor.member.id });
      const scope = await tx.scope(actor.user.id); scope.activeFamilyCount++; scope.revision++; await tx.saveScope(scope);
    }
  });
  return { owner: a, creator: b, viewer: c, family };
}
async function call<K extends PersonalAction>(actor: Actor, action: K, payload: PersonalActionMap[K]["payload"], requestId = randomUUID()) {
  const service = new CollaborativeTaskService(actor.store(), new CloudBasePersonalStore(actor.database, actor.identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date(actor.now) }, { generate: randomUUID });
  const result = await service.execute(action, payload, requestId);
  if (!isPersonalData(action, result)) throw new Error("Invalid response"); return result;
}
function draft(familyId: string | null): TaskDraft & { schedule: { kind: "once"; date: string; time: string } } { return { title: "家庭安排", note: "", familyId, subject: { kind: "self" }, schedule: { kind: "once", date: "2026-09-11", time: "20:00" }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } }; }
function access(task: TaskDTO) { return { viewerMembershipIds: task.participants.filter(p => p.canView && !p.requiredViewer).map(p => p.membershipId), helperMembershipIds: task.participants.filter(p => p.canHelp).map(p => p.membershipId), reminderMembershipIds: task.participants.filter(p => p.receivesReminder).map(p => p.membershipId), remindMe: task.myReminder.enabled }; }

describe("collaborative once tasks", () => {
  it("keeps ordinary private tasks hidden from the family owner and isolates list summaries", async () => {
    const f = await setup(); const created = await call(f.creator, "task.create", { draft: draft(f.family.id) });
    await expect(call(f.owner, "task.get", { id: created.task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ownerList = await call(f.owner, "task.list", {}); expect(ownerList.items).toEqual([]); expect(ownerList.summary?.denominator).toBe(0);
    const ownList = await call(f.creator, "task.list", {}); expect(ownList.items.map(item => item.task.id)).toEqual([created.task.id]); expect(ownList.summary?.denominator).toBe(1);
  });
  it("separates necessary subject viewing, recording, management, and reminders", async () => {
    const f = await setup(); const d = draft(f.family.id); d.subject = { kind: "member", membershipId: f.viewer.member.id };
    const created = await call(f.creator, "task.create", { draft: d }); const viewed = await call(f.viewer, "task.get", { id: created.task.id });
    expect(viewed.task.capabilities).toMatchObject({ canRecord: true, canEdit: false, canDelete: false }); expect(viewed.task.myReminder.enabled).toBe(false);
    expect(viewed.task.participants.find(p => p.membershipId === f.creator.member.id)).not.toHaveProperty("receivesReminder");
    await expect(call(f.viewer, "task.delete", { id: created.task.id, expectedVersion: created.task.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const occurrence = viewed.occurrence; if (!occurrence) throw new Error("Missing occurrence");
    const recorded = await call(f.viewer, "occurrence.record", { occurrence: { id: occurrence.id, taskId: created.task.id, segmentId: occurrence.segmentId, localDate: occurrence.localDate, slot: occurrence.slot }, expectedVersion: 0, status: "completed" });
    expect(recorded.occurrence.operatorName).toBe(f.viewer.member.name);
  });
  it("replays legacy family receipts without requiring the new creator-manager marker", async () => {
    const f = await setup(); const requestId = randomUUID(); const payload = { draft: draft(f.family.id) };
    const created = await call(f.creator, "task.create", payload, requestId);
    await f.creator.store().transaction(async tx => {
      const receipt = await tx.receipt(f.creator.user.id, requestId);
      if (!receipt || !isPersonalData("task.create", receipt.result)) throw new Error("Missing create receipt");
      receipt.result.task.participants = receipt.result.task.participants.map(participant => {
        const legacy = { ...participant }; delete legacy.isCreatorManager; return legacy;
      });
      await tx.saveReceipt(f.creator.user.id, requestId, receipt);
    });
    const replayed = await call(f.creator, "task.create", payload, requestId);
    expect(replayed.task.id).toBe(created.task.id);
    expect(replayed.task.participants.every(p => p.isCreatorManager === undefined)).toBe(true);
    const fresh = await call(f.creator, "task.get", { id: created.task.id });
    expect(fresh.task.participants.find(p => p.membershipId === f.creator.member.id)?.isCreatorManager).toBe(true);
  });
  it("identifies the resolved creator manager separately from virtual ownership and subject access", async () => {
    const f = await setup(); const virtualId = randomUUID();
    await f.owner.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveVirtualMember({ id: virtualId, familyId: family.id, name: "孩子", status: "active", version: 1, createdAt: f.owner.now, updatedAt: f.owner.now });
      await tx.saveFamily({ ...family, virtualMemberCount: 1, version: family.version + 1 });
    });
    const d = draft(f.family.id); d.subject = { kind: "virtual", virtualMemberId: virtualId };
    const created = await call(f.creator, "task.create", { draft: d });
    expect(created.task.participants.find(p => p.membershipId === f.owner.member.id)).toMatchObject({ requiredViewer: true, isCreatorManager: false });
    expect(created.task.participants.find(p => p.membershipId === f.creator.member.id)).toMatchObject({ requiredViewer: true, isCreatorManager: true });
    await f.owner.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveMember({ ...f.creator.member, status: "left", successorMembershipId: f.viewer.member.id, version: 2 });
      await tx.saveSlot({ familyId: family.id, userId: f.creator.user.id, activeMembershipId: null });
      await tx.saveFamily({ ...family, memberCount: 2, version: family.version + 1, authEpoch: family.authEpoch + 1 });
    });
    const inherited = await call(f.viewer, "task.get", { id: created.task.id });
    expect(inherited.task.participants.filter(p => p.isCreatorManager).map(p => p.membershipId)).toEqual([f.viewer.member.id]);
    expect(inherited.task.participants.some(p => p.membershipId === f.creator.member.id)).toBe(false);
    expect(inherited.task.ownerUserId).toBe(f.owner.user.id);
  });
  it("honors self-disabled reminders and rolls back a manager attempt to re-enable them", async () => {
    const f = await setup(); const d = draft(f.family.id); d.access.viewerMembershipIds = [f.viewer.member.id]; d.access.reminderMembershipIds = [f.viewer.member.id];
    const created = await call(f.creator, "task.create", { draft: d });
    const viewed = await call(f.viewer, "task.get", { id: created.task.id }); await call(f.viewer, "reminder.setMine", { taskId: created.task.id, enabled: false, expectedVersion: viewed.task.myReminder.version });
    const latest = await call(f.creator, "task.get", { id: created.task.id });
    await expect(call(f.creator, "task.setAccess", { id: created.task.id, expectedVersion: latest.task.version, access: { ...access(latest.task), reminderMembershipIds: [f.viewer.member.id] } })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await call(f.creator, "task.get", { id: created.task.id })).task.version).toBe(latest.task.version);
    expect((await call(f.viewer, "reminder.list", {})).items).toEqual([]);
  });
  it("revokes read/helper access immediately and prevents replaying a once-authorized result", async () => {
    const f = await setup(); const d = draft(f.family.id); d.access.viewerMembershipIds = [f.viewer.member.id]; d.access.helperMembershipIds = [f.viewer.member.id];
    const created = await call(f.creator, "task.create", { draft: d }); const viewed = await call(f.viewer, "task.get", { id: created.task.id });
    const requestId = randomUUID(); const payload = { taskId: created.task.id, enabled: true, expectedVersion: viewed.task.myReminder.version };
    await call(f.viewer, "reminder.setMine", payload, requestId); const latest = await call(f.creator, "task.get", { id: created.task.id });
    await call(f.creator, "task.setAccess", { id: created.task.id, expectedVersion: latest.task.version, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } });
    await expect(call(f.viewer, "task.get", { id: created.task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(f.viewer, "reminder.setMine", payload, requestId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps completion and reminder receipt state separate between users", async () => {
    const f = await setup(); const d = draft(f.family.id); d.access.viewerMembershipIds = [f.viewer.member.id]; d.access.reminderMembershipIds = [f.viewer.member.id];
    const created = await call(f.creator, "task.create", { draft: d }); const reminders = await call(f.viewer, "reminder.list", {}); const reminder = reminders.items[0]; if (!reminder) throw new Error("Missing reminder");
    await call(f.viewer, "reminder.dismiss", { occurrence: reminder.occurrence });
    expect((await call(f.viewer, "reminder.list", {})).items).toEqual([]);
    expect((await call(f.creator, "reminder.list", {})).items).toHaveLength(1);
    expect((await call(f.viewer, "task.get", { id: created.task.id })).occurrence?.status).toBe("pending");
  });
  it("merges personal and family rows in stable order and invalidates a cursor after a scope change", async () => {
    const f = await setup(); const first = draft(null); first.title = "个人第一件"; first.schedule.time = "08:00";
    const second = draft(f.family.id); second.title = "家庭第二件"; second.schedule.time = "09:00";
    await call(f.creator, "task.create", { draft: second }); await call(f.creator, "task.create", { draft: first });
    const page = await call(f.creator, "task.list", { limit: 1 }); expect(page.items[0]?.task.title).toBe(first.title); expect(page.summary).toBeNull(); expect(page.complete).toBe(false);
    if (!page.nextCursor) throw new Error("Missing continuation");
    const end = await call(f.creator, "task.list", { limit: 1, cursor: page.nextCursor }); expect(end.items[0]?.task.title).toBe(second.title); expect(end.summary?.denominator).toBe(2);
    await call(f.creator, "task.create", { draft: draft(f.family.id) });
    await expect(call(f.creator, "task.list", { limit: 1, cursor: page.nextCursor })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
  it("promotes a personal task without duplicating it and preserves create retry identities", async () => {
    const f = await setup(); const requestId = randomUUID(); const payload = { draft: draft(null) };
    const created = await call(f.creator, "task.create", payload, requestId); expect((await call(f.creator, "task.create", payload, requestId)).task.id).toBe(created.task.id);
    const moved = await call(f.creator, "task.update", { id: created.task.id, expectedVersion: created.task.version, draft: draft(f.family.id) });
    if (!("task" in moved)) throw new Error("Unexpected access loss");
    expect(moved.task.id).toBe(created.task.id); expect(moved.task.familyId).toBe(f.family.id);
    expect((await call(f.creator, "task.list", { familyId: null })).items).toEqual([]);
    expect((await f.creator.store().transaction(tx => tx.scope(f.creator.user.id))).personalTaskCount).toBe(0);
    expect((await f.creator.store().context(f.family.id))?.family.taskCount).toBe(1);
    expect((await call(f.creator, "task.create", payload, requestId)).task.id).toBe(created.task.id);
    expect((await f.creator.store().context(f.family.id))?.family.taskCount).toBe(1);
  });
  it.each(["completed", "skipped"] as const)("preserves an existing %s occurrence when only joining a family", async status => {
    const f = await setup(); const created = await call(f.creator, "task.create", { draft: draft(null) });
    const occurrence = created.nextOccurrences[0]; if (!occurrence) throw new Error("Missing occurrence");
    const ref = { id: occurrence.id, taskId: created.task.id, segmentId: occurrence.segmentId, localDate: occurrence.localDate, slot: occurrence.slot };
    const recorded = await call(f.creator, "occurrence.record", { occurrence: ref, expectedVersion: 0, status });
    const changed = draft(f.family.id); changed.subject = { kind: "member", membershipId: f.viewer.member.id };
    await expect(call(f.creator, "task.update", { id: created.task.id, expectedVersion: recorded.taskVersion, draft: changed })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const moved = await call(f.creator, "task.update", { id: created.task.id, expectedVersion: recorded.taskVersion, draft: draft(f.family.id) });
    if (!("task" in moved)) throw new Error("Unexpected access loss");
    expect(moved.nextOccurrences[0]).toMatchObject(recorded.occurrence);
    expect((await call(f.creator, "task.get", { id: created.task.id, occurrence: ref })).occurrence).toMatchObject(recorded.occurrence);
  });
  it("preserves personal read and dismissed receipts for the same promoted occurrence", async () => {
    const f = await setup(); const created = await call(f.creator, "task.create", { draft: draft(null) });
    const reminder = (await call(f.creator, "reminder.list", {})).items[0]; if (!reminder) throw new Error("Missing reminder");
    await call(f.creator, "reminder.markRead", { occurrence: reminder.occurrence });
    await call(f.creator, "reminder.dismiss", { occurrence: reminder.occurrence });
    const latest = await call(f.creator, "task.get", { id: created.task.id });
    const moved = await call(f.creator, "task.update", { id: created.task.id, expectedVersion: latest.task.version, draft: draft(f.family.id) });
    if (!("task" in moved)) throw new Error("Unexpected access loss");
    expect(moved.nextOccurrences[0]?.id).toBe(reminder.occurrence.id);
    expect((await call(f.creator, "reminder.list", {})).items).toEqual([]);
    expect((await call(f.creator, "reminder.list", { includeDismissed: true })).items[0]).toMatchObject({ readAt: f.creator.now, dismissedAt: f.creator.now });
  });
  it.each([false, true])("confirms a virtual-to-real edit after the owner loses access (inherited creator: %s)", async inherited => {
    const f = await setup(); const virtualId = randomUUID();
    await f.owner.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      family.virtualMemberCount++; family.version++;
      await tx.saveVirtualMember({ id: virtualId, familyId: family.id, name: "宝宝", status: "active", version: 1, createdAt: f.owner.now, updatedAt: f.owner.now }); await tx.saveFamily(family);
    });
    const initial = draft(f.family.id); initial.subject = { kind: "virtual", virtualMemberId: virtualId };
    const created = await call(f.creator, "task.create", { draft: initial });
    if (inherited) await f.owner.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveMember({ ...f.creator.member, status: "left", successorMembershipId: f.viewer.member.id, version: 2 });
      await tx.saveSlot({ familyId: family.id, userId: f.creator.user.id, activeMembershipId: null });
      family.memberCount--; family.version++; family.authEpoch++; await tx.saveFamily(family);
    });
    expect((await call(f.owner, "task.get", { id: created.task.id })).task.capabilities.canEdit).toBe(true);
    const changed = draft(f.family.id); changed.subject = { kind: "member", membershipId: f.viewer.member.id };
    const requestId = randomUUID(); const payload = { id: created.task.id, expectedVersion: created.task.version, draft: changed };
    const result = await call(f.owner, "task.update", payload, requestId);
    expect(result).toEqual({ id: created.task.id, version: 2, updated: true, accessLost: true });
    await expect(call(f.owner, "task.get", { id: created.task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await call(f.owner, "task.update", payload, requestId)).toEqual(result);
    await expect(call(f.owner, "task.update", { ...payload, draft: { ...changed, title: "Different" } }, requestId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const recipient = await call(inherited ? f.viewer : f.creator, "task.get", { id: created.task.id });
    expect(recipient.task.ownerUserId).toBe(inherited ? f.viewer.user.id : f.creator.user.id);
    expect(recipient.task.capabilities.canEdit).toBe(true);
  });
  it("keeps the first page's date when a continuation crosses Shanghai midnight", async () => {
    const f = await setup(); f.creator.now = "2026-09-11T15:59:00.000Z";
    const first = draft(f.family.id); first.schedule.time = "08:00";
    const second = draft(f.family.id); second.schedule.time = "09:00";
    await call(f.creator, "task.create", { draft: first });
    const last = await call(f.creator, "task.create", { draft: second });
    const page = await call(f.creator, "task.list", { limit: 1 });
    if (!page.nextCursor) throw new Error("Missing continuation");
    f.creator.now = "2026-09-11T16:01:00.000Z";
    const end = await call(f.creator, "task.list", { limit: 1, cursor: page.nextCursor });
    expect(end.items.map(item => item.task.id)).toEqual([last.task.id]);
    expect(end.summary?.denominator).toBe(2);
  });
  it("exposes failed aggregate scopes and does not claim a complete empty recycle bin", async () => {
    const f = await setup(); const store = f.creator.store();
    vi.spyOn(store, "context").mockRejectedValue(new Error("Unavailable family roster"));
    const service = new CollaborativeTaskService(store, new CloudBasePersonalStore(f.creator.database, f.creator.identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date(f.creator.now) }, { generate: randomUUID });
    const list = await service.execute("task.list", {}, randomUUID());
    expect(list).toMatchObject({ summary: null, scopes: expect.arrayContaining([{ familyId: f.family.id, status: "failed", errorCode: "TEMPORARILY_UNAVAILABLE" }]) });
    await expect(service.execute("task.recycleList", {}, randomUUID())).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE", retryable: true });
  });
  it("supports a full twenty-member reminder matrix within the transaction budget", async () => {
    const f = await setup(); const ids = [f.owner.member.id, f.viewer.member.id];
    for (let index = 3; index < 20; index++) {
      const user = await familyFixture(f.owner.database, `家人${index}`);
      const member: Membership = { ...f.viewer.member, id: randomUUID(), userId: user.user.id, name: user.user.displayName };
      await f.owner.store().transaction(async tx => {
        const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
        family.memberCount++; family.version++;
        await tx.saveMember(member); await tx.saveSlot({ familyId: family.id, userId: member.userId, activeMembershipId: member.id }); await tx.saveFamily(family);
      });
      ids.push(member.id);
    }
    const d = draft(f.family.id); d.access.viewerMembershipIds = ids; d.access.reminderMembershipIds = ids; d.access.helperMembershipIds = ids;
    const created = await call(f.creator, "task.create", { draft: d });
    expect(created.task.participants).toHaveLength(20);
    expect(created.task.participants.every(member => member.receivesReminder)).toBe(true);
  });
});

describe("recurring family permissions", () => {
  it("keeps historical real subject viewing and recording without granting future-subject recording", async () => {
    const f = await setup(); f.creator.now = "2026-09-11T22:30:00.000Z"; f.viewer.now = f.creator.now; f.owner.now = f.creator.now;
    const d: TaskDraft = { ...draft(f.family.id), subject: { kind: "member", membershipId: f.viewer.member.id }, schedule: { kind: "daily", startDate: "2026-09-12", endDate: null, times: ["08:00", "20:00"] } };
    const created = await call(f.creator, "task.create", { draft: d }); const morning = created.nextOccurrences[0]; if (!morning) throw new Error("Missing morning");
    f.creator.now = "2026-09-12T10:30:00.000Z"; f.viewer.now = f.creator.now; f.owner.now = f.creator.now;
    const updated = await call(f.creator, "task.update", { id: created.task.id, expectedVersion: 1, draft: { ...d, subject: { kind: "member", membershipId: f.owner.member.id } } });
    expect("task" in updated && updated.task.participants.find(p => p.membershipId === f.viewer.member.id)?.requiredViewer).toBe(true);
    const list = await call(f.viewer, "occurrence.list", { taskId: created.task.id, dateFrom: "2026-09-12", dateTo: "2026-09-12" });
    expect(list.items.map(o => [o.slot, o.subjectName, o.canRecord])).toEqual([["08:00", f.viewer.member.name, true], ["20:00", f.owner.member.name, false]]);
    const oldRef = { id: morning.id, taskId: morning.taskId, segmentId: morning.segmentId, localDate: morning.localDate, slot: morning.slot };
    await expect(call(f.owner, "occurrence.record", { occurrence: oldRef, expectedVersion: 0, status: "completed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const requestId = randomUUID(); const payload = { occurrence: oldRef, expectedVersion: 0, status: "completed" as const };
    const recorded = await call(f.viewer, "occurrence.record", payload, requestId); expect(recorded.occurrence.operatorName).toBe(f.viewer.member.name);
    await f.creator.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveMember({ ...f.viewer.member, status: "left", successorMembershipId: f.creator.member.id, version: 2 });
      await tx.saveSlot({ familyId: f.family.id, userId: f.viewer.user.id, activeMembershipId: null });
      await tx.saveFamily({ ...family, version: family.version + 1, memberCount: 2 });
    });
    await expect(call(f.viewer, "occurrence.record", payload, requestId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("includes paused and stopped tasks in management scans and permits creator-successor management", async () => {
    const f = await setup(); const d: TaskDraft = { ...draft(f.family.id), schedule: { kind: "daily", startDate: "2026-09-12", endDate: null, times: ["08:00"] } };
    const a = await call(f.creator, "task.create", { draft: d }); const b = await call(f.creator, "task.create", { draft: d });
    await call(f.creator, "task.pause", { id: a.task.id, expectedVersion: 1 }); await call(f.creator, "task.stop", { id: b.task.id, expectedVersion: 1 });
    expect((await f.creator.store().scanTasks(f.creator.user.id, f.family.id, { mode: "tasks" }, f.creator.now, null, 20)).items.map(t => t.lifecycle).sort()).toEqual(["paused", "stopped"]);
    await f.owner.store().transaction(async tx => {
      const family = await tx.family(f.family.id); if (!family) throw new Error("Missing family");
      await tx.saveMember({ ...f.creator.member, status: "left", successorMembershipId: f.viewer.member.id, version: 2 });
      await tx.saveSlot({ familyId: f.family.id, userId: f.creator.user.id, activeMembershipId: null });
      await tx.saveFamily({ ...family, version: family.version + 1, memberCount: 2 });
    });
    const successor = await call(f.viewer, "task.get", { id: a.task.id }); expect(successor.task.capabilities.canEdit).toBe(true);
    await call(f.viewer, "task.resume", { id: a.task.id, expectedVersion: 2 });
  });
});

it("only a paused series manager receives canResume; subject and viewer cannot resume", async () => {
  const f = await setup(); const d: TaskDraft = { ...draft(f.family.id), subject: { kind: "member", membershipId: f.viewer.member.id }, schedule: { kind: "daily", startDate: "2026-09-12", endDate: null, times: ["08:00"] }, access: { ...draft(f.family.id).access, viewerMembershipIds: [f.owner.member.id] } };
  const created = await call(f.creator, "task.create", { draft: d }); const paused = await call(f.creator, "task.pause", { id: created.task.id, expectedVersion: 1 });
  expect(paused.task.capabilities.canResume).toBe(true);
  for (const [actor, manager] of [[f.creator, true], [f.viewer, false], [f.owner, false]] as const) {
    const viewed = await call(actor, "task.get", { id: created.task.id });
    expect(viewed.task.capabilities).toMatchObject({ canResume: manager, canEdit: manager, canDelete: manager });
    if (!manager) await expect(call(actor, "task.resume", { id: created.task.id, expectedVersion: paused.task.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
});
