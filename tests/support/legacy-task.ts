import type { TaskDraft } from "@family-todo/contracts";
import type { Clock, FamilyStore, PersonalStore, UuidGenerator } from "@family-todo/ports";
import { CollaborativeTaskService } from "../../packages/application/src/collaborative-tasks";
import { PersonalService } from "../../packages/application/src/personal";
import { RecurrenceService } from "../../packages/application/src/recurrence";

/** Seed pre-family-only data to keep migration and historical receipt regression coverage. */
export async function seedLegacyTask(store: FamilyStore, personalStore: PersonalStore, clock: Clock, uuids: UuidGenerator, draft: TaskDraft, requestId: string): Promise<unknown> {
  const prior = await store.transaction(async tx => { const actor = await tx.actor(); return tx.receipt(actor.id, requestId); });
  if (prior) return new CollaborativeTaskService(store, personalStore, clock, uuids).execute("task.create", { draft }, requestId);
  return draft.schedule.kind === "once"
    ? new PersonalService(personalStore, clock, uuids).execute("task.create", { draft }, requestId)
    : new RecurrenceService(store, clock, uuids).execute("task.create", { draft }, requestId);
}
