import { isPersonalData } from "@family-todo/contracts";
import { CloudBaseFamilyStore } from "../../packages/infra-cloudbase/src/family-store";
import { CloudBaseIdentityStore } from "../../packages/infra-cloudbase/src/identity-store";
import { CloudBasePersonalStore } from "../../packages/infra-cloudbase/src/personal-store";
import { CollaborativeTaskService } from "../../packages/application/src/collaborative-tasks";
import { observeDatabase } from "../../packages/infra-cloudbase/src/api-metrics";
import { MemoryPersonalDatabase } from "./personal-database";

/** Fixed identities, clock and task order; seeding runs outside measured requests. */
export async function listBatchFixture(options: { tasks?: number; endDate?: string; times?: string[]; title?: string } = {}) {
  let sequence = 1;
  const generate = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
  const database = new MemoryPersonalDatabase(), db = observeDatabase(database);
  const identity = { provider: "wechat" as const, appId: "wx-list-batch", subject: "fixed-list-batch-actor" };
  const createdAt = "2026-09-15T00:00:00.000Z", now = "2026-09-16T12:00:00.000Z";
  const user = await new CloudBaseIdentityStore(db, identity).ensureUser({ id: generate(), displayName: "家人", version: 1, createdAt, updatedAt: createdAt });
  const familyId = generate(), memberId = generate();
  const store = (indexedCandidates = false) => new CloudBaseFamilyStore(db, identity, "test-family-cursor-and-encryption-secret", { activeKeyId: "test-key", keys: { "test-key": "test-family-encryption-key-separate-from-cursor" } }, Date.now, undefined, indexedCandidates);
  await store().transaction(async tx => {
    await tx.saveFamily({ id: familyId, name: "家", ownerMembershipId: memberId, version: 1, authEpoch: 1, taskCount: 0, memberCount: 1, virtualMemberCount: 0, createdAt, updatedAt: createdAt });
    await tx.saveMember({ id: memberId, familyId, userId: user.id, name: "家人", status: "active", successorMembershipId: null, version: 1, createdAt, updatedAt: createdAt });
    await tx.saveSlot({ familyId, userId: user.id, activeMembershipId: memberId });
    const scope = await tx.scope(user.id); await tx.saveScope({ ...scope, activeFamilyCount: 1, revision: scope.revision + 1 });
  });
  const clock = { now: () => new Date(now) };
  const taskIds: string[] = [];
  for (let index = 0; index < (options.tasks ?? 20); index++) {
    const result = await new CollaborativeTaskService(store(), new CloudBasePersonalStore(db, identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date(createdAt) }, { generate }).execute("task.create", { draft: { title: options.title ?? `事项 ${index + 1}`, note: "", familyId, subject: { kind: "self" }, schedule: { kind: "daily", startDate: "2026-09-16", endDate: options.endDate ?? "2026-09-16", times: options.times ?? ["08:00"] }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } } }, generate());
    if (!isPersonalData("task.create", result)) throw new Error("Missing task"); taskIds.push(result.task.id);
  }
  return { database, identity, store, clock, familyId, memberId, user, taskIds, generate };
}
