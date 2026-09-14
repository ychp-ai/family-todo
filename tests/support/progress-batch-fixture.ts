import { randomUUID } from "node:crypto";
import { isPersonalData } from "@family-todo/contracts";
import type { PersonalAction, PersonalActionMap, TaskDraft } from "@family-todo/contracts";
import type { Family, Membership } from "@family-todo/domain";
import type { FamilyStore } from "@family-todo/ports";
import { CollaborativeTaskService } from "../../packages/application/src/collaborative-tasks";
import type { IdentityTransaction } from "../../packages/infra-cloudbase/src/identity-store";
import { CloudBasePersonalStore } from "../../packages/infra-cloudbase/src/personal-store";
import { familyFixture } from "./family-fixture";
import { MemoryPersonalDatabase } from "./personal-database";

/** Faults and physical I/O counts exercise the real adapters, while commits remain an in-memory simulation. */
export class ProgressBatchDatabase extends MemoryPersonalDatabase {
  public operations: number[] = [];
  public beforeSet: ((name: string, data: Record<string, unknown>) => void) | undefined;
  public afterCommit: ((writes: { name: string; data: Record<string, unknown> }[]) => void) | undefined;
  public override async runTransaction<T>(work: (tx: IdentityTransaction) => Promise<T>, retries: number): Promise<T> {
    const writes: { name: string; data: Record<string, unknown> }[] = [];
    const result = await super.runTransaction(async tx => {
      let operations = 0;
      try { return await work({ collection: name => ({ doc: id => {
        const doc = tx.collection(name).doc(id);
        return { get: async () => { operations++; return doc.get(); }, set: async options => {
          operations++; this.beforeSet?.(name, options.data); writes.push({ name, data: options.data }); return doc.set(options);
        } };
      } }) }); } finally { this.operations.push(operations); }
    }, retries);
    this.afterCommit?.(writes); return result;
  }
}
export type BatchActor = Awaited<ReturnType<typeof familyFixture>> & { member: Membership };
export async function progressBatchFixture(memberCount = 3) {
  const database = new ProgressBatchDatabase(); const familyId = randomUUID(); const actors: BatchActor[] = [];
  for (let index = 0; index < memberCount; index++) {
    const f = await familyFixture(database, index === 0 ? "拥有者" : `家人${index}`);
    actors.push({ ...f, member: { id: randomUUID(), familyId, userId: f.user.id, name: f.user.displayName, status: "active", successorMembershipId: null, version: 1, createdAt: f.now, updatedAt: f.now } });
  }
  const owner = actors[0], creator = actors[1], viewer = actors[2]; if (!owner || !creator || !viewer) throw new Error("Fixture requires three actors.");
  const family: Family = { id: familyId, name: "协作家庭", ownerMembershipId: owner.member.id, version: 1, authEpoch: 1, taskCount: 0, memberCount, virtualMemberCount: 0, createdAt: owner.now, updatedAt: owner.now };
  await owner.store().transaction(tx => tx.saveFamily(family));
  for (const actor of actors) await owner.store().transaction(async tx => {
    await tx.saveMember(actor.member); await tx.saveSlot({ familyId, userId: actor.user.id, activeMembershipId: actor.member.id });
    const scope = await tx.scope(actor.user.id); scope.activeFamilyCount++; scope.revision++; await tx.saveScope(scope);
  });
  return { database, family, actors, owner, creator, viewer };
}
export async function call<K extends PersonalAction>(actor: BatchActor, action: K, payload: PersonalActionMap[K]["payload"], requestId = randomUUID(), store: FamilyStore = actor.store()) {
  const service = new CollaborativeTaskService(store, new CloudBasePersonalStore(actor.database, actor.identity, "test-family-cursor-and-encryption-secret"), { now: () => new Date(actor.now) }, { generate: randomUUID });
  const result = await service.execute(action, payload, requestId);
  if (!isPersonalData(action, result)) throw new Error("Invalid result"); return result;
}
export function taskDraft(familyId: string | null): TaskDraft {
  return { title: "安排", note: "保留备注", familyId, subject: { kind: "self" }, schedule: { kind: "once", date: "2026-09-11", time: "20:00" }, access: { viewerMembershipIds: [], helperMembershipIds: [], reminderMembershipIds: [], remindMe: true } };
}
export async function leave(actor: BatchActor, successor: BatchActor) {
  await actor.store().transaction(async tx => {
    const family = await tx.family(actor.member.familyId); if (!family) throw new Error("Missing family.");
    await tx.saveMember({ ...actor.member, status: "left", successorMembershipId: successor.member.id, version: 2 });
    await tx.saveSlot({ familyId: family.id, userId: actor.user.id, activeMembershipId: null });
    await tx.saveFamily({ ...family, version: family.version + 1, authEpoch: family.authEpoch + 1, memberCount: family.memberCount - 1 });
    const scope = await tx.scope(actor.user.id); scope.revision++; scope.activeFamilyCount--; await tx.saveScope(scope);
  });
}
