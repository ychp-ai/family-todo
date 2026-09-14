import type { Schedule, ScheduleControl, ScheduleOccurrenceState, ScheduleSegment } from "./scheduling";

/** Optional extension: untouched schema-1 once tasks retain their original refs. */
export type TaskRecurrence = {
  schedule: Schedule;
  currentSegmentId: string;
  activeOnceSegmentId: string | null;
  stopped: boolean;
  priorLifecycle: "active" | "paused" | "stopped" | null;
  /** Earliest due slot in the current enabled span; null means none. */
  enabledFrom: string;
  firstEligibleAt: string | null;
  hasHistory: boolean;
  currentSubjectHasHistory: boolean;
};
export type PersistedScheduleSegment = ScheduleSegment & { createdByUserId: string };
/** Resulting state is materialized so a boundary lookup never replays all controls. */
export type PersistedScheduleControl = ScheduleControl & { id: string; enabled: boolean; stopped: boolean };
export type PersistedOccurrenceState = ScheduleOccurrenceState & {
  id: string; taskId: string; segmentId: string; localDate: string | null; slot: string;
  operatorUserId: string;
};
export type HistoricalSubjectAccess = { taskId: string; membershipId: string };
