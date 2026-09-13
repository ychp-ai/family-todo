import { ERROR_CODES, isRecord, isUuid } from "./api";
import type { ErrorCode } from "./api";

export type OnceSchedule = { kind: "once"; date: string | null; time: string | null };
export type Subject = { kind: "self" } | { kind: "member"; membershipId: string } | { kind: "virtual"; virtualMemberId: string };
export type ResolvedSubject = { kind: "user"; userId: string } | { kind: "member"; membershipId: string } | { kind: "virtual"; virtualMemberId: string };
export type AccessInput = { viewerMembershipIds: string[]; helperMembershipIds: string[]; reminderMembershipIds: string[]; remindMe: boolean };
export type TaskDraft = {
  title: string; note: string; familyId: string | null; subject: Subject;
  schedule: OnceSchedule; access: AccessInput;
};
/** Compatibility name retained for existing once-task callers. */
export type PersonalDraft = TaskDraft;
export type ParticipantDTO = {
  membershipId: string; name: string; canView: boolean; canHelp: boolean;
  receivesReminder?: boolean; reminderSelfDisabled?: boolean; requiredViewer: boolean; isCreatorManager?: boolean;
};
export type ReminderPreferenceDTO = { enabled: boolean; selfDisabled: boolean; version: number };
export type OccurrenceRef = { id: string; taskId: string; segmentId: string; localDate: string | null; slot: string };
export type OccurrenceDTO = OccurrenceRef & {
  subject: ResolvedSubject; subjectName: string; version: number;
  time: string | null; scheduledAt: string | null; status: "pending" | "completed" | "skipped";
  actualCompletedAt: string | null; recordedAt: string | null; operatorName: string | null; canRecord: boolean;
};
export type TaskDTO = {
  id: string; version: number; title: string; note: string; familyId: string | null; familyName: string | null;
  ownerUserId: string; ownerName: string; createdByUserId: string;
  subject: ResolvedSubject; subjectName: string; schedule: OnceSchedule;
  lifecycle: "active" | "deleted"; participants: ParticipantDTO[]; myReminder: ReminderPreferenceDTO;
  capabilities: { canEdit: boolean; canRecord: boolean; canShare: boolean; canDelete: boolean; canRestore: boolean; canResume: boolean };
  createdAt: string; updatedAt: string;
};
export type TaskListItem = { task: TaskDTO; occurrence: OccurrenceDTO };
export type TaskEventDTO = { id: string; taskId: string; occurrenceId: string | null; kind: string; actorName: string; recordedAt: string; actualCompletedAt: string | null; note: string };
export type ReminderDTO = { occurrence: OccurrenceRef; title: string; familyId: string | null; familyName: string | null; subjectName: string; scheduledAt: string; readAt: string | null; dismissedAt: string | null };
export type Summary = { completed: number; pending: number; skipped: number; denominator: number };
export type Page<T> = { items: T[]; nextCursor: string | null; complete: boolean; asOf: string };
export type ScopeResult = { familyId: string | null; status: "ok" | "partial" | "failed"; errorCode?: ErrorCode };
export type AggregatePage<T> = Page<T> & { scopes: ScopeResult[]; summary: Summary | null };
export type PageInput = { limit?: number; cursor?: string };
export type TaskListInput = PageInput & { familyId?: string | null; dateFrom?: string; dateTo?: string; unscheduled?: boolean; overdue?: boolean; status?: "pending" | "completed" | "skipped" };
export type WriteRef = { id: string; expectedVersion: number };
export type PersonalActionMap = {
  "task.create": { payload: { draft: PersonalDraft }; data: { task: TaskDTO; nextOccurrences: OccurrenceDTO[] } };
  "task.get": { payload: { id: string; occurrence?: OccurrenceRef }; data: { task: TaskDTO; occurrence: OccurrenceDTO | null } };
  "task.list": { payload: TaskListInput; data: AggregatePage<TaskListItem> };
  "task.update": { payload: WriteRef & { draft: PersonalDraft }; data: { task: TaskDTO; nextOccurrences: OccurrenceDTO[] } | { id: string; version: number; updated: true; accessLost: true } };
  "task.setAccess": { payload: WriteRef & { access: AccessInput }; data: { task: TaskDTO } };
  "task.delete": { payload: WriteRef; data: { id: string; version: number; deleted: true } };
  "task.restore": { payload: WriteRef; data: { task: TaskDTO; removedParticipantCount: number } };
  "task.recycleList": { payload: PageInput & { familyId?: string | null }; data: Page<TaskDTO> };
  "task.history": { payload: PageInput & { taskId: string }; data: Page<TaskEventDTO> };
  "occurrence.record": { payload: { occurrence: OccurrenceRef; expectedVersion: number; status: "completed" | "skipped"; actualCompletedAt?: string; note?: string }; data: { occurrence: OccurrenceDTO; taskVersion: number } };
  "occurrence.undo": { payload: { occurrence: OccurrenceRef; expectedVersion: number }; data: { occurrence: OccurrenceDTO; taskVersion: number } };
  "reminder.list": { payload: PageInput & { includeDismissed?: boolean }; data: AggregatePage<ReminderDTO> };
  "reminder.setMine": { payload: { taskId: string; enabled: boolean; expectedVersion: number }; data: { preference: ReminderPreferenceDTO } };
  "reminder.markRead": { payload: { occurrence: OccurrenceRef }; data: { occurrenceId: string; read: true } };
  "reminder.dismiss": { payload: { occurrence: OccurrenceRef }; data: { occurrenceId: string; dismissed: true } };
};
export const PERSONAL_ACTIONS = ["task.create", "task.get", "task.list", "task.update", "task.setAccess", "task.delete", "task.restore", "task.recycleList", "task.history", "occurrence.record", "occurrence.undo", "reminder.list", "reminder.setMine", "reminder.markRead", "reminder.dismiss"] as const;
export type PersonalAction = keyof PersonalActionMap;

