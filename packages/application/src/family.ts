import { FAMILY_ACTIONS, instant, isFamilyData, isFamilyPayload, isRecord } from "@family-todo/contracts";
import type { FamilyAction, FamilyActionMap, FamilyDTO, FamilySummary, InvitationSummary, MemberDTO, VirtualDTO } from "@family-todo/contracts";
import { familyTaskRights, resolvedMember } from "@family-todo/domain";
import type { Family, FamilyContext, Invitation, Membership, User, VirtualMember } from "@family-todo/domain";
import type { Clock, FamilyReceipt, FamilyStore, FamilyTransaction, UuidGenerator } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import type { ActionRouter } from "./router";

function missing(): never { throw new ApplicationError("NOT_FOUND", "家庭不存在或你已无权查看。"); }
function forbidden(): never { throw new ApplicationError("FORBIDDEN", "你没有执行此操作的权限。"); }
function invalid(message: string): never { throw new ApplicationError("INVALID_STATE", message); }
function stale(preview = false): never { throw new ApplicationError(preview ? "PREVIEW_EXPIRED" : "CURSOR_EXPIRED", "家庭已更新，请重新加载并确认。"); }
function version(actual: number, expected: number): void { if (actual !== expected) throw new ApplicationError("VERSION_CONFLICT", "家庭已更新，请刷新后重试。"); }
function capacity(): never { throw new ApplicationError("LIMIT_EXCEEDED", "已达到家庭或成员数量上限，请先整理。"); }
function unavailable(): never { throw new ApplicationError("INVITATION_UNAVAILABLE", "邀请已不可用，请联系邀请人重新发出。"); }
function validInvite(invite: Invitation | null, now: string): Invitation { if (!invite || invite.revokedAt !== null || invite.expiresAt <= now) unavailable(); return invite; }
function familyDTO(family: Family, member: Membership): FamilyDTO { return { id: family.id, name: family.name, version: family.version, myMembershipId: member.id, ownerMembershipId: family.ownerMembershipId, authEpoch: family.authEpoch }; }
function memberDTO(member: Membership, family: Family, actorId: string): MemberDTO { return { id: member.id, familyId: member.familyId, name: member.name, status: member.status, role: member.status === "active" && member.id === family.ownerMembershipId ? "owner" : "member", version: member.version, isMe: member.userId === actorId }; }
function virtualDTO(member: VirtualMember): VirtualDTO { return { id: member.id, familyId: member.familyId, name: member.name, status: member.status, version: member.version }; }
function inviteDTO(invite: Invitation): InvitationSummary { return { id: invite.id, familyId: invite.familyId, version: invite.version, createdAt: invite.createdAt, expiresAt: invite.expiresAt, revokedAt: invite.revokedAt }; }
async function access(tx: FamilyTransaction, familyId: string, actorId: string, ownerOnly = false) {
  const family = await tx.family(familyId); if (!family) missing();
  const slot = await tx.slot(familyId, actorId); if (!slot?.activeMembershipId) missing();
  const member = await tx.member(slot.activeMembershipId);
  if (!member || member.status !== "active" || member.familyId !== familyId || member.userId !== actorId) missing();
  if (ownerOnly && family.ownerMembershipId !== member.id) forbidden();
  return { family, member };
}
function owner(family: Family, member: Membership) { if (family.ownerMembershipId !== member.id) forbidden(); }
function exitTarget(context: FamilyContext, actorId: string, payload: FamilyActionMap["family.previewExit"]["payload"]) {
  const actor = context.members.find(m => m.userId === actorId && m.status === "active"); if (!actor) missing();
  const target = context.members.find(m => m.id === payload.targetMembershipId && m.status === "active"); if (!target) missing();
  if (payload.mode === "leave" ? target.id !== actor.id : actor.id !== context.family.ownerMembershipId) forbidden();
  if (target.id === context.family.ownerMembershipId) invalid("家庭拥有人请先转交拥有权，再退出家庭。");
  return target;
}
function transferTarget(context: FamilyContext, actorId: string, targetId: string) {
  const actor = context.members.find(m => m.userId === actorId && m.status === "active"); if (!actor) missing(); owner(context.family, actor);
  const target = context.members.find(m => m.id === targetId && m.status === "active"); if (!target) missing();
  if (actor.id === target.id) invalid("请选择另一名真实成员承接家庭。");
  return target;
}
const READS = new Set<FamilyAction>(["family.list", "family.get", "member.list", "virtualMember.list", "invitation.list", "invitation.preview", "family.previewExit", "family.previewTransfer"]);

