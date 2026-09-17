import { afterEach, describe, expect, it, vi } from "vitest";
import { occurrenceIdentityKey } from "@family-todo/domain";
import type {
  CollaborativeTask, Family, FamilyEvent, Invitation, Membership, PersistedOccurrenceState,
  PersistedScheduleControl, PersistedScheduleSegment, PersonalEvent, VirtualMember
} from "@family-todo/domain";
import { familyFixture } from "./support/family-fixture";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function fixture() {
  const f = await familyFixture();
  const store = f.store();
  const family: Family = { id: uuid(1), name: "我们的家", ownerMembershipId: uuid(2), version: 1, authEpoch: 1, taskCount: 1, memberCount: 1, virtualMemberCount: 1, createdAt: f.now, updatedAt: f.now };
  const member: Membership = { id: family.ownerMembershipId, familyId: family.id, userId: f.user.id, name: "家人", status: "active", successorMembershipId: null, version: 1, createdAt: f.now, updatedAt: f.now };
  const virtual: VirtualMember = { id: uuid(3), familyId: family.id, name: "宝宝", status: "active", version: 1, createdAt: f.now, updatedAt: f.now };
  const invitation: Invitation = { id: uuid(4), familyId: family.id, tokenHash: "a".repeat(64), createdBy: member.id, version: 1, createdAt: f.now, updatedAt: f.now, expiresAt: "2026-09-12T12:00:00.000Z", revokedAt: null };
  const segment: PersistedScheduleSegment = { id: uuid(6), taskId: uuid(5), schedule: { kind: "once", date: "2026-09-16", time: "08:00" }, subject: { kind: "member", membershipId: member.id }, subjectNameSnapshot: member.name, effectiveFrom: f.now, effectiveUntil: null, allowCreationDay: true, createdByUserId: f.user.id };
  const occurrenceId = store.deriveOccurrenceId([segment.taskId, segment.id, "2026-09-16", "08:00"]);
  const task: CollaborativeTask = {
    id: segment.taskId, ownerUserId: f.user.id, ownerName: member.name, title: "按时服药", note: "饭后",
    version: 1, segmentId: segment.id, occurrenceId, date: "2026-09-16", time: "08:00", lifecycle: "active", candidateKind: "single",
    status: "pending", occurrenceVersion: 0, actualCompletedAt: null, recordedAt: null, operatorName: null,
    reminderEnabled: true, reminderSelfDisabled: false, reminderVersion: 1, readAt: null, dismissedAt: null, createdAt: f.now, updatedAt: f.now,
    collaboration: { familyId: family.id, creatorMembershipId: member.id, createdByUserId: f.user.id, ownerBinding: { kind: "membership", membershipId: member.id }, subject: { kind: "member", membershipId: member.id }, subjectName: member.name, viewerMembershipIds: [], helperMembershipIds: [] }
  };
  const control: PersistedScheduleControl = { id: uuid(7), taskId: task.id, segmentId: segment.id, kind: "pause", effectiveAt: "2026-09-11T13:00:00.000Z", taskVersion: 2, enabled: false, stopped: false };
  const state: PersistedOccurrenceState = { id: occurrenceId, taskId: task.id, segmentId: segment.id, localDate: "2026-09-16", slot: "08:00", identityKey: occurrenceIdentityKey([task.id, segment.id, "2026-09-16", "08:00"]), status: "completed", version: 1, actualCompletedAt: f.now, recordedAt: f.now, operatorName: member.name, operatorUserId: f.user.id };
  const event: PersonalEvent = { id: uuid(8), taskId: task.id, occurrenceId, kind: "occurrence.completed", actorUserId: f.user.id, actorName: member.name, recordedAt: f.now, actualCompletedAt: f.now, note: "完成" };
  const familyEvent: FamilyEvent = { id: uuid(9), familyId: family.id, kind: "family.created", actorUserId: f.user.id, targetMembershipId: member.id, recordedAt: f.now, beforeVersion: 0, afterVersion: 1 };
  await store.transaction(async tx => {
    await tx.saveFamily(family); await tx.saveMember(member); await tx.saveSlot({ familyId: family.id, userId: f.user.id, activeMembershipId: member.id });
    await tx.saveVirtualMember(virtual); await tx.saveInvitation(invitation); await tx.saveTask(task); await tx.saveSegment(segment);
    await tx.saveControl(control); await tx.saveOccurrenceState(state); await tx.addEvent(event); await tx.addFamilyEvent(familyEvent);
  });
  return { ...f, store, family, member, virtual, invitation, task, segment, control, state, event, familyEvent };
}

