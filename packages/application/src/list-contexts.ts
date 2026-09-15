import type { FamilyContext } from "@family-todo/domain";
import type { FamilyStore } from "@family-todo/ports";
import { taskMissing } from "./task-context";

/** A specific scope needs only its own membership; all-scope reads have bounded fan-out. */
export async function listContexts(store: FamilyStore, actorId: string, familyId: string | null | undefined) {
  const families = familyId === null ? [] : familyId ? await store.transaction(async tx => {
    const family = await tx.family(familyId); const slot = await tx.slot(familyId, actorId);
    const member = slot?.activeMembershipId ? await tx.member(slot.activeMembershipId) : null;
    if (!family || !member || member.familyId !== familyId || member.userId !== actorId || member.status !== "active") taskMissing();
    return [family];
  }) : await store.families(actorId);
  const result: { family: typeof families[number]; context: FamilyContext | null }[] = [];
  for (let offset = 0; offset < families.length; offset += 3) {
    result.push(...await Promise.all(families.slice(offset, offset + 3).map(async family => {
      let context: FamilyContext | null = null;
      try { context = await store.context(family.id); } catch { /* Independent scope failure, checked again by the final fence. */ }
      return { family, context };
    })));
  }
  return result;
}
