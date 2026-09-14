import type { OccurrenceDTO, OccurrenceRef } from "@family-todo/contracts";
import { addDays, familyTaskRights, localDateAt, projectOccurrences } from "@family-todo/domain";
import type { CollaborativeTask, FamilyContext, PersistedScheduleSegment, ProjectedOccurrence, ScheduleSegment } from "@family-todo/domain";
import type { FamilyStore } from "@family-todo/ports";
import { taskInvalid, taskMissing } from "./task-context";

export function legacySegment(task: CollaborativeTask): PersistedScheduleSegment {
  return { id: task.segmentId, taskId: task.id, schedule: { kind: "once", date: task.date, time: task.time },
    subject: task.collaboration?.occurrenceSnapshot?.subject ?? task.collaboration?.subject ?? { kind: "user", userId: task.ownerUserId },
    subjectNameSnapshot: task.collaboration?.occurrenceSnapshot?.subjectName ?? task.collaboration?.subjectName ?? task.ownerName,
    effectiveFrom: task.createdAt, effectiveUntil: null, allowCreationDay: true, createdByUserId: task.ownerUserId };
}
export function projectionTask(task: CollaborativeTask) {
  return { id: task.id, createdAt: task.createdAt, lifecycle: task.lifecycle,
    activeOnceSegmentId: task.recurrence?.activeOnceSegmentId ?? (task.recurrence ? null : task.segmentId) };
}
/** Only current/future slots: at most eight days suffice for three weekly slots. */
export function nextProjected(task: CollaborativeTask, segment: ScheduleSegment, now: string, limit = 3): ProjectedOccurrence[] {
  if (task.lifecycle !== "active") return [];
  let from = localDateAt(now);
  if (segment.schedule.kind !== "once" && segment.schedule.startDate > from) from = segment.schedule.startDate;
  if (segment.schedule.kind === "once" && segment.schedule.date !== null) from = segment.schedule.date;
  // Three single-slot weekly occurrences can span fifteen days.
  const last = from > "2100-12-10" ? "2100-12-31" : addDays(from, 21);
  const enabledFrom = task.recurrence?.enabledFrom;
  const effectiveSegment = enabledFrom && enabledFrom > segment.effectiveFrom ? { ...segment, effectiveFrom: enabledFrom, allowCreationDay: false } : segment;
  const result: ProjectedOccurrence[] = [];
  for (const occurrence of projectOccurrences({ task: projectionTask(task), segments: [effectiveSegment], controls: [], dateFrom: from, dateTo: last, now })) {
    if (occurrence.recurring && occurrence.scheduledAt !== null && occurrence.scheduledAt <= now) continue;
    result.push(occurrence); if (result.length === limit) break;
  }
  return result;
}
export function occurrenceCanRecord(task: CollaborativeTask, context: FamilyContext | null, actorId: string, occurrence: ProjectedOccurrence): boolean {
  if (!occurrence.canRecord || task.lifecycle === "deleted") return false;
  if (!context) return !task.collaboration && task.ownerUserId === actorId;
  const rights = familyTaskRights(task, context, actorId);
  const subjectId = occurrence.subject.kind === "member" ? occurrence.subject.membershipId : null;
  return rights.canView && Boolean(rights.actor) && (rights.manager || rights.actor?.id === subjectId || Boolean(rights.actor && task.collaboration?.helperMembershipIds.includes(rights.actor.id)));
}
export function projectedDTO(store: FamilyStore, task: CollaborativeTask, context: FamilyContext | null, actorId: string, occurrence: ProjectedOccurrence): OccurrenceDTO {
  const legacy = !task.recurrence && occurrence.segmentId === task.segmentId;
  return { id: legacy ? task.occurrenceId : store.deriveOccurrenceId(occurrence.identity), taskId: task.id, segmentId: occurrence.segmentId,
    localDate: occurrence.localDate, slot: occurrence.slot, subject: occurrence.subject, subjectName: occurrence.subjectName,
    time: occurrence.time, scheduledAt: occurrence.scheduledAt, status: legacy ? task.status : occurrence.status,
    version: legacy ? task.occurrenceVersion : occurrence.version, actualCompletedAt: legacy ? task.actualCompletedAt : occurrence.actualCompletedAt,
    recordedAt: legacy ? task.recordedAt : occurrence.recordedAt, operatorName: legacy ? task.operatorName : occurrence.operatorName,
    canRecord: occurrenceCanRecord(task, context, actorId, occurrence) };
}
/** Query work is outside transactions; writers fence the task version before persisting. */
export async function overlayOccurrence(store: FamilyStore, task: CollaborativeTask, candidate: ProjectedOccurrence): Promise<ProjectedOccurrence | null> {
  if (candidate.recurring && candidate.eligibilityBoundary) {
    const control = await store.controlBefore(task.id, candidate.eligibilityBoundary);
    if (control && (!control.enabled || control.stopped)) return null;
  }
  if (!task.recurrence) return candidate;
  const state = await store.readOccurrenceState(store.deriveOccurrenceId(candidate.identity));
  return state ? { ...candidate, status: state.status, version: state.version, actualCompletedAt: state.actualCompletedAt, recordedAt: state.recordedAt, operatorName: state.operatorName } : candidate;
}
export async function resolveOccurrence(store: FamilyStore, task: CollaborativeTask, ref: OccurrenceRef, now: string): Promise<ProjectedOccurrence> {
  if (ref.taskId !== task.id) taskMissing();
  const segment = task.recurrence ? await store.readSegment(ref.segmentId) : legacySegment(task);
  if (!segment || segment.taskId !== task.id) taskInvalid("该次安排已失效，请刷新。");
  const date = ref.localDate ?? localDateAt(now);
  const candidates = projectOccurrences({ task: projectionTask(task), segments: [segment], controls: [], dateFrom: date, dateTo: date, now });
  for (const candidate of candidates) {
    const id = task.recurrence ? store.deriveOccurrenceId(candidate.identity) : task.occurrenceId;
    if (candidate.slot !== ref.slot || candidate.localDate !== ref.localDate || candidate.segmentId !== ref.segmentId || id !== ref.id) continue;
    const result = await overlayOccurrence(store, task, candidate); if (result) return result;
  }
  taskInvalid("该次安排已失效，请刷新。");
}
