import { instant, integer, isRecord, isUuid } from "@family-todo/contracts";
import type { ListCache, UnchangedList } from "@family-todo/contracts";
import { addDays, localDateAt, toInstant } from "@family-todo/domain";
import type { Clock, FamilyStore } from "@family-todo/ports";

export type ValidationFamily = { familyId: string; version: number; membershipId: string };
export type ValidationProof = { actorId: string; revision: number; families: ValidationFamily[]; asOf: string; nextInvalidationAt: string; expiresAt: string };
/** Conservative day boundary also covers implicit today/overdue windows. */
export function nextListMidnight(asOf: string): string { return toInstant(addDays(localDateAt(asOf), 1)); }
export function listFingerprint(store: FamilyStore, action: string, payload: Record<string, unknown>, representation: unknown = null): string {
  return store.fingerprint({ protocol: "list-validation/v1", candidateAlgorithm: store.candidateAlgorithm ?? "legacy", action, payload: { ...payload, limit: payload.limit ?? 20, cursor: undefined, conditional: undefined }, representation });
}
function proof(v: unknown): v is ValidationProof {
  return isRecord(v) && isUuid(v.actorId) && integer(v.revision, 1) && instant(v.asOf) && instant(v.nextInvalidationAt) && instant(v.expiresAt)
    && v.expiresAt > v.asOf && Date.parse(v.expiresAt) - Date.parse(v.asOf) <= 900000 && v.nextInvalidationAt > v.asOf
    && Array.isArray(v.families) && v.families.length <= 10 && v.families.every(f => isRecord(f) && isUuid(f.familyId) && integer(f.version, 1) && isUuid(f.membershipId))
    && new Set(v.families.map(f => f.familyId)).size === v.families.length;
}
export class ListValidation {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock) {}
  private live(p: ValidationProof): boolean { const now = this.clock.now().toISOString(); return now < p.expiresAt && now < p.nextInvalidationAt; }
  private async current(p: ValidationProof): Promise<boolean> {
    return this.store.transaction(async tx => {
      const actor = await tx.actor();
      if (actor.id !== p.actorId || (await tx.scope(actor.id)).revision !== p.revision) return false;
      for (const expected of p.families) {
        const family = await tx.family(expected.familyId); const slot = await tx.slot(expected.familyId, actor.id);
        if (!family || family.id !== expected.familyId || family.version !== expected.version || slot?.familyId !== expected.familyId || slot.userId !== actor.id || slot.activeMembershipId !== expected.membershipId) return false;
        const member = await tx.member(expected.membershipId);
        if (!member || member.id !== expected.membershipId || member.familyId !== family.id || member.userId !== actor.id || member.status !== "active") return false;
      }
      return true;
    });
  }
  public async reuse(token: string | undefined, fingerprint: string): Promise<UnchangedList | null> {
    if (!token) return null;
    const saved = await this.store.readSession(token);
    if (!saved || saved.kind !== "list-validation/v1" || saved.fingerprint !== fingerprint || !proof(saved) || !this.live(saved)) return null;
    if (!await this.current(saved)) return null;
    const serverTime = this.clock.now().toISOString();
    if (serverTime >= saved.expiresAt || serverTime >= saved.nextInvalidationAt) return null;
    return { unchanged: true, token, serverTime };
  }
  /** Immutable metadata only; recheck authorization at the same final fence as the scan. */
  public async issue(fingerprint: string, p: ValidationProof): Promise<ListCache | undefined> {
    if (!proof(p) || !this.live(p) || !await this.current(p) || !this.live(p)) return undefined;
    const token = await this.store.saveSession({ kind: "list-validation/v1", fingerprint, ...p });
    if (!this.live(p)) return undefined;
    return { token, nextInvalidationAt: p.nextInvalidationAt, expiresAt: p.expiresAt };
  }
}
