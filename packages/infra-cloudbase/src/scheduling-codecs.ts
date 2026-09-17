import { instant, integer, isRecord, isResolvedSubject, isSchedule, isUuid, localDate, localTime, text } from "@family-todo/contracts";
import { occurrenceIdentityKey } from "@family-todo/domain";
import type { PersistedOccurrenceState, PersistedScheduleControl, PersistedScheduleSegment, TaskRecurrence } from "@family-todo/domain";
function bad(): never { throw new Error("Invalid schedule storage record."); }
function nullableInstant(v: unknown): v is string | null { return v === null || instant(v); }
export function readTaskRecurrence(v: unknown): TaskRecurrence {
  if (!isRecord(v) || !isSchedule(v.schedule) || !isUuid(v.currentSegmentId) || !(v.activeOnceSegmentId === null || isUuid(v.activeOnceSegmentId))
    || typeof v.stopped !== "boolean" || !instant(v.enabledFrom) || !nullableInstant(v.firstEligibleAt) || typeof v.hasHistory !== "boolean" || typeof v.currentSubjectHasHistory !== "boolean"
    || (v.priorLifecycle !== null && v.priorLifecycle !== "active" && v.priorLifecycle !== "paused" && v.priorLifecycle !== "stopped")) bad();
  return { schedule: v.schedule, currentSegmentId: v.currentSegmentId, activeOnceSegmentId: v.activeOnceSegmentId, stopped: v.stopped,
    enabledFrom: v.enabledFrom, firstEligibleAt: v.firstEligibleAt, hasHistory: v.hasHistory, currentSubjectHasHistory: v.currentSubjectHasHistory, priorLifecycle: v.priorLifecycle };
}
export function readScheduleSegment(v: unknown): PersistedScheduleSegment {
  if (!isRecord(v) || !isUuid(v.id) || !isUuid(v.taskId) || !isSchedule(v.schedule) || !isResolvedSubject(v.subject) || !text(v.subjectNameSnapshot, 1, 12)
    || !instant(v.effectiveFrom) || !nullableInstant(v.effectiveUntil) || (v.effectiveUntil !== null && v.effectiveUntil < v.effectiveFrom)
    || typeof v.allowCreationDay !== "boolean" || !isUuid(v.createdByUserId)) bad();
  return { id: v.id, taskId: v.taskId, schedule: v.schedule, subject: v.subject, subjectNameSnapshot: v.subjectNameSnapshot,
    effectiveFrom: v.effectiveFrom, effectiveUntil: v.effectiveUntil, allowCreationDay: v.allowCreationDay, createdByUserId: v.createdByUserId };
}
export function readScheduleControl(v: unknown): PersistedScheduleControl {
  if (!isRecord(v) || !isUuid(v.id) || !isUuid(v.taskId) || !(v.segmentId === undefined || isUuid(v.segmentId)) || !instant(v.effectiveAt) || !integer(v.taskVersion, 1)
    || (v.kind !== "pause" && v.kind !== "resume" && v.kind !== "stop" && v.kind !== "delete" && v.kind !== "restore")
    || typeof v.enabled !== "boolean" || typeof v.stopped !== "boolean" || (v.stopped && v.enabled)) bad();
  return { id: v.id, taskId: v.taskId, ...(v.segmentId ? { segmentId: v.segmentId } : {}), effectiveAt: v.effectiveAt,
    taskVersion: v.taskVersion, kind: v.kind, enabled: v.enabled, stopped: v.stopped };
}
export function readOccurrenceState(v: unknown): PersistedOccurrenceState {
  if (!isRecord(v) || !isUuid(v.id) || !isUuid(v.taskId) || !isUuid(v.segmentId) || !(v.localDate === null || localDate(v.localDate))
    || !(v.slot === "date-only" || v.slot === "unscheduled" || localTime(v.slot))
    || (v.status !== "pending" && v.status !== "completed" && v.status !== "skipped") || !integer(v.version, 1)
    || !nullableInstant(v.actualCompletedAt) || !nullableInstant(v.recordedAt) || !(v.operatorName === null || text(v.operatorName, 1, 12)) || !isUuid(v.operatorUserId)) bad();
  const identityKey = occurrenceIdentityKey([v.taskId, v.segmentId, v.localDate, v.slot]);
  if (Object.hasOwn(v, "identityKey") && v.identityKey !== identityKey) bad();
  return { id: v.id, taskId: v.taskId, segmentId: v.segmentId, localDate: v.localDate, slot: v.slot, identityKey,
    status: v.status, version: v.version, actualCompletedAt: v.actualCompletedAt, recordedAt: v.recordedAt, operatorName: v.operatorName, operatorUserId: v.operatorUserId };
}
