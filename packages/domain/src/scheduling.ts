/** Calendar math is restricted to 2000–2100, where Shanghai is UTC+08:00. */
export type OnceSchedule = { kind: "once"; date: string | null; time: string | null };
export type DailySchedule = { kind: "daily"; startDate: string; endDate: string | null; times: string[] };
export type WeeklySchedule = { kind: "weekly"; startDate: string; endDate: string | null; times: string[]; weekdays: number[] };
export type Schedule = OnceSchedule | DailySchedule | WeeklySchedule;
export type ScheduleSubject = { kind: "user"; userId: string } | { kind: "member"; membershipId: string } | { kind: "virtual"; virtualMemberId: string };
export type TaskLifecycle = "active" | "paused" | "stopped" | "deleted";
export type ScheduleSegment = {
  id: string; taskId: string; schedule: Schedule; subject: ScheduleSubject; subjectNameSnapshot: string;
  effectiveFrom: string; effectiveUntil: string | null; allowCreationDay: boolean;
};
export type ScheduleControl = {
  taskId: string; segmentId?: string; kind: "pause" | "resume" | "stop" | "delete" | "restore";
  effectiveAt: string; taskVersion: number;
};
export type ProjectionTask = { id: string; createdAt: string; lifecycle: TaskLifecycle; activeOnceSegmentId?: string | null };
export type ScheduleSlot = { localDate: string | null; slot: string; time: string | null; scheduledAt: string | null; eligibilityBoundary: string | null };
export type OccurrenceIdentity = readonly [taskId: string, segmentId: string, localDate: string | null, slot: string];
export type OccurrenceStateFields = {
  status: "pending" | "completed" | "skipped"; version: number;
  actualCompletedAt: string | null; recordedAt: string | null; operatorName: string | null;
};
export type ScheduleOccurrenceState = OccurrenceStateFields & { identityKey: string };
export type ProjectedOccurrence = ScheduleSlot & OccurrenceStateFields & {
  taskId: string; segmentId: string; identity: OccurrenceIdentity; identityKey: string;
  subject: ScheduleSubject; subjectName: string; recurring: boolean; canRecord: boolean;
};
export type ProjectionInput = {
  task: ProjectionTask; segments: readonly ScheduleSegment[]; controls: readonly ScheduleControl[];
  dateFrom: string; dateTo: string; now: string; states?: readonly ScheduleOccurrenceState[];
};
const DAY_MS = 86400000;

