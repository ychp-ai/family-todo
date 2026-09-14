import { describe, expect, it } from "vitest";
import { API_ACTIONS, isApiRequestEnvelope } from "./api";
import { PERSONAL_ACTIONS, isPersonalData, isPersonalDraft, isPersonalPayload, isTaskDraft, isSchedule } from "./personal";
import type { PersonalAction, PersonalActionMap, PersonalDraft, TaskDraft, TaskDTO, OccurrenceDTO } from "./personal";

const id = "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0";
const otherId = "bc9b6a08-4357-4a19-98bb-f1bffef9c4d0";
const now = "2026-09-11T10:00:00.000Z";
const access = { viewerMembershipIds: [id], helperMembershipIds: [id], reminderMembershipIds: [id], remindMe: true };
const draft: TaskDraft = { title: "陪小宝写作业", note: "", familyId: id, subject: { kind: "virtual", virtualMemberId: id }, schedule: { kind: "once", date: "2026-09-11", time: "18:00" }, access };
const personalDraft: PersonalDraft = { ...draft, familyId: null, subject: { kind: "self" }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } };
const participant = { membershipId: id, name: "妈妈", canView: true, canHelp: true, requiredViewer: true, isCreatorManager: true };
const task: TaskDTO = { id, version: 1, title: draft.title, note: "", familyId: id, familyName: "我们家", ownerUserId: id, ownerName: "妈妈", createdByUserId: id, subject: { kind: "virtual", virtualMemberId: id }, subjectName: "小宝", schedule: draft.schedule, lifecycle: "active", participants: [participant], myReminder: { enabled: true, selfDisabled: false, version: 0 }, capabilities: { canEdit: true, canRecord: true, canShare: true, canDelete: true, canRestore: false, canResume: false }, createdAt: now, updatedAt: now };
const ref = { id, taskId: id, segmentId: id, localDate: "2026-09-11", slot: "18:00" };
const occurrence: OccurrenceDTO = { ...ref, subject: task.subject, subjectName: "小宝", version: 0, time: "18:00", scheduledAt: now, status: "pending", actualCompletedAt: null, recordedAt: null, operatorName: null, canRecord: true };
const page = <T>(items: T[]) => ({ items, complete: true, nextCursor: null, asOf: now });
const aggregate = <T>(items: T[]) => ({ ...page(items), scopes: [{ familyId: null, status: "ok" }, { familyId: id, status: "ok" }], summary: null });
const reminder = { occurrence: ref, title: task.title, familyId: id, familyName: "我们家", subjectName: "小宝", scheduledAt: now, readAt: null, dismissedAt: null };
const fixtures = {
  "task.previewSchedule": { payload: { schedule: { kind: "daily", startDate: "2026-09-11", endDate: null, times: [] }, taskId: id }, data: { now, nextOccurrences: [{ localDate: "2026-09-11", time: null, scheduledAt: null }], excludedPastSlots: false, explanation: "从今天开始" } },
  "task.pause": { payload: { id, expectedVersion: 1 }, data: { task: { ...task, lifecycle: "paused" } } },
  "task.resume": { payload: { id, expectedVersion: 1 }, data: { task, nextOccurrences: [occurrence] } },
  "task.stop": { payload: { id, expectedVersion: 1 }, data: { task: { ...task, lifecycle: "stopped" } } },
  "occurrence.list": { payload: { taskId: id, dateFrom: "2026-09-01", dateTo: "2026-09-30" }, data: page([occurrence]) },
  "task.batchAddViewers": { payload: { items: [{ taskId: id, expectedVersion: 1, viewerMembershipIds: [id] }] }, data: { complete: true, results: [{ taskId: id, status: "succeeded", version: 2 }] } },
  "progress.get": { payload: { familyId: id, date: "2026-09-11" }, data: { complete: true, nextCursor: null, asOf: now, members: [{ subject: task.subject, name: "小宝", completed: 1, pending: 2, skipped: 1, denominator: 3 }] } },
  "task.create": { payload: { draft }, data: { task, nextOccurrences: [occurrence] } },
  "task.get": { payload: { id, occurrence: ref }, data: { task, occurrence } },
  "task.list": { payload: { familyId: id, dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 50 }, data: { ...aggregate([{ task, occurrence }]), scopes: [{ familyId: id, status: "ok" }] } },
  "task.update": { payload: { id, expectedVersion: 1, draft }, data: { task, nextOccurrences: [occurrence] } },
  "task.setAccess": { payload: { id, expectedVersion: 1, access }, data: { task } },
  "task.delete": { payload: { id, expectedVersion: 1 }, data: { id, version: 2, deleted: true } },
  "task.restore": { payload: { id, expectedVersion: 1 }, data: { task, removedParticipantCount: 1 } },
  "task.recycleList": { payload: { familyId: id, limit: 1 }, data: page([{ ...task, lifecycle: "deleted" }]) },
  "task.history": { payload: { taskId: id }, data: page([{ id, taskId: id, occurrenceId: null, kind: "task.accessChanged", actorName: "妈妈", recordedAt: now, actualCompletedAt: null, note: "" }]) },
  "occurrence.record": { payload: { occurrence: ref, expectedVersion: 0, status: "completed", actualCompletedAt: now }, data: { occurrence: { ...occurrence, status: "completed", version: 1, actualCompletedAt: now, recordedAt: now, operatorName: "妈妈" }, taskVersion: 2 } },
  "occurrence.undo": { payload: { occurrence: ref, expectedVersion: 1 }, data: { occurrence, taskVersion: 2 } },
  "reminder.list": { payload: { includeDismissed: true }, data: { ...aggregate([reminder]), scopes: [{ familyId: id, status: "ok" }] } },
  "reminder.setMine": { payload: { taskId: id, expectedVersion: 0, enabled: false }, data: { preference: { enabled: false, selfDisabled: true, version: 1 } } },
  "reminder.markRead": { payload: { occurrence: ref }, data: { occurrenceId: id, read: true } },
  "reminder.dismiss": { payload: { occurrence: ref }, data: { occurrenceId: id, dismissed: true } },
} satisfies { [A in PersonalAction]: PersonalActionMap[A] };