export class FamilyService {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock, private readonly uuids: UuidGenerator) {}
  public async execute(action: FamilyAction, payload: unknown, requestId: string): Promise<unknown> {
    if (!isFamilyPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查家庭、成员及邀请参数。");
    let result: unknown;
    if (READS.has(action)) result = await this.read(action, payload);
    else {
      const fingerprint = this.store.fingerprint({ action, payload });
      // Receipt lookup precedes resource discovery: successful exits remain confirmable after losing access.
      const previous = await this.store.transaction(async tx => { const actor = await tx.actor(); const receipt = await tx.receipt(actor.id, requestId); return receipt ? { result: await this.replay(tx, actor, action, fingerprint, receipt) } : null; });
      result = previous ? previous.result : await this.write(action, payload, requestId, fingerprint);
    }
    if (!isFamilyData(action, result)) throw new Error("Invalid family action result.");
    return result;
  }
  private async replay(tx: FamilyTransaction, actor: User, action: FamilyAction, fingerprint: string, receipt: FamilyReceipt): Promise<unknown> {
    if (receipt.fingerprint !== fingerprint) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作。");
    if (receipt.minimumConfirmation && (action === "family.exit" || action === "family.transferOwnership")) {
      if (!isFamilyData(action, receipt.result)) throw new Error("Invalid minimum family receipt.");
      return receipt.result;
    }
    if (!receipt.familyId) missing();
    const current = await access(tx, receipt.familyId, actor.id, receipt.ownerOnly === true);
    if (action === "member.rename" && current.member.id !== receipt.taskId) owner(current.family, current.member);
    if (action === "invitation.accept" && current.member.id !== receipt.taskId) missing();
    if (action === "invitation.create") {
      validInvite(await tx.invitation(receipt.taskId), this.clock.now().toISOString());
      if (!isRecord(receipt.result) || typeof receipt.result.sealed !== "string") throw new Error("Invalid invitation receipt.");
      return this.store.unseal(receipt.result.sealed);
    }
    return receipt.result;
  }
  private async write(action: FamilyAction, payload: unknown, requestId: string, fingerprint: string): Promise<unknown> {
    const resourceId = this.uuids.generate(); const memberId = this.uuids.generate(); const eventId = this.uuids.generate();
    const invitation = action === "invitation.accept" && isFamilyPayload(action, payload) ? await this.store.findInvitation(this.store.fingerprint(payload.token)) : null;
    const confirmation = ((action === "family.exit" || action === "family.transferOwnership") && isFamilyPayload(action, payload)) ? await this.store.readSession(payload.previewToken) : null;
    return this.store.transaction(async tx => {
      const actor = await tx.actor(); const previous = await tx.receipt(actor.id, requestId);
      if (previous) return this.replay(tx, actor, action, fingerprint, previous);
      const now = this.clock.now().toISOString();
      let family: Family; let member: Membership; let result: unknown; let targetId: string | null = null;
      let receiptId = resourceId; let resourceKind: FamilyReceipt["resourceKind"] = "family"; let ownerOnly = false; let minimumConfirmation = false; let authChanged = false; let beforeVersion = 0;
      if (action === "family.create" && isFamilyPayload(action, payload)) {
        const scope = await tx.scope(actor.id); if (scope.activeFamilyCount >= 10) capacity();
        if (await tx.family(resourceId) || await tx.member(memberId) || await tx.slot(resourceId, actor.id)) throw new Error("Family identifier collision.");
        family = { id: resourceId, name: payload.name.trim(), ownerMembershipId: memberId, version: 1, authEpoch: 1, taskCount: 0, memberCount: 1, virtualMemberCount: 0, createdAt: now, updatedAt: now };
        member = { id: memberId, familyId: family.id, userId: actor.id, name: payload.myName.trim(), status: "active", successorMembershipId: null, version: 1, createdAt: now, updatedAt: now };
        await tx.saveMember(member); await tx.saveSlot({ familyId: family.id, userId: actor.id, activeMembershipId: member.id });
        scope.activeFamilyCount++; scope.revision++; await tx.saveScope(scope);
        result = { family: familyDTO(family, member) };
      } else if (action === "invitation.accept" && isFamilyPayload(action, payload)) {
        const invite = validInvite(invitation && await tx.invitation(invitation.id), now);
        const loaded = await tx.family(invite.familyId); if (!loaded) unavailable(); family = loaded; beforeVersion = family.version;
        const slot = await tx.slot(family.id, actor.id);
        if (slot?.activeMembershipId) {
          const existing = await tx.member(slot.activeMembershipId);
          if (!existing || existing.familyId !== family.id || existing.userId !== actor.id || existing.status !== "active") throw new Error("Invalid membership slot.");
          member = existing; result = { familyId: family.id, membershipId: member.id, alreadyJoined: true };
        } else {
          const scope = await tx.scope(actor.id); if (scope.activeFamilyCount >= 10 || family.memberCount >= 20) capacity();
          if (await tx.member(memberId)) throw new Error("Membership identifier collision.");
          member = { id: memberId, familyId: family.id, userId: actor.id, name: payload.myName.trim(), status: "active", successorMembershipId: null, version: 1, createdAt: now, updatedAt: now };
          await tx.saveMember(member); await tx.saveSlot({ familyId: family.id, userId: actor.id, activeMembershipId: member.id });
          scope.activeFamilyCount++; scope.revision++; await tx.saveScope(scope); family.memberCount++; authChanged = true;
          result = { familyId: family.id, membershipId: member.id, alreadyJoined: false };
        }
        receiptId = member.id; targetId = member.id; resourceKind = "member";
      } else {
        let familyId: string;
        let changedMember: Membership | null = null; let virtual: VirtualMember | null = null; let invite: Invitation | null = null;
        if ((action === "family.update") && isFamilyPayload(action, payload)) familyId = payload.id;
        else if (action === "member.rename" && isFamilyPayload(action, payload)) { changedMember = await tx.member(payload.id); if (!changedMember) missing(); familyId = changedMember.familyId; }
        else if ((action === "virtualMember.update" || action === "virtualMember.deactivate") && isFamilyPayload(action, payload)) { virtual = await tx.virtualMember(payload.id); if (!virtual) missing(); familyId = virtual.familyId; }
        else if (action === "invitation.revoke" && isFamilyPayload(action, payload)) { invite = await tx.invitation(payload.id); if (!invite) missing(); familyId = invite.familyId; }
        else if (isRecord(payload) && typeof payload.familyId === "string") familyId = payload.familyId;
        else throw new Error("Unsupported family write.");
        ({ family, member } = await access(tx, familyId, actor.id)); beforeVersion = family.version;
        if (action === "family.update" && isFamilyPayload(action, payload)) {
          owner(family, member); ownerOnly = true; version(family.version, payload.expectedVersion); family.name = payload.name.trim();
          result = { family: familyDTO({ ...family, version: family.version + 1 }, member) }; receiptId = family.id;
        } else if (action === "member.rename" && isFamilyPayload(action, payload) && changedMember) {
          if (changedMember.status !== "active") invalid("已退出成员的历史称呼不能修改。");
          if (changedMember.id !== member.id) owner(family, member); version(changedMember.version, payload.expectedVersion);
          changedMember.name = payload.name.trim(); changedMember.version++; changedMember.updatedAt = now; await tx.saveMember(changedMember);
          result = { member: memberDTO(changedMember, family, actor.id) }; receiptId = changedMember.id; targetId = changedMember.id; resourceKind = "member";
        } else if (action === "invitation.create" && isFamilyPayload(action, payload)) {
          owner(family, member); ownerOnly = true; version(family.version, payload.expectedFamilyVersion);
          if (await tx.invitation(resourceId)) throw new Error("Invitation identifier collision.");
          const token = this.store.randomToken(); const expiresAt = new Date(this.clock.now().getTime() + 7 * 86400000).toISOString();
          invite = { id: resourceId, familyId, tokenHash: this.store.fingerprint(token), createdBy: member.id, version: 1, createdAt: now, updatedAt: now, expiresAt, revokedAt: null };
          await tx.saveInvitation(invite); result = { id: invite.id, token, expiresAt, version: invite.version }; resourceKind = "invitation";
        } else if (action === "invitation.revoke" && isFamilyPayload(action, payload) && invite) {
          owner(family, member); ownerOnly = true; version(invite.version, payload.expectedVersion);
          if (invite.revokedAt !== null) invalid("邀请已撤销。");
          invite.revokedAt = now; invite.updatedAt = now; invite.version++; await tx.saveInvitation(invite);
          result = { id: invite.id, version: invite.version, revoked: true }; receiptId = invite.id; resourceKind = "invitation";
        } else if (action === "virtualMember.create" && isFamilyPayload(action, payload)) {
          owner(family, member); ownerOnly = true; version(family.version, payload.expectedFamilyVersion); if (family.virtualMemberCount >= 20) capacity();
          if (await tx.virtualMember(resourceId)) throw new Error("Virtual member identifier collision.");
          virtual = { id: resourceId, familyId, name: payload.name.trim(), status: "active", version: 1, createdAt: now, updatedAt: now };
          await tx.saveVirtualMember(virtual); family.virtualMemberCount++; authChanged = true; result = { member: virtualDTO(virtual) }; resourceKind = "virtual";
        } else if ((action === "virtualMember.update" || action === "virtualMember.deactivate") && isFamilyPayload(action, payload) && virtual) {
          owner(family, member); ownerOnly = true; version(virtual.version, payload.expectedVersion);
          if (action === "virtualMember.update" && isFamilyPayload(action, payload)) virtual.name = payload.name.trim();
          else { if (virtual.status !== "active") invalid("虚拟成员已停用。"); virtual.status = "inactive"; family.virtualMemberCount--; authChanged = true; }
          virtual.version++; virtual.updatedAt = now; await tx.saveVirtualMember(virtual); result = { member: virtualDTO(virtual) }; receiptId = virtual.id; resourceKind = "virtual";
        } else if (action === "family.exit" && isFamilyPayload(action, payload)) {
          const target = await tx.member(payload.targetMembershipId); const successor = await tx.member(family.ownerMembershipId);
          if (!target || !successor || target.familyId !== family.id || successor.familyId !== family.id || successor.status !== "active") missing();
          exitTarget({ family, members: [member, target, successor], virtualMembers: [] }, actor.id, payload);
          this.confirm(confirmation, actor.id, this.exitFingerprint(payload), family.version, payload.expectedFamilyVersion, now);
          const slot = await tx.slot(family.id, target.userId); if (slot?.activeMembershipId !== target.id) stale(true);
          const scope = await tx.scope(target.userId); if (scope.activeFamilyCount < 1) throw new Error("Invalid family count.");
          target.status = payload.mode === "leave" ? "left" : "removed"; target.successorMembershipId = successor.id; target.version++; target.updatedAt = now;
          await tx.saveMember(target); await tx.saveSlot({ familyId: family.id, userId: target.userId, activeMembershipId: null });
          scope.activeFamilyCount--; scope.revision++; await tx.saveScope(scope); family.memberCount--; authChanged = true;
          result = { familyId: family.id, exitedMembershipId: target.id, completed: true }; receiptId = target.id; targetId = target.id; resourceKind = "member"; minimumConfirmation = true;
        } else if (action === "family.transferOwnership" && isFamilyPayload(action, payload)) {
          const target = await tx.member(payload.toMembershipId); if (!target || target.familyId !== family.id) missing();
          transferTarget({ family, members: [member, target], virtualMembers: [] }, actor.id, payload.toMembershipId);
          this.confirm(confirmation, actor.id, this.transferFingerprint(payload), family.version, payload.expectedFamilyVersion, now);
          family.ownerMembershipId = target.id; authChanged = true;
          result = { id: family.id, version: family.version + 1, transferred: true }; receiptId = family.id; targetId = target.id; minimumConfirmation = true;
        } else throw new Error("Unsupported family write.");
      }
      if (beforeVersion > 0) { family.version++; if (authChanged) family.authEpoch++; family.updatedAt = now; }
      await tx.saveFamily(family);
      await tx.addFamilyEvent({ id: eventId, familyId: family.id, kind: action, actorUserId: actor.id, targetMembershipId: targetId, recordedAt: now, beforeVersion, afterVersion: family.version });
      const savedResult = action === "invitation.create" ? { sealed: this.store.seal(result) } : result;
      await tx.saveReceipt(actor.id, requestId, { fingerprint, taskId: receiptId, familyId: family.id, resourceKind, ownerOnly, minimumConfirmation, result: savedResult });
      return result;
    });
  }
  private exitFingerprint(payload: FamilyActionMap["family.previewExit"]["payload"]) { return this.store.fingerprint({ action: "family.exit", familyId: payload.familyId, targetMembershipId: payload.targetMembershipId, mode: payload.mode }); }
  private transferFingerprint(payload: FamilyActionMap["family.previewTransfer"]["payload"]) { return this.store.fingerprint({ action: "family.transferOwnership", familyId: payload.familyId, toMembershipId: payload.toMembershipId }); }
  private confirm(session: Record<string, unknown> | null, actorId: string, fingerprint: string, familyVersion: number, expectedVersion: number, now: string) {
    if (!session || session.kind !== "confirmation" || session.actorId !== actorId || session.fingerprint !== fingerprint || session.familyVersion !== familyVersion || familyVersion !== expectedVersion || !instant(session.expiresAt) || session.expiresAt <= now) stale(true);
  }
  private async read(action: FamilyAction, payload: unknown): Promise<unknown> {
    const actor = await this.store.transaction(tx => tx.actor());
    if (action === "family.previewExit" && isFamilyPayload(action, payload)) return this.preview(actor, action, payload);
    if (action === "family.previewTransfer" && isFamilyPayload(action, payload)) return this.preview(actor, action, payload);
    if (action === "invitation.preview" && isFamilyPayload(action, payload)) {
      const found = await this.store.findInvitation(this.store.fingerprint(payload.token));
      return this.store.transaction(async tx => {
        const invite = validInvite(found && await tx.invitation(found.id), this.clock.now().toISOString());
        const family = await tx.family(invite.familyId); const inviter = await tx.member(invite.createdBy);
        if (!family || !inviter || inviter.familyId !== family.id) unavailable();
        const slot = await tx.slot(family.id, actor.id);
        return { familyName: family.name, inviterName: inviter.name, expiresAt: invite.expiresAt, alreadyJoined: slot?.activeMembershipId !== undefined && slot.activeMembershipId !== null };
      });
    }
    if (action === "family.get" && isFamilyPayload(action, payload)) {
      await this.store.transaction(tx => access(tx, payload.id, actor.id));
      const context = await this.store.context(payload.id); if (!context) missing();
      const current = await this.store.transaction(tx => access(tx, payload.id, actor.id));
      if (current.family.version !== context.family.version) stale();
      return { family: familyDTO(current.family, current.member), members: context.members.filter(m => m.status === "active").map(m => memberDTO(m, current.family, actor.id)), virtualMembers: context.virtualMembers.map(virtualDTO) };
    }
    if (action === "family.list" && isFamilyPayload(action, payload)) {
      const scope = await this.store.transaction(tx => tx.scope(actor.id));
      const families = await this.store.families(actor.id); const signature = this.store.fingerprint(families.map(f => [f.id, f.version]));
      const fingerprint = this.store.fingerprint({ action, limit: payload.limit ?? 20 }); const now = this.clock.now().toISOString();
      const checkpoint = payload.cursor ? await this.store.readSession(payload.cursor) : null;
      if (payload.cursor && (!this.validCheckpoint(checkpoint, actor.id, fingerprint, now) || checkpoint.revision !== scope.revision || checkpoint.signature !== signature || typeof checkpoint.offset !== "number" || !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0)) stale();
      const offset = checkpoint && typeof checkpoint.offset === "number" ? checkpoint.offset : 0; const limit = payload.limit ?? 20;
      const items: FamilySummary[] = [];
      for (const family of families.slice(offset, offset + limit)) {
        items.push(await this.store.transaction(async tx => { const current = await access(tx, family.id, actor.id); if (family.version !== current.family.version) stale(); const ownerMember = await tx.member(family.ownerMembershipId); if (!ownerMember || ownerMember.status !== "active") throw new Error("Missing family owner."); return { id: family.id, name: family.name, version: family.version, ownerName: ownerMember.name, myMembershipId: current.member.id, myRole: current.member.id === family.ownerMembershipId ? "owner" : "member" }; }));
      }
      const end = await this.store.transaction(tx => tx.scope(actor.id));
      const endFamilies = await this.store.families(actor.id);
      if (end.revision !== scope.revision || this.store.fingerprint(endFamilies.map(f => [f.id, f.version])) !== signature) stale();
      const asOf = checkpoint && instant(checkpoint.asOf) ? checkpoint.asOf : now;
      const complete = offset + limit >= families.length;
      const nextCursor = complete ? null : await this.store.saveSession({ kind: "list", actorId: actor.id, fingerprint, revision: scope.revision, signature, offset: offset + limit, asOf, expiresAt: checkpoint?.expiresAt ?? new Date(this.clock.now().getTime() + 900000).toISOString() });
      return { items, complete, nextCursor, asOf };
    }
    if ((action === "member.list" || action === "virtualMember.list" || action === "invitation.list") && isFamilyPayload(action, payload)) {
      const current = await this.store.transaction(tx => access(tx, payload.familyId, actor.id, action === "invitation.list"));
      const status = "status" in payload ? payload.status ?? "active" : "active";
      const fingerprint = this.store.fingerprint({ action, familyId: payload.familyId, status, limit: payload.limit ?? 20 }); const now = this.clock.now().toISOString();
      const checkpoint = payload.cursor ? await this.store.readSession(payload.cursor) : null;
      if (payload.cursor && (!this.validCheckpoint(checkpoint, actor.id, fingerprint, now) || checkpoint.familyVersion !== current.family.version || (checkpoint.after !== null && typeof checkpoint.after !== "string"))) stale();
      const after = checkpoint && typeof checkpoint.after === "string" ? checkpoint.after : null; const limit = payload.limit ?? 20;
      const scanned = action === "member.list" ? await this.store.members({ familyId: payload.familyId, status }, after, limit) : action === "virtualMember.list" ? await this.store.virtualMembers({ familyId: payload.familyId, status }, after, limit) : await this.store.invitations(payload.familyId, after, limit);
      const end = await this.store.transaction(tx => access(tx, payload.familyId, actor.id, action === "invitation.list")); if (end.family.version !== current.family.version) stale();
      const items = scanned.items.map(item => "tokenHash" in item ? inviteDTO(item) : "userId" in item ? memberDTO(item, current.family, actor.id) : virtualDTO(item));
      const asOf = checkpoint && instant(checkpoint.asOf) ? checkpoint.asOf : now;
      const nextCursor = scanned.more ? await this.store.saveSession({ kind: "list", actorId: actor.id, fingerprint, familyVersion: current.family.version, after: scanned.after, asOf, expiresAt: checkpoint?.expiresAt ?? new Date(this.clock.now().getTime() + 900000).toISOString() }) : null;
      return { items, complete: !scanned.more, nextCursor, asOf };
    }
    throw new Error("Unsupported family read.");
  }
  private validCheckpoint(value: Record<string, unknown> | null, actorId: string, fingerprint: string, now: string): value is Record<string, unknown> {
    return value !== null && value.kind === "list" && value.actorId === actorId && value.fingerprint === fingerprint && instant(value.asOf) && instant(value.expiresAt) && value.expiresAt > now;
  }
  private async preview(actor: User, action: "family.previewExit" | "family.previewTransfer", payload: FamilyActionMap["family.previewExit"]["payload"] | FamilyActionMap["family.previewTransfer"]["payload"]): Promise<unknown> {
    await this.store.transaction(tx => access(tx, payload.familyId, actor.id));
    const context = await this.store.context(payload.familyId); if (!context) missing();
    const target = "targetMembershipId" in payload ? exitTarget(context, actor.id, payload) : transferTarget(context, actor.id, payload.toMembershipId);
    const fingerprint = "targetMembershipId" in payload ? this.exitFingerprint(payload) : this.transferFingerprint(payload);
    const now = this.clock.now().toISOString(); const checkpoint = payload.cursor ? await this.store.readSession(payload.cursor) : null;
    if (payload.cursor && (!checkpoint || checkpoint.kind !== "preview" || checkpoint.actorId !== actor.id || checkpoint.fingerprint !== fingerprint || checkpoint.familyVersion !== context.family.version || !instant(checkpoint.expiresAt) || checkpoint.expiresAt <= now || !instant(checkpoint.asOf) || (checkpoint.mode !== "tasks" && checkpoint.mode !== "recycle") || (checkpoint.after !== null && typeof checkpoint.after !== "string"))) stale(true);
    const counts = { ownedTaskCount: 0, privateTaskCount: 0, createdManagementCount: 0, virtualTaskCount: 0 };
    if (checkpoint) for (const key of ["ownedTaskCount", "privateTaskCount", "createdManagementCount", "virtualTaskCount"] as const) {
      const value = checkpoint[key]; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) stale(true); counts[key] = value;
    }
    let mode: "tasks" | "recycle" = checkpoint?.mode === "recycle" ? "recycle" : "tasks";
    let after = checkpoint && typeof checkpoint.after === "string" ? checkpoint.after : null;
    const asOf = checkpoint && instant(checkpoint.asOf) ? checkpoint.asOf : now;
    let remaining = 200; let complete = false;
    // Reserve one candidate for the adapter lookahead, including when crossing active/recycle streams.
    while (remaining > 1 && this.store.remainingBudgetMs() > 4000) {
      const page = await this.store.scanTasks(actor.id, payload.familyId, { mode }, asOf, after, Math.min(20, remaining - 1));
      remaining -= page.items.length + 1;
      // Historical ownership and creator chains are loaded outside transactions without a depth truncation.
      const ids = new Set<string>();
      for (const task of page.items) { const binding = task.collaboration; if (!binding) throw new Error("Missing task collaboration."); ids.add(binding.creatorMembershipId); if (binding.ownerBinding.kind === "membership") ids.add(binding.ownerBinding.membershipId); }
      const resolved = await this.store.context(payload.familyId, [...ids]); if (!resolved || resolved.family.version !== context.family.version) stale(true);
      for (const task of page.items) {
        const binding = task.collaboration; if (!binding) throw new Error("Missing task collaboration.");
        if (action === "family.previewTransfer") { if (binding.ownerBinding.kind === "familyOwner") counts.virtualTaskCount++; continue; }
        const rights = familyTaskRights(task, resolved, target.userId);
        if (rights.owner.id === target.id) counts.ownedTaskCount++;
        if (rights.creator.id === target.id) counts.createdManagementCount++;
        if (binding.subject.kind === "virtual" && rights.creator.id === target.id) counts.virtualTaskCount++;
        if (rights.manager && resolved.members.filter(m => m.status === "active" && familyTaskRights(task, resolved, m.userId).canView).length === 1) counts.privateTaskCount++;
      }
      after = page.after;
      if (page.more) continue;
      if (mode === "recycle") { complete = true; break; }
      mode = "recycle"; after = null;
    }
    const end = await this.store.transaction(tx => access(tx, payload.familyId, actor.id)); if (end.family.version !== context.family.version) stale(true);
    if (!complete) {
      const nextCursor = await this.store.saveSession({ kind: "preview", actorId: actor.id, fingerprint, familyVersion: context.family.version, mode, after, asOf, ...counts, expiresAt: checkpoint?.expiresAt ?? new Date(this.clock.now().getTime() + 900000).toISOString() });
      return { preview: null, complete: false, nextCursor };
    }
    const expiresAt = new Date(this.clock.now().getTime() + 300000).toISOString();
    const previewToken = await this.store.saveSession({ kind: "confirmation", actorId: actor.id, fingerprint, familyVersion: context.family.version, expiresAt });
    if (action === "family.previewTransfer") return { preview: { previewToken, expiresAt, familyVersion: context.family.version, toName: target.name, virtualTaskCount: counts.virtualTaskCount }, complete: true, nextCursor: null };
    return { preview: { previewToken, expiresAt, familyVersion: context.family.version, targetName: target.name, successorName: resolvedMember(context, context.family.ownerMembershipId).name, ...counts, otherScopesUnaffected: true }, complete: true, nextCursor: null };
  }
}

export function registerFamilyHandlers(router: ActionRouter, resolveStore: () => Promise<FamilyStore>, clock: Clock, uuids: UuidGenerator): void {
  for (const action of FAMILY_ACTIONS) router.register({ action, async handle(payload, context) {
    if (!isFamilyPayload(action, payload)) throw new ApplicationError("VALIDATION_ERROR", "请检查家庭、成员及邀请参数。");
    return new FamilyService(await resolveStore(), clock, uuids).execute(action, payload, context.requestId);
  } });
}
