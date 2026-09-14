import type { TaskRecurrence } from "./recurrence-persistence";
export type PersonalTask = {
  id: string; ownerUserId: string; ownerName: string; title: string; note: string;
  version: number; segmentId: string; occurrenceId: string;
  date: string | null; time: string | null; lifecycle: "active" | "paused" | "stopped" | "deleted";
  recurrence?: TaskRecurrence;
  status: "pending" | "completed" | "skipped"; occurrenceVersion: number;
  actualCompletedAt: string | null; recordedAt: string | null; operatorName: string | null;
  reminderEnabled: boolean; reminderSelfDisabled: boolean; reminderVersion: number;
  readAt: string | null; dismissedAt: string | null; createdAt: string; updatedAt: string;
};
export type PersonalEvent = { id: string; taskId: string; occurrenceId: string | null; kind: string; actorUserId?: string; actorName: string; recordedAt: string; actualCompletedAt: string | null; note: string };
export type PersonalScope = { userId: string; revision: number; personalTaskCount: number; activeFamilyCount: number };
export function shanghaiDate(now: Date): string { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
export function scheduledInstant(task: Pick<PersonalTask, "date" | "time">): string | null {
  return task.date !== null && task.time !== null ? new Date(`${task.date}T${task.time}:00+08:00`).toISOString() : null;
}
export function occurrenceSlot(task: Pick<PersonalTask, "date" | "time">): string { return task.date === null ? "unscheduled" : task.time ?? "date-only"; }
export function reminderDue(task: PersonalTask, asOf: string): boolean {
  const scheduled = scheduledInstant(task);
  return task.lifecycle === "active" && task.status === "pending" && task.reminderEnabled && scheduled !== null && scheduled <= asOf;
}