describe("家庭与个人一次性事项契约", () => {
  it.each(PERSONAL_ACTIONS)("接受 %s 并拒绝未知身份字段", action => {
    expect(API_ACTIONS).toContain(action);
    expect(isApiRequestEnvelope({ apiVersion: 1, action, requestId: id, payload: fixtures[action].payload })).toBe(true);
    expect(isPersonalPayload(action, fixtures[action].payload)).toBe(true);
    expect(isPersonalData(action, fixtures[action].data)).toBe(true);
    expect(isPersonalPayload(action, { ...fixtures[action].payload, userId: id })).toBe(false);
    expect(isPersonalData(action, { ...fixtures[action].data, _openid: "secret" })).toBe(false);
  });
  it("保留个人一次性输入和输出兼容", () => {
    expect(isTaskDraft(personalDraft)).toBe(true);
    expect(isPersonalDraft(personalDraft)).toBe(true);
    const personalTask: TaskDTO = { ...task, familyId: null, familyName: null, subject: { kind: "user", userId: id }, participants: [] };
    const personalOccurrence = { ...occurrence, subject: personalTask.subject };
    expect(isPersonalPayload("task.create", { draft: personalDraft })).toBe(true);
    expect(isPersonalData("task.create", { task: personalTask, nextOccurrences: [personalOccurrence] })).toBe(true);
    expect(isPersonalData("task.list", { ...page([{ task: personalTask, occurrence: personalOccurrence }]), scopes: [{ familyId: null, status: "ok" }], summary: { completed: 0, pending: 1, skipped: 0, denominator: 1 } })).toBe(true);
    expect(PERSONAL_ACTIONS).toHaveLength(22);
    expect(API_ACTIONS).toContain("task.setAccess");
  });
  it("家庭支持self、真实成员与虚拟人，个人禁止成员权限和跨类型组合", () => {
    for (const subject of [{ kind: "self" }, { kind: "member", membershipId: id }, { kind: "virtual", virtualMemberId: id }]) expect(isTaskDraft({ ...draft, subject })).toBe(true);
    for (const subject of [{ kind: "user", userId: id }, { kind: "member", userId: id }, { kind: "virtual", membershipId: id }, { kind: "self", membershipId: id }, { kind: "member", membershipId: "bad" }]) expect(isTaskDraft({ ...draft, subject })).toBe(false);
    expect(isTaskDraft({ ...personalDraft, subject: { kind: "member", membershipId: id } })).toBe(false);
    expect(isTaskDraft({ ...personalDraft, access })).toBe(false);
    expect(isTaskDraft({ ...draft, familyId: "bad" })).toBe(false);
    expect(isTaskDraft({ ...draft, subject: { kind: "member", membershipId: id, role: "owner" } })).toBe(false);
  });
  it("名单只含去重真实成员ID，必要可见人的提醒子集交由用例结合当前成员判断", () => {
    // The implicit owner/actor may be a necessary viewer without appearing in viewerMembershipIds.
    expect(isPersonalPayload("task.setAccess", { id, expectedVersion: 1, access: { ...access, viewerMembershipIds: [], helperMembershipIds: [otherId], reminderMembershipIds: [otherId] } })).toBe(true);
    for (const field of ["viewerMembershipIds", "helperMembershipIds", "reminderMembershipIds"]) {
      for (const ids of [["bad"], [id, id], [id, id.toUpperCase()], [{ virtualMemberId: id }], Array.from({ length: 21 }, (_, i) => `${i.toString(16).padStart(8, "0")}-4357-4a19-98bb-f1bffef9c4d0`)]) {
        expect(isTaskDraft({ ...draft, access: { ...access, [field]: ids } })).toBe(false);
      }
    }
    expect(isTaskDraft({ ...draft, access: { ...access, role: "owner" } })).toBe(false);
  });
  it("普通参与者可省略他人提醒状态，完整权限矩阵仍拒绝身份映射及错误类型", () => {
    expect(isPersonalData("task.setAccess", { task })).toBe(true);
    expect(isPersonalData("task.setAccess", { task: { ...task, participants: [{ ...participant, isCreatorManager: undefined }] } })).toBe(true); // Legacy persisted write receipts remain readable.
    expect(isPersonalData("task.setAccess", { task: { ...task, participants: [{ ...participant, receivesReminder: false, reminderSelfDisabled: true }] } })).toBe(true);
    for (const entry of [{ ...participant, isCreatorManager: "true" }, { ...participant, requiredViewer: false }, { ...participant, userId: id }, { ...participant, receivesReminder: "false" }, { ...participant, canView: false }, { ...participant, name: "😀".repeat(13) }]) expect(isPersonalData("task.setAccess", { task: { ...task, participants: [entry] } })).toBe(false);
    expect(isPersonalData("task.get", { task: { ...task, familyId: null, familyName: null }, occurrence: null })).toBe(false);
    expect(isPersonalData("task.get", { task: { ...task, subject: { kind: "user", userId: id } }, occurrence: null })).toBe(false);
    expect(isPersonalData("task.get", { task: { ...task, participants: [participant, participant] }, occurrence: null })).toBe(false);
    expect(isPersonalData("task.get", { task: { ...task, capabilities: { ...task.capabilities, role: "owner" } }, occurrence: null })).toBe(false);
  });
  it("校验日期和Unicode文本边界", () => {
    expect(isTaskDraft({ ...draft, title: "😀".repeat(80), note: "😀".repeat(1000) })).toBe(true);
    expect(isTaskDraft({ ...draft, title: "😀".repeat(81) })).toBe(false);
    for (const schedule of [{ kind: "once", date: "2026-02-30", time: null }, { kind: "once", date: "1999-12-31", time: null }, { kind: "once", date: "2101-01-01", time: null }, { kind: "once", date: null, time: "18:00" }, { kind: "once", date: "2026-09-11", time: "24:00" }]) expect(isTaskDraft({ ...draft, schedule })).toBe(false);
    expect(isPersonalData("task.get", { task: { ...task, lifecycle: "paused" }, occurrence: null })).toBe(true);
    expect(isPersonalData("task.get", { task: { ...task, lifecycle: { toString: () => "active" } }, occurrence: null })).toBe(false);
    expect(isPersonalPayload("occurrence.undo", { occurrence: { ...ref, localDate: null }, expectedVersion: 0 })).toBe(false);
    expect(isPersonalPayload("occurrence.undo", { occurrence: { ...ref, localDate: null, slot: "unscheduled" }, expectedVersion: 0 })).toBe(true);
  });
  it("聚合多家庭、失败范围及未完成扫描不发布最终统计", () => {
    const incomplete = { ...aggregate([]), complete: false, nextCursor: "signed", scopes: [{ familyId: id, status: "partial" }, { familyId: otherId, status: "failed", errorCode: "TEMPORARILY_UNAVAILABLE" }] };
    expect(isPersonalData("task.list", incomplete)).toBe(true);
    expect(isPersonalData("reminder.list", incomplete)).toBe(true);
    expect(isPersonalData("task.list", { ...incomplete, summary: { completed: 0, pending: 0, skipped: 0, denominator: 0 } })).toBe(false);
    expect(isPersonalData("task.list", { ...incomplete, scopes: [{ familyId: id, status: "failed", errorCode: "SDK_SECRET" }] })).toBe(false);
    expect(isPersonalData("task.list", { ...incomplete, scopes: [{ familyId: id, status: "failed", errorCode: "INTERNAL_ERROR", message: "secret" }] })).toBe(false);
    expect(isPersonalData("task.list", { ...aggregate([]), summary: { completed: 1, pending: 2, skipped: 1, denominator: 4 } })).toBe(false);
    expect(isPersonalData("reminder.list", { ...aggregate([reminder]), nextCursor: "a".repeat(2049), complete: false })).toBe(false);
    expect(isPersonalData("reminder.list", aggregate([{ ...reminder, familyName: null }]))).toBe(false);
  });
  it("分页日期范围、未安排和过去积压保持互斥", () => {
    expect(isPersonalPayload("task.list", { familyId: null, dateFrom: "2026-09-01", dateTo: "2026-10-01" })).toBe(true);
    for (const payload of [{ limit: 51 }, { cursor: "" }, { dateFrom: "2026-09-01" }, { dateFrom: "2026-09-01", dateTo: "2026-10-02" }, { unscheduled: true, dateFrom: "2026-09-01", dateTo: "2026-09-02" }, { overdue: true, status: "completed" }, { overdue: true, unscheduled: true }, { status: { toString: () => "pending" } }]) expect(isPersonalPayload("task.list", payload)).toBe(false);
    expect(isPersonalPayload("reminder.list", { familyId: id })).toBe(false);
  });
});