export function parseLocalDate(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2000-01-01" || value > "2100-12-31") throw new RangeError("Invalid local date.");
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw new RangeError("Invalid local date.");
  return { year, month, day };
}
export function addDays(value: string, days: number): string {
  const { year, month, day } = parseLocalDate(value);
  if (!Number.isSafeInteger(days)) throw new RangeError("Invalid day offset.");
  const result = new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  parseLocalDate(result);
  return result;
}
export function isoWeekday(value: string): number {
  const { year, month, day } = parseLocalDate(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}
function assertInstant(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new RangeError("Invalid instant.");
}
function validTime(value: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
export function toInstant(date: string, time = "00:00"): string {
  const { year, month, day } = parseLocalDate(date);
  if (!validTime(time)) throw new RangeError("Invalid local time.");
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute)).toISOString();
}
export function localDateAt(instant: string): string {
  assertInstant(instant);
  const result = new Date(Date.parse(instant) + 8 * 3600000).toISOString().slice(0, 10);
  parseLocalDate(result);
  return result;
}
export function validateSchedule(schedule: Schedule): void {
  if (schedule.kind === "once") {
    if (schedule.date !== null) parseLocalDate(schedule.date);
    if (schedule.time !== null && (!validTime(schedule.time) || schedule.date === null)) throw new RangeError("Invalid once time.");
    return;
  }
  parseLocalDate(schedule.startDate);
  if (schedule.endDate !== null) {
    parseLocalDate(schedule.endDate);
    if (schedule.endDate < schedule.startDate) throw new RangeError("Invalid schedule range.");
  }
  if (schedule.times.length > 6 || !schedule.times.every(validTime) || new Set(schedule.times).size !== schedule.times.length) throw new RangeError("Invalid schedule times.");
  if (schedule.kind === "weekly" && (schedule.weekdays.length < 1 || schedule.weekdays.length > 7
    || !schedule.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)
    || new Set(schedule.weekdays).size !== schedule.weekdays.length)) throw new RangeError("Invalid weekdays.");
}
function validateWindow(dateFrom: string, dateTo: string): void {
  parseLocalDate(dateFrom); parseLocalDate(dateTo);
  if (dateFrom > dateTo || Date.parse(dateTo) - Date.parse(dateFrom) >= 31 * DAY_MS) throw new RangeError("Projection requires a window of at most 31 days.");
}
function slot(date: string | null, time: string | null): ScheduleSlot {
  const scheduledAt = date !== null && time !== null ? toInstant(date, time) : null;
  return { localDate: date, slot: date === null ? "unscheduled" : time ?? "date-only", time, scheduledAt,
    eligibilityBoundary: date === null ? null : scheduledAt ?? toInstant(date) };
}
/** Finite, deterministic calendar enumeration. Unscheduled once is returned in any window. */
export function* enumerateSlots(schedule: Schedule, dateFrom: string, dateTo: string): Generator<ScheduleSlot> {
  validateSchedule(schedule); validateWindow(dateFrom, dateTo);
  if (schedule.kind === "once") {
    if (schedule.date === null || (schedule.date >= dateFrom && schedule.date <= dateTo)) yield slot(schedule.date, schedule.time);
    return;
  }
  const from = dateFrom > schedule.startDate ? dateFrom : schedule.startDate;
  const to = schedule.endDate !== null && schedule.endDate < dateTo ? schedule.endDate : dateTo;
  const times: (string | null)[] = schedule.times.length ? [...schedule.times].sort() : [null];
  for (let date = from; date <= to;) {
    if (schedule.kind === "daily" || schedule.weekdays.includes(isoWeekday(date))) for (const time of times) yield slot(date, time);
    if (date === to) break;
    date = addDays(date, 1);
  }
}
export function occurrenceIdentityKey(identity: OccurrenceIdentity): string {
  return JSON.stringify([identity[0].toLowerCase(), identity[1].toLowerCase(), identity[2], identity[3]]);
}
/** Controls are task-level, ordered by server instant then monotonic task version. */
function orderedControls(taskId: string, controls: readonly ScheduleControl[]): ScheduleControl[] {
  const result = controls.filter(control => control.taskId === taskId).sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.taskVersion - b.taskVersion);
  for (const control of result) {
    assertInstant(control.effectiveAt);
    if (!Number.isSafeInteger(control.taskVersion) || control.taskVersion < 1) throw new RangeError("Invalid control version.");
  }
  return result;
}
function enabledAt(boundary: string, controls: readonly ScheduleControl[]): boolean {
  let enabled = true;
  let stopped = false;
  for (const control of controls) {
    // At the exact instant, old due slots survive pause/stop/delete; resume
    // cannot create a slot that was unavailable immediately before this instant.
    if (control.effectiveAt >= boundary) break;
    if (control.kind === "stop") stopped = true;
    enabled = control.kind === "resume" && !stopped;
  }
  return enabled && !stopped;
}
function segmentContains(segment: ScheduleSegment, candidate: ScheduleSlot): boolean {
  const boundary = candidate.eligibilityBoundary;
  if (boundary === null) return true;
  const creationDay = candidate.time === null && segment.allowCreationDay && candidate.localDate === localDateAt(segment.effectiveFrom);
  return (boundary > segment.effectiveFrom || creationDay) && (segment.effectiveUntil === null || boundary <= segment.effectiveUntil);
}
/** Lazy merge limits memory to one lookahead per segment; callers own cursor/budget and sparse state merging. */
export function* projectOccurrences(input: ProjectionInput): Generator<ProjectedOccurrence> {
  validateWindow(input.dateFrom, input.dateTo); assertInstant(input.now); assertInstant(input.task.createdAt);
  if (input.task.lifecycle === "deleted") return;
  const controls = orderedControls(input.task.id, input.controls);
  const states = new Map<string, ScheduleOccurrenceState>();
  for (const state of input.states ?? []) {
    if (states.has(state.identityKey)) throw new RangeError("Duplicate occurrence state.");
    states.set(state.identityKey, state);
  }
  const seen = new Set<string>();
  const streams = input.segments.filter(segment => segment.taskId === input.task.id).map(segment => {
    if (seen.has(segment.id)) throw new RangeError("Duplicate schedule segment.");
    seen.add(segment.id); assertInstant(segment.effectiveFrom);
    if (segment.effectiveUntil !== null) {
      assertInstant(segment.effectiveUntil);
      if (segment.effectiveUntil < segment.effectiveFrom) throw new RangeError("Invalid segment bounds.");
    }
    const iterator = enumerateSlots(segment.schedule, input.dateFrom, input.dateTo);
    return { segment, iterator, next: iterator.next() };
  });
  for (;;) {
    let selected: (typeof streams)[number] | undefined;
    for (const stream of streams) {
      if (stream.next.done) continue;
      if (!selected || selected.next.done || compareSlots(stream.next.value, selected.next.value) < 0
        || (compareSlots(stream.next.value, selected.next.value) === 0 && stream.segment.id < selected.segment.id)) selected = stream;
    }
    if (!selected || selected.next.done) return;
    const candidate = selected.next.value;
    const segment = selected.segment;
    selected.next = selected.iterator.next();
    const recurring = segment.schedule.kind !== "once";
    if (!recurring) {
      if (input.task.activeOnceSegmentId !== segment.id) continue;
    } else {
      if (!segmentContains(segment, candidate)) continue;
      const boundary = candidate.eligibilityBoundary;
      if (boundary === null || !enabledAt(boundary, controls)) continue;
      const creationDay = candidate.time === null && segment.allowCreationDay && candidate.localDate === localDateAt(input.task.createdAt);
      if (boundary <= input.task.createdAt && !creationDay) continue;
    }
    const identity: OccurrenceIdentity = [input.task.id.toLowerCase(), segment.id.toLowerCase(), candidate.localDate, candidate.slot];
    const identityKey = occurrenceIdentityKey(identity);
    const state = states.get(identityKey);
    yield { ...candidate, taskId: input.task.id, segmentId: segment.id, identity, identityKey,
      subject: segment.subject, subjectName: segment.subjectNameSnapshot, recurring,
      status: state?.status ?? "pending", version: state?.version ?? 0,
      actualCompletedAt: state?.actualCompletedAt ?? null, recordedAt: state?.recordedAt ?? null, operatorName: state?.operatorName ?? null,
      canRecord: !recurring || (candidate.eligibilityBoundary !== null && candidate.eligibilityBoundary <= input.now) };
  }
}
function compareSlots(a: ScheduleSlot, b: ScheduleSlot): number {
  return (a.localDate ?? "").localeCompare(b.localDate ?? "") || (a.time ?? "99:99").localeCompare(b.time ?? "99:99");
}
/** Only close an open immutable segment. New date-only plans begin after today. */
export function splitSchedule(old: ScheduleSegment, next: Pick<ScheduleSegment, "id" | "schedule" | "subject" | "subjectNameSnapshot">, effectiveAt: string): { previous: ScheduleSegment; next: ScheduleSegment } {
  assertInstant(effectiveAt); validateSchedule(next.schedule);
  if (old.effectiveUntil !== null || effectiveAt < old.effectiveFrom || next.id === old.id) throw new RangeError("Invalid schedule split.");
  return { previous: { ...old, effectiveUntil: effectiveAt }, next: { ...old, ...next, effectiveFrom: effectiveAt, effectiveUntil: null, allowCreationDay: false } };
}
export type LifecycleState = { lifecycle: TaskLifecycle; stopped: boolean };
export type LifecycleTransition = { ok: true; state: LifecycleState; canResume: boolean } | { ok: false; reason: "INVALID_STATE" };
export function transitionLifecycle(state: LifecycleState, action: ScheduleControl["kind"], recurring: boolean): LifecycleTransition {
  const lifecycle = state.lifecycle;
  let next: TaskLifecycle;
  if (action === "delete" && lifecycle !== "deleted") next = "deleted";
  else if (action === "restore" && lifecycle === "deleted") next = recurring ? "paused" : "active";
  else if (action === "pause" && recurring && lifecycle === "active" && !state.stopped) next = "paused";
  else if (action === "resume" && recurring && lifecycle === "paused" && !state.stopped) next = "active";
  else if (action === "stop" && recurring && (lifecycle === "active" || lifecycle === "paused") && !state.stopped) next = "stopped";
  else return { ok: false, reason: "INVALID_STATE" };
  const stopped = state.stopped || lifecycle === "stopped" || action === "stop";
  return { ok: true, state: { lifecycle: next, stopped }, canResume: recurring && next === "paused" && !stopped };
}
/** Input must be reprojected before calling; this function never authenticates a client ref. */
export function canRecordOccurrence(occurrence: Pick<ProjectedOccurrence, "recurring" | "eligibilityBoundary">, now: string): boolean {
  assertInstant(now);
  return !occurrence.recurring || (occurrence.eligibilityBoundary !== null && occurrence.eligibilityBoundary <= now);
}
export function isValidActualCompletedAt(occurrence: Pick<ProjectedOccurrence, "recurring" | "localDate" | "eligibilityBoundary">, actualCompletedAt: string, now: string, createdAt: string): boolean {
  try {
    assertInstant(actualCompletedAt); assertInstant(now); assertInstant(createdAt);
    const earliest = occurrence.recurring && occurrence.localDate !== null ? toInstant(occurrence.localDate) : createdAt;
    return canRecordOccurrence(occurrence, now) && actualCompletedAt >= earliest && actualCompletedAt <= now;
  } catch { return false; }
}