export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isRecord(value) && required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function integer(value: unknown, min = 0): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min; }
export function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
export function localDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "2000-01-01" && value <= "2100-12-31" && instant(value + "T00:00:00.000Z");
}
export function localTime(value: unknown): value is string { return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
export function nullable<T>(v: unknown, guard: (v: unknown) => v is T): v is T | null { return v === null || guard(v); }
export function string(v: unknown): v is string { return typeof v === "string"; }
export function text(v: unknown, min: number, max: number): v is string { return string(v) && [...v.trim()].length >= min && [...v.trim()].length <= max; }
export function isOnceSchedule(v: unknown): v is OnceSchedule { return exact(v, ["kind", "date", "time"]) && v.kind === "once" && nullable(v.date, localDate) && nullable(v.time, localTime) && (v.date !== null || v.time === null); }
export function isSubject(v: unknown): v is Subject {
  return (exact(v, ["kind"]) && v.kind === "self")
    || (exact(v, ["kind", "membershipId"]) && v.kind === "member" && isUuid(v.membershipId))
    || (exact(v, ["kind", "virtualMemberId"]) && v.kind === "virtual" && isUuid(v.virtualMemberId));
}
function membershipIds(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 20 && v.every(isUuid) && new Set(v.map(id => id.toLowerCase())).size === v.length;
}
export function isAccessInput(v: unknown): v is AccessInput {
  // Necessary viewers include the actor, owner and real subject. Their current
  // membership and helper/reminder subset checks require the application context.
  return exact(v, ["viewerMembershipIds", "helperMembershipIds", "reminderMembershipIds", "remindMe"])
    && membershipIds(v.viewerMembershipIds) && membershipIds(v.helperMembershipIds)
    && membershipIds(v.reminderMembershipIds) && typeof v.remindMe === "boolean";
}
export function isTaskDraft(v: unknown): v is TaskDraft {
  if (!exact(v, ["title", "note", "familyId", "subject", "schedule", "access"]) || !text(v.title, 1, 80) || !text(v.note, 0, 1000)
    || !nullable(v.familyId, isUuid) || !isSubject(v.subject) || !isOnceSchedule(v.schedule) || !isAccessInput(v.access)) return false;
  return v.familyId !== null || (v.subject.kind === "self" && v.access.viewerMembershipIds.length === 0
    && v.access.helperMembershipIds.length === 0 && v.access.reminderMembershipIds.length === 0);
}
export const isPersonalDraft = isTaskDraft;
export function isOccurrenceRef(v: unknown): v is OccurrenceRef { return exact(v, ["id", "taskId", "segmentId", "localDate", "slot"]) && isUuid(v.id) && isUuid(v.taskId) && isUuid(v.segmentId) && nullable(v.localDate, localDate) && (v.localDate === null ? v.slot === "unscheduled" : localTime(v.slot) || v.slot === "date-only"); }
export function isResolvedSubject(v: unknown): v is ResolvedSubject {
  return (exact(v, ["kind", "userId"]) && v.kind === "user" && isUuid(v.userId))
    || (exact(v, ["kind", "membershipId"]) && v.kind === "member" && isUuid(v.membershipId))
    || (exact(v, ["kind", "virtualMemberId"]) && v.kind === "virtual" && isUuid(v.virtualMemberId));
}
export function isParticipantDTO(v: unknown): v is ParticipantDTO {
  return exact(v, ["membershipId", "name", "canView", "canHelp", "requiredViewer"], ["receivesReminder", "reminderSelfDisabled", "isCreatorManager"])
    && isUuid(v.membershipId) && text(v.name, 1, 12) && typeof v.canView === "boolean" && typeof v.canHelp === "boolean"
    && (v.isCreatorManager === undefined || typeof v.isCreatorManager === "boolean") && (!v.isCreatorManager || v.requiredViewer === true)
    && typeof v.requiredViewer === "boolean" && (v.receivesReminder === undefined || typeof v.receivesReminder === "boolean")
    && (v.reminderSelfDisabled === undefined || typeof v.reminderSelfDisabled === "boolean")
    && (v.canView || (!v.canHelp && !v.requiredViewer && v.receivesReminder !== true));
}
function familyFields(v: Record<string, unknown>): boolean {
  return v.familyId === null ? v.familyName === null : isUuid(v.familyId) && text(v.familyName, 1, 24);
}
export function isPreference(v: unknown): v is ReminderPreferenceDTO { return exact(v, ["enabled", "selfDisabled", "version"]) && typeof v.enabled === "boolean" && typeof v.selfDisabled === "boolean" && integer(v.version); }
export function isOccurrenceDTO(v: unknown): v is OccurrenceDTO {
  if (!exact(v, ["id", "taskId", "segmentId", "localDate", "slot", "subject", "subjectName", "version", "time", "scheduledAt", "status", "actualCompletedAt", "recordedAt", "operatorName", "canRecord"])) return false;
  return isOccurrenceRef({id:v.id,taskId:v.taskId,segmentId:v.segmentId,localDate:v.localDate,slot:v.slot}) && isResolvedSubject(v.subject) && text(v.subjectName,1,12) && integer(v.version) && nullable(v.time, localTime) && nullable(v.scheduledAt, instant) && (v.status === "pending" || v.status === "completed" || v.status === "skipped") && nullable(v.actualCompletedAt, instant) && nullable(v.recordedAt, instant) && nullable(v.operatorName, x => text(x,1,12)) && typeof v.canRecord === "boolean";
}
export function isTaskDTO(v: unknown): v is TaskDTO {
  return exact(v, ["id", "version", "title", "note", "familyId", "familyName", "ownerUserId", "ownerName", "createdByUserId", "subject", "subjectName", "schedule", "lifecycle", "participants", "myReminder", "capabilities", "createdAt", "updatedAt"])
    && isUuid(v.id) && integer(v.version,1) && text(v.title,1,80) && text(v.note,0,1000) && familyFields(v) && isUuid(v.ownerUserId) && text(v.ownerName,1,12) && isUuid(v.createdByUserId) && isResolvedSubject(v.subject) && text(v.subjectName,1,12) && isOnceSchedule(v.schedule) && (v.lifecycle === "active" || v.lifecycle === "deleted") && Array.isArray(v.participants) && v.participants.length <= 20 && v.participants.every(isParticipantDTO)
    && new Set(v.participants.map(p => p.membershipId.toLowerCase())).size === v.participants.length
    && (v.familyId === null ? v.participants.length === 0 && v.subject.kind === "user" : v.subject.kind !== "user") && isPreference(v.myReminder) && exact(v.capabilities, ["canEdit", "canRecord", "canShare", "canDelete", "canRestore", "canResume"]) && Object.values(v.capabilities).every(b => typeof b === "boolean") && instant(v.createdAt) && instant(v.updatedAt);
}
export function pageInput(v: Record<string,unknown>): boolean { return (v.limit === undefined || (integer(v.limit,1) && v.limit <= 50)) && (v.cursor === undefined || (string(v.cursor) && v.cursor.length > 0 && v.cursor.length <= 2048)); }
export function isPersonalPayload<A extends PersonalAction>(action: A, v: unknown): v is PersonalActionMap[A]["payload"] {
  switch (action) {
    case "task.create": return exact(v,["draft"]) && isPersonalDraft(v.draft);
    case "task.update": return exact(v,["id","expectedVersion","draft"]) && isUuid(v.id) && integer(v.expectedVersion,1) && isPersonalDraft(v.draft);
    case "task.setAccess": return exact(v,["id","expectedVersion","access"]) && isUuid(v.id) && integer(v.expectedVersion,1) && isAccessInput(v.access);
    case "task.delete": case "task.restore": return exact(v,["id","expectedVersion"]) && isUuid(v.id) && integer(v.expectedVersion,1);
    case "task.get": return exact(v,["id"],["occurrence"]) && isUuid(v.id) && (v.occurrence === undefined || isOccurrenceRef(v.occurrence));
    case "task.list": {
      if (!exact(v,[],["familyId","dateFrom","dateTo","unscheduled","overdue","status","limit","cursor"]) || !pageInput(v) || !(v.familyId === undefined || v.familyId === null || isUuid(v.familyId))) return false;
      if ((v.unscheduled !== undefined && typeof v.unscheduled !== "boolean") || (v.overdue !== undefined && typeof v.overdue !== "boolean") || (v.status !== undefined && v.status !== "pending" && v.status !== "completed" && v.status !== "skipped")) return false;
      if (v.overdue === true) return v.dateFrom === undefined && v.dateTo === undefined && v.unscheduled !== true && (v.status === undefined || v.status === "pending");
      if (v.unscheduled === true) return v.dateFrom === undefined && v.dateTo === undefined;
      return (v.dateFrom === undefined && v.dateTo === undefined) || (localDate(v.dateFrom) && localDate(v.dateTo) && v.dateTo >= v.dateFrom && (Date.parse(v.dateTo)-Date.parse(v.dateFrom))/86400000 < 31);
    }
    case "task.recycleList": return exact(v,[],["familyId","limit","cursor"]) && pageInput(v) && (v.familyId === undefined || v.familyId === null || isUuid(v.familyId));
    case "task.history": return exact(v,["taskId"],["limit","cursor"]) && isUuid(v.taskId) && pageInput(v);
    case "occurrence.record": return exact(v,["occurrence","expectedVersion","status"],["actualCompletedAt","note"]) && isOccurrenceRef(v.occurrence) && integer(v.expectedVersion) && (v.status === "completed" || v.status === "skipped") && (v.actualCompletedAt === undefined || (v.status === "completed" && instant(v.actualCompletedAt))) && (v.note === undefined || text(v.note,0,1000));
    case "occurrence.undo": return exact(v,["occurrence","expectedVersion"]) && isOccurrenceRef(v.occurrence) && integer(v.expectedVersion);
    case "reminder.list": return exact(v,[],["includeDismissed","limit","cursor"]) && pageInput(v) && (v.includeDismissed === undefined || typeof v.includeDismissed === "boolean");
    case "reminder.setMine": return exact(v,["taskId","enabled","expectedVersion"]) && isUuid(v.taskId) && typeof v.enabled === "boolean" && integer(v.expectedVersion);
    case "reminder.markRead": case "reminder.dismiss": return exact(v,["occurrence"]) && isOccurrenceRef(v.occurrence);
  }
  return false;
}
export function isTaskEvent(v: unknown): v is TaskEventDTO { return exact(v,["id","taskId","occurrenceId","kind","actorName","recordedAt","actualCompletedAt","note"]) && isUuid(v.id) && isUuid(v.taskId) && nullable(v.occurrenceId,isUuid) && string(v.kind) && ["task.created","task.updated","task.deleted","task.restored","task.accessChanged","occurrence.completed","occurrence.skipped","occurrence.undone"].includes(v.kind) && text(v.actorName,1,12) && instant(v.recordedAt) && nullable(v.actualCompletedAt,instant) && text(v.note,0,1000); }
export function isReminder(v: unknown): v is ReminderDTO { return exact(v,["occurrence","title","familyId","familyName","subjectName","scheduledAt","readAt","dismissedAt"]) && isOccurrenceRef(v.occurrence) && text(v.title,1,80) && familyFields(v) && text(v.subjectName,1,12) && instant(v.scheduledAt) && nullable(v.readAt,instant) && nullable(v.dismissedAt,instant); }
export function opaque(v: unknown): v is string { return string(v) && v.length > 0 && v.length <= 2048; }
export function isScopeResult(v: unknown): v is ScopeResult {
  return exact(v, ["familyId", "status"], ["errorCode"]) && nullable(v.familyId, isUuid)
    && (v.status === "ok" || v.status === "partial" || v.status === "failed")
    && (v.errorCode === undefined || ERROR_CODES.some(code => code === v.errorCode));
}
export function page(v: unknown, item: (v: unknown) => boolean, aggregate = false): boolean {
  if (!exact(v,["items","nextCursor","complete","asOf",...(aggregate ? ["scopes","summary"] : [])]) || !Array.isArray(v.items)
    || v.items.length > 50 || !v.items.every(item) || !instant(v.asOf) || typeof v.complete !== "boolean"
    || !(v.complete ? v.nextCursor === null : opaque(v.nextCursor))) return false;
  if (!aggregate) return true;
  if (!Array.isArray(v.scopes) || v.scopes.length > 11 || !v.scopes.every(isScopeResult)
    || new Set(v.scopes.map(scope => scope.familyId?.toLowerCase() ?? null)).size !== v.scopes.length) return false;
  if (v.summary === null) return true;
  return v.complete && v.scopes.every(scope => scope.status === "ok")
    && exact(v.summary,["completed","pending","skipped","denominator"]) && Object.values(v.summary).every(n => integer(n))
    && integer(v.summary.completed) && integer(v.summary.pending) && v.summary.denominator === v.summary.completed + v.summary.pending;
}
export function isPersonalData<A extends PersonalAction>(action: A, v: unknown): v is PersonalActionMap[A]["data"] {
  switch(action) {
    case "task.update":
      if (exact(v,["id","version","updated","accessLost"]) && isUuid(v.id) && integer(v.version,1) && v.updated === true && v.accessLost === true) return true;
      return isPersonalData("task.create", v);
    case "task.create": return exact(v,["task","nextOccurrences"]) && isTaskDTO(v.task) && Array.isArray(v.nextOccurrences) && v.nextOccurrences.length <= 3 && v.nextOccurrences.every(isOccurrenceDTO);
    case "task.get": return exact(v,["task","occurrence"]) && isTaskDTO(v.task) && nullable(v.occurrence,isOccurrenceDTO);
    case "task.setAccess": return exact(v,["task"]) && isTaskDTO(v.task);
    case "task.delete": return exact(v,["id","version","deleted"]) && isUuid(v.id) && integer(v.version,1) && v.deleted === true;
    case "task.restore": return exact(v,["task","removedParticipantCount"]) && isTaskDTO(v.task) && integer(v.removedParticipantCount);
    case "task.list": return page(v, x => exact(x,["task","occurrence"]) && isTaskDTO(x.task) && isOccurrenceDTO(x.occurrence),true);
    case "task.recycleList": return page(v,isTaskDTO);
    case "task.history": return page(v,isTaskEvent);
    case "occurrence.record": case "occurrence.undo": return exact(v,["occurrence","taskVersion"]) && isOccurrenceDTO(v.occurrence) && integer(v.taskVersion,1);
    case "reminder.list": return page(v,isReminder,true);
    case "reminder.setMine": return exact(v,["preference"]) && isPreference(v.preference);
    case "reminder.markRead": return exact(v,["occurrenceId","read"]) && isUuid(v.occurrenceId) && v.read === true;
    case "reminder.dismiss": return exact(v,["occurrenceId","dismissed"]) && isUuid(v.occurrenceId) && v.dismissed === true;
  }
  return false;
}
