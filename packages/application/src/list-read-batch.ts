import { projectOccurrences } from "@family-todo/domain";
import type { TaskListSource, FamilyContext, PersistedOccurrenceState, PersistedScheduleSegment, ReminderPreference, ReminderReceipt } from "@family-todo/domain";
import type { FamilyStore } from "@family-todo/ports";
import { projectionTask } from "./recurrence-projection";

/** One invocation and trusted actor only. Null entries are deliberate cached misses. */
export class ListReadBatch {
  public readonly segments = new Map<string, PersistedScheduleSegment | null>();
  public readonly states = new Map<string, PersistedOccurrenceState | null>();
  public readonly preferences = new Map<string, ReminderPreference | null>();
  public readonly receipts = new Map<string, ReminderReceipt | null>();
  public readonly history = new Map<string, string[]>();
  public constructor(private readonly store: FamilyStore, private readonly actorId: string) {}

  public async prepare(tasks: TaskListSource[], context: FamilyContext | null, actorHistory: boolean, reminders: boolean) {
    if (tasks.length > 20 || tasks.some(task => (task.collaboration?.familyId ?? null) !== (context?.family.id ?? null))) throw new Error("Invalid list scope batch.");
    const membership = context?.members.find(member => member.userId === this.actorId && member.status === "active");
    if (context && !membership) throw new Error("Missing list membership.");
    if (membership && actorHistory) {
      const pending = tasks.filter(task => task.recurrence && !this.history.has(task.id));
      const found = pending.length ? await this.store.historicalSubjectPairs(pending.map(task => ({ taskId: task.id, membershipId: membership.id }))) : [];
      for (const task of pending) this.history.set(task.id, []);
      for (const access of found) this.history.set(access.taskId, [access.membershipId]);
    }
    if (context && reminders) {
      const ids = tasks.map(task => task.id).filter(id => !this.preferences.has(id));
      const found = ids.length ? await this.store.readPreferences(ids, this.actorId) : [];
      for (const id of ids) this.preferences.set(id, null);
      for (const preference of found) this.preferences.set(preference.taskId, preference);
    }
  }

  public async project(tasks: TaskListSource[], from: string, to: string, now: string, reminders: boolean) {
    if (tasks.length > 20) throw new Error("Invalid list projection batch.");
    const pairs = tasks.flatMap(task => task.recurrence && !this.segments.has(task.recurrence.currentSegmentId) ? [{ taskId: task.id, segmentId: task.recurrence.currentSegmentId }] : []);
    const segments = pairs.length ? await this.store.readSegments(pairs) : [];
    for (const pair of pairs) this.segments.set(pair.segmentId, null);
    for (const segment of segments) this.segments.set(segment.id, segment);
    // Only singleton current segments participate: a wide range never expands a prefetch.
    // Read at most two candidates to establish singleton status, not the whole generator.
    const ids: string[] = [];
    for (const task of tasks) {
      if (!task.recurrence) continue;
      const segment = this.segments.get(task.recurrence.currentSegmentId);
      if (!segment) continue;
      const iterator = projectOccurrences({ task: projectionTask(task), segments: [segment], controls: [], dateFrom: from, dateTo: to, now });
      const first = iterator.next();
      if (first.done || !iterator.next().done) continue;
      ids.push(this.store.deriveOccurrenceId(first.value.identity));
    }
    const pending = ids.filter(id => !this.states.has(id));
    const states = pending.length ? await this.store.readOccurrenceStates(pending) : [];
    for (const id of pending) this.states.set(id, null);
    for (const state of states) this.states.set(state.id, state);
    if (reminders) await this.loadReceipts(ids);
  }
  public async loadReceipts(ids: string[]) {
    const pending = [...new Set(ids)].filter(id => !this.receipts.has(id));
    if (!pending.length) return;
    const found = await this.store.readReminderReceipts(pending, this.actorId);
    for (const id of pending) this.receipts.set(id, null);
    for (const receipt of found) this.receipts.set(receipt.occurrenceId, receipt);
  }
}