describe("周期、进度和批处理的严格契约", () => {
  const daily = { kind: "daily", startDate: "2026-09-11", endDate: null, times: ["20:00", "08:00"] };
  it("支持无时刻、每日和ISO星期；拒绝非法日期、重复及超限时刻", () => {
    for (const schedule of [daily, { ...daily, times: [] }, { ...daily, endDate: daily.startDate }, { ...daily, kind: "weekly", weekdays: [7, 1] }]) {
      expect(isSchedule(schedule)).toBe(true);
      expect(isTaskDraft({ ...draft, schedule })).toBe(true);
    }
    for (const changes of [{ startDate: "2026-02-30" }, { startDate: "2101-01-01" }, { endDate: "2026-09-10" }, { times: ["08:00", "08:00"] }, { times: ["24:00"] }, { times: Array.from({length: 7}, (_, i) => `0${i}:00`) }, { kind: "weekly", weekdays: [] }, { kind: "weekly", weekdays: [0] }, { kind: "weekly", weekdays: [1.5] }, { kind: "weekly", weekdays: [8] }, { kind: "weekly", weekdays: [1, 1] }, { weekdays: [1] }, { timeZone: "UTC" }]) expect(isSchedule({ ...daily, ...changes })).toBe(false);
  });
  it("预览拒绝伪造instant、额外字段及超过3次，并接受无后续计划", () => {
    const data = fixtures["task.previewSchedule"].data;
    expect(isPersonalData("task.previewSchedule", { ...data, nextOccurrences: [] })).toBe(true);
    expect(isPersonalData("task.previewSchedule", { ...data, nextOccurrences: Array(4).fill(data.nextOccurrences[0]) })).toBe(false);
    expect(isPersonalData("task.previewSchedule", { ...data, nextOccurrences: [{ localDate: "2026-09-11", time: "18:00", scheduledAt: "2026-09-11T18:00:00.000Z" }] })).toBe(false);
    expect(isPersonalPayload("task.previewSchedule", { schedule: daily, taskId: null })).toBe(false);
    expect(isPersonalData("task.get", { task: { ...task, lifecycle: "stopped" }, occurrence: null })).toBe(true);
  });
  it("周期窗口必须成对、最多31天；写版本从1开始", () => {
    for (const payload of [{ taskId: id, dateFrom: "2026-09-01" }, { taskId: id, dateFrom: "2026-09-01", dateTo: "2026-10-02" }, { taskId: id, dateFrom: "2026-09-01", dateTo: "2026-09-01", limit: 0 }]) expect(isPersonalPayload("occurrence.list", payload)).toBe(false);
    for (const action of ["task.pause", "task.resume", "task.stop"] as const) expect(isPersonalPayload(action, { id, expectedVersion: 0 })).toBe(false);
  });
  it("批量拒绝重复task和超限项；整体完成仅在每项终态后成立", () => {
    const item = { taskId: id, expectedVersion: 1, targetFamilyId: otherId, viewerMembershipIds: [id] };
    expect(isPersonalPayload("task.batchAddViewers", { items: [item] })).toBe(true);
    for (const items of [[], [item, { ...item, taskId: id.toUpperCase() }], [{ ...item, viewerMembershipIds: [id, id] }], [{ ...item, targetFamilyId: null }], [{ ...item, helperMembershipIds: [id] }], Array(21).fill(item)]) expect(isPersonalPayload("task.batchAddViewers", { items })).toBe(false);
    const partial = { complete: false, results: [{ taskId: id, status: "pending" }] };
    expect(isPersonalData("task.batchAddViewers", partial)).toBe(true);
    expect(isPersonalData("task.batchAddViewers", { ...partial, complete: true })).toBe(false);
    const failed = { taskId: id, status: "failed", error: { code: "NOT_FOUND", message: "事项不存在", retryable: false } };
    expect(isPersonalData("task.batchAddViewers", { complete: true, results: [failed] })).toBe(true);
    expect(isPersonalData("task.batchAddViewers", { complete: true, results: [{ ...failed, error: { ...failed.error, code: "SDK_SECRET" } }] })).toBe(false);
  });
  it("部分进度不发布计数，完整进度满足分母并使用ResolvedSubject", () => {
    const data = fixtures["progress.get"].data;
    expect(isPersonalData("progress.get", { ...data, complete: false, members: null, nextCursor: "signed" })).toBe(true);
    for (const update of [{ complete: false, nextCursor: "signed" }, { members: null }, { nextCursor: "signed" }, { members: [{ ...data.members[0], denominator: 4 }] }]) expect(isPersonalData("progress.get", { ...data, ...update })).toBe(false);
    expect(isPersonalPayload("progress.get", { familyId: id, date: "2026-09-11", subject: { kind: "user", userId: id } })).toBe(true);
  });
});