describe("F2 storage compaction", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("compatibility release writes legacy fields and reads documents from the compact release", async () => {
    const compact = await fixture();
    vi.stubEnv("FAMILY_TODO_STORAGE_WRITE_MODE", "legacy");
    await expect(compact.store.readTask(compact.task.id)).resolves.toEqual(compact.task);
    await expect(compact.store.readOccurrenceState(compact.state.id)).resolves.toEqual(compact.state);
    await expect(compact.store.families(compact.user.id)).resolves.toEqual([compact.family]);
    const legacy = await fixture();
    const collections = ["tasks", "schedule_segments", "schedule_controls", "occurrence_states", "families", "memberships", "virtual_members", "invitations", "task_events", "family_events"];
    for (const [key, row] of legacy.database.documents) {
      if (collections.includes(key.split("/")[0] ?? "")) expect(row.id).toBe(key.split("/")[1]);
    }
    expect(legacy.database.documents.get(`occurrence_states/${legacy.state.id}`)).toMatchObject({ identityKey: legacy.state.identityKey, listOrder: `${legacy.state.localDate ?? ""}/${legacy.state.id}` });
    expect(legacy.database.documents.get(`families/${legacy.family.id}`)).toHaveProperty("listOrder");
    vi.unstubAllEnvs();
    await expect(legacy.store.readTask(legacy.task.id)).resolves.toEqual(legacy.task);
    await expect(legacy.store.readOccurrenceState(legacy.state.id)).resolves.toEqual(legacy.state);
    await expect(legacy.store.families(legacy.user.id)).resolves.toEqual([legacy.family]);
  });
  it("omits only proven redundant new-write fields and round-trips through compatible readers", async () => {
    const f = await fixture();
    const rows = {
      task: f.database.documents.get(`tasks/${f.task.id}`),
      segment: f.database.documents.get(`schedule_segments/${f.segment.id}`),
      control: f.database.documents.get(`schedule_controls/${f.control.id}`),
      state: f.database.documents.get(`occurrence_states/${f.state.id}`),
      family: f.database.documents.get(`families/${f.family.id}`),
      member: f.database.documents.get(`memberships/${f.member.id}`),
      virtual: f.database.documents.get(`virtual_members/${f.virtual.id}`),
      invitation: f.database.documents.get(`invitations/${f.invitation.id}`),
      event: f.database.documents.get(`task_events/${f.event.id}`),
      familyEvent: f.database.documents.get(`family_events/${f.familyEvent.id}`)
    };
    expect(Object.values(rows).every(Boolean)).toBe(true);
    for (const row of Object.values(rows)) expect(row).not.toHaveProperty("id");
    expect(rows.state).not.toHaveProperty("identityKey"); expect(rows.state).not.toHaveProperty("listOrder"); expect(rows.family).not.toHaveProperty("listOrder");
    expect(rows.segment).toHaveProperty("listOrder"); expect(rows.control).toHaveProperty("controlOrder"); expect(rows.member).toHaveProperty("listOrder"); expect(rows.virtual).toHaveProperty("listOrder"); expect(rows.invitation).toHaveProperty("listOrder");
    expect(rows.task).toMatchObject({ candidateSchema: 1, scopeKey: `f/${f.family.id}`, candidateKind: "single" });
    expect(rows.task).toHaveProperty("candidateOrder"); expect(rows.task).toHaveProperty("scheduleOrder"); expect(rows.task).toHaveProperty("recentOrder"); expect(rows.task).toHaveProperty("createdOrder");

    await expect(f.store.readTask(f.task.id)).resolves.toEqual(f.task);
    await expect(f.store.readSegment(f.segment.id)).resolves.toEqual(f.segment);
    await expect(f.store.readOccurrenceState(f.state.id)).resolves.toEqual(f.state);
    await expect(f.store.controlBefore(f.task.id, "2026-09-11T14:00:00.000Z")).resolves.toEqual(f.control);
    await expect(f.store.readMember(f.member.id)).resolves.toEqual(f.member);
    await expect(f.store.readVirtualMember(f.virtual.id)).resolves.toEqual(f.virtual);
    await expect(f.store.readInvitation(f.invitation.id)).resolves.toEqual(f.invitation);
    await expect(f.store.families(f.user.id)).resolves.toEqual([f.family]);
    const { actorUserId: _actorUserId, ...publicEvent } = f.event;
    await expect(f.store.events(f.task.id, null, 10)).resolves.toMatchObject({ items: [publicEvent] });

    const beforeQueries = f.database.queryRows.length;
    const projected = await f.store.readListTasks([f.task.id]);
    expect(projected).toEqual([{ ...f.task, note: undefined }].map(({ note: _note, ...task }) => task));
    expect(f.database.queryRows.length - beforeQueries).toBe(1);
    const query = f.database.queryRows.at(-1);
    expect(query?.fields).toMatchObject({ _id: true, id: true, candidateOrder: true, scheduleOrder: true, recentOrder: true, createdOrder: true });

    const current = Object.values(rows).map(row => row ?? {});
    const compatible = current.map((row, index) => ({ ...row, id: [f.task.id, f.segment.id, f.control.id, f.state.id, f.family.id, f.member.id, f.virtual.id, f.invitation.id, f.event.id, f.familyEvent.id][index],
      ...(index === 3 ? { identityKey: f.state.identityKey, listOrder: `${f.state.localDate ?? ""}/${f.state.id}` } : {}),
      ...(index === 4 ? { listOrder: `${f.family.createdAt}/${f.family.id}` } : {}) }));
    const compatibleBytes = compatible.reduce((sum, row) => sum + bytes(row), 0); const compactBytes = current.reduce((sum, row) => sum + bytes(row), 0);
    expect({ compatibleBytes, compactBytes, savedBytes: compatibleBytes - compactBytes }).toEqual({ compatibleBytes: 5715, compactBytes: 5012, savedBytes: 703 });
  });

  it("accepts matching legacy redundancy but rejects present mismatches, including projections", async () => {
    const f = await fixture();
    const taskKey = `tasks/${f.task.id}`; const stateKey = `occurrence_states/${f.state.id}`; const familyKey = `families/${f.family.id}`;
    const taskRow = f.database.documents.get(taskKey); const stateRow = f.database.documents.get(stateKey); const familyRow = f.database.documents.get(familyKey);
    if (!taskRow || !stateRow || !familyRow) throw new Error("Missing storage fixture.");
    taskRow.id = f.task.id; stateRow.id = f.state.id; stateRow.identityKey = f.state.identityKey; stateRow.listOrder = `legacy/${f.state.id}`; familyRow.id = f.family.id; familyRow.listOrder = `legacy/${f.family.id}`;
    await expect(f.store.readTask(f.task.id)).resolves.toEqual(f.task);
    await expect(f.store.readOccurrenceState(f.state.id)).resolves.toEqual(f.state);
    await expect(f.store.families(f.user.id)).resolves.toEqual([f.family]);

    taskRow.id = uuid(99);
    await expect(f.store.readTask(f.task.id)).rejects.toThrow("Invalid collaboration storage record");
    await expect(f.store.readListTasks([f.task.id])).rejects.toThrow("Invalid collaboration storage record");
    taskRow.id = null;
    await expect(f.store.scanListTasks(f.user.id, f.family.id, { mode: "tasks" }, f.now, null, 10)).rejects.toThrow("Invalid collaboration storage record");
    taskRow.id = f.task.id;

    stateRow.identityKey = null;
    await expect(f.store.readOccurrenceState(f.state.id)).rejects.toThrow("Invalid schedule storage record");
    stateRow.identityKey = "wrong";
    await expect(f.store.readOccurrenceStates([f.state.id])).rejects.toThrow("Invalid schedule storage record");
  });
});
