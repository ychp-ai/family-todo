import { budgetTransaction } from "./transaction-budget";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { instant, isRecord, isTaskEvent, isUuid } from "@family-todo/contracts";
import { occurrenceIdentityKey, localDayBounds } from "@family-todo/domain";
import type { HistoricalSubjectAccess, OccurrenceIdentity, PersistedOccurrenceState, PersistedScheduleControl, PersistedScheduleSegment, CollaborativeTask, Family, FamilyContext, FamilyEvent, Invitation, Membership, MembershipSlot, ReminderPreference, ReminderReceipt, VirtualMember } from "@family-todo/domain";
import { FamilyBudgetExceededError } from "@family-todo/ports";
import type { FamilyListQuery, FamilyPage, FamilyReceipt, FamilyStore, FamilyTransaction, PersonalQuery } from "@family-todo/ports";
import { readCollaborativeTask, readFamily, readInvitation, readMembership, readPreference, readReminderReceipt, readSlot, readVirtual } from "./family-codecs";
import { readOccurrenceState, readScheduleControl, readScheduleSegment } from "./scheduling-codecs";
import { readDocument } from "./identity-store";
import type { IdentityTransaction } from "./identity-store";
import type { WechatIdentity } from "./invocation-identity";
import { CloudBasePersonalStore, taskFields, Transaction } from "./personal-store";
import type { PersonalDatabase } from "./personal-store";
import { retryTransaction } from "./transaction-retry";

function key(...parts: string[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
function bad(): never { throw new Error("Invalid collaboration storage record."); }
function reverseTime(value: string): string { return String(9999999999999 - Date.parse(value)).padStart(13, "0"); }
function ordered(value: { id: string; createdAt: string }, reverse = false): string { return `${reverse ? reverseTime(value.createdAt) : value.createdAt}/${value.id}`; }
class FamilyTransactionAdapter extends Transaction implements FamilyTransaction {
  private async read<T>(collection: string, id: string, parse: (v: unknown) => T): Promise<T | null> {
    const value = readDocument(await this.doc(collection, id).get());
    if (!value) return null;
    if (value.schemaVersion !== 1 || value._id !== id) bad();
    return parse({ ...value, id });
  }
  private async write(collection: string, id: string, value: object): Promise<void> {
    await this.doc(collection, id).set({ data: { ...value, schemaVersion: 1 } });
  }
  public segment(id: string) { return this.read("schedule_segments", id, readScheduleSegment); }
  public saveSegment(segment: PersistedScheduleSegment) { return this.write("schedule_segments", segment.id, { ...segment, listOrder: `${segment.effectiveFrom}/${segment.id}` }); }
  public saveControl(control: PersistedScheduleControl) { return this.write("schedule_controls", control.id, { ...control, controlOrder: `${control.effectiveAt}/${String(control.taskVersion).padStart(16, "0")}` }); }
  public occurrenceState(id: string) { return this.read("occurrence_states", id, readOccurrenceState); }
  public saveOccurrenceState(state: PersistedOccurrenceState) { return this.write("occurrence_states", state.id, { ...state, listOrder: `${state.localDate ?? ""}/${state.id}` }); }
  public saveHistoricalSubjectAccess(access: HistoricalSubjectAccess) { return this.write("historical_subject_access", key(access.taskId, access.membershipId), access); }
  public override task(id: string) { return this.read("tasks", id, readCollaborativeTask); }
  public override saveTask(task: CollaborativeTask) { return this.write("tasks", task.id, { ...taskFields(task), familyId: task.collaboration?.familyId ?? null }); }
  public family(id: string) { return this.read("families", id, readFamily); }
  public saveFamily(family: Family) { return this.write("families", family.id, { ...family, listOrder: ordered(family) }); }
  public member(id: string) { return this.read("memberships", id, readMembership); }
  public saveMember(member: Membership) { return this.write("memberships", member.id, { ...member, listOrder: ordered(member) }); }
  public slot(familyId: string, userId: string) { return this.read("membership_slots", key(familyId, userId), readSlot); }
  public saveSlot(slot: MembershipSlot) { return this.write("membership_slots", key(slot.familyId, slot.userId), { ...slot, active: slot.activeMembershipId !== null }); }
  public virtualMember(id: string) { return this.read("virtual_members", id, readVirtual); }
  public saveVirtualMember(member: VirtualMember) { return this.write("virtual_members", member.id, { ...member, listOrder: ordered(member) }); }
  public invitation(id: string) { return this.read("invitations", id, readInvitation); }
  public saveInvitation(invitation: Invitation) { return this.write("invitations", invitation.id, { ...invitation, listOrder: ordered(invitation, true) }); }
  public preference(taskId: string, userId: string) { return this.read("reminder_preferences", key(taskId, userId), readPreference); }
  public savePreference(preference: ReminderPreference) { return this.write("reminder_preferences", key(preference.taskId, preference.userId), preference); }
  public reminderReceipt(occurrenceId: string, userId: string) { return this.read("reminder_receipts", key(occurrenceId, userId), readReminderReceipt); }
  public saveReminderReceipt(receipt: ReminderReceipt) { return this.write("reminder_receipts", key(receipt.occurrenceId, receipt.userId), receipt); }
  public async addFamilyEvent(event: FamilyEvent) {
    if (readDocument(await this.doc("family_events", event.id).get())) throw new Error("Family event identifier collision.");
    await this.write("family_events", event.id, event);
  }
  public async batchReceipt(userId: string, requestId: string, taskId: string): Promise<FamilyReceipt | null> {
    const value = readDocument(await this.doc("idempotency_receipts", key("batch-child/v1", userId, requestId, taskId)).get());
    if (!value) return null;
    if (value.schemaVersion !== 1 || value.kind !== "batch-child/v1" || value.userId !== userId || value.requestId !== requestId || value.taskId !== taskId || typeof value.fingerprint !== "string" || !("result" in value)) bad();
    return { fingerprint: value.fingerprint, taskId, result: value.result };
  }
  public saveBatchReceipt(userId: string, requestId: string, taskId: string, receipt: FamilyReceipt) {
    return this.write("idempotency_receipts", key("batch-child/v1", userId, requestId, taskId), { ...receipt, kind: "batch-child/v1", userId, requestId, taskId });
  }
  public override async receipt(userId: string, requestId: string): Promise<FamilyReceipt | null> {
    const value = readDocument(await this.doc("idempotency_receipts", key(userId, requestId)).get());
    if (!value) return null;
    if (value.schemaVersion !== 1 || value.userId !== userId || value.requestId !== requestId || typeof value.fingerprint !== "string" || !isUuid(value.taskId) || !("result" in value)) bad();
    const result: FamilyReceipt = { fingerprint: value.fingerprint, taskId: value.taskId, result: value.result };
    if (value.familyId !== undefined) { if (!isUuid(value.familyId)) bad(); result.familyId = value.familyId; }
    if (value.minimumConfirmation !== undefined) { if (typeof value.minimumConfirmation !== "boolean") bad(); result.minimumConfirmation = value.minimumConfirmation; }
    if (value.ownerOnly !== undefined) { if (typeof value.ownerOnly !== "boolean") bad(); result.ownerOnly = value.ownerOnly; }
    if (value.resourceKind !== undefined) {
      if (value.resourceKind !== "family" && value.resourceKind !== "member" && value.resourceKind !== "virtual" && value.resourceKind !== "invitation" && value.resourceKind !== "task") bad();
      result.resourceKind = value.resourceKind;
    }
    return result;
  }
  public override saveReceipt(userId: string, requestId: string, receipt: FamilyReceipt) { return this.write("idempotency_receipts", key(userId, requestId), { ...receipt, userId, requestId }); }
}

export type InvitationKeyring = { activeKeyId: string; keys: Record<string, string>; legacyV1Secret?: string };
/** Values are server-only secrets of at least 32 UTF-8 bytes, not encoded AES keys. */
export function parseInvitationKeyring(value: unknown): InvitationKeyring {
  if (!isRecord(value) || typeof value.activeKeyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.activeKeyId) || !isRecord(value.keys)) throw new Error("Invitation keyring unavailable.");
  const keys: Record<string, string> = {};
  for (const [id, secret] of Object.entries(value.keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("Invalid invitation keyring.");
    Object.defineProperty(keys, id, { value: secret, enumerable: true });
  }
  if (!Object.hasOwn(keys, value.activeKeyId) || (value.legacyV1Secret !== undefined && (typeof value.legacyV1Secret !== "string" || Buffer.byteLength(value.legacyV1Secret, "utf8") < 32))) throw new Error("Invalid invitation keyring.");
  return { activeKeyId: value.activeKeyId, keys, ...(typeof value.legacyV1Secret === "string" ? { legacyV1Secret: value.legacyV1Secret } : {}) };
}
export function invitationKeyringFromEnvironment(value: string | undefined): InvitationKeyring {
  try {
    let json = value;
    // CloudBase CLI parses JSON-valued configuration strings into objects.
    if (value?.startsWith("base64url:")) {
      const encoded = value.slice(10);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid keyring encoding.");
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded) throw new Error("Invalid keyring encoding.");
      json = decoded.toString("utf8");
    }
    return parseInvitationKeyring(json ? JSON.parse(json) : undefined);
  }
  catch { throw new Error("Invitation keyring unavailable."); }
}
export class CloudBaseFamilyStore implements FamilyStore {
  private readonly legacy: CloudBasePersonalStore;
  private readonly keyring: InvitationKeyring;
  private readonly deadline: number;
  private readonly contexts = new Map<string, FamilyContext>();
  public constructor(private readonly db: PersonalDatabase, private readonly identity: WechatIdentity, private readonly secret: string, keyring: InvitationKeyring, private readonly nowMs: () => number = Date.now, deadline = nowMs() + 8000) {
    this.deadline = deadline;
    this.legacy = new CloudBasePersonalStore(db, identity, secret, deadline, nowMs);
    this.keyring = parseInvitationKeyring(keyring);
  }
  public remainingBudgetMs(): number { return Math.max(0, this.deadline - this.nowMs()); }
  private budget(minimum = 1) { if (this.remainingBudgetMs() < minimum) throw new FamilyBudgetExceededError(); }
  public transaction<T>(work: (tx: FamilyTransaction) => Promise<T>): Promise<T> {
    return retryTransaction(() => {
      this.budget(2000);
      return this.db.runTransaction(async tx => {
        const result = await work(new FamilyTransactionAdapter(budgetTransaction(tx, () => this.budget()), this.identity));
        this.budget(); return result;
      }, 0);
    }, { maxRetries: 2 });
  }
  private async read<T>(collection: string, id: string, parse: (v: unknown) => T): Promise<T | null> {
    this.budget(); const value = readDocument(await this.db.collection(collection).doc(id).get()); this.budget();
    if (!value) return null;
    if (value.schemaVersion !== 1 || value._id !== id) bad();
    return parse({ ...value, id });
  }
  private async page<T>(collection: string, filter: Record<string, unknown>, after: string | null, limit: number, parse: (v: unknown) => T, order = "listOrder"): Promise<FamilyPage<T>> {
    this.budget();
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid scan budget.");
    const response = await this.db.collection(collection).where({ ...filter, ...(after ? { [order]: this.db.command.gt(after) } : {}) }).orderBy(order, "asc").limit(Math.min(limit + 1, 200)).get();
    this.budget();
    if (!isRecord(response) || !Array.isArray(response.data)) bad();
    const rows: unknown[] = response.data; const selected = rows.slice(0, limit); let next = after;
    const items = selected.map(row => {
      if (!isRecord(row) || row.schemaVersion !== 1 || typeof row[order] !== "string") bad();
      next = row[order]; return parse({ ...row, id: row._id });
    });
    return { items, more: rows.length > limit || (limit === 200 && rows.length === 200), after: next };
  }
  public deriveOccurrenceId(identity: OccurrenceIdentity): string {
    const namespace = Buffer.from("736cf0e07e51468bb8692a7c9fe41241", "hex");
    const hash = createHash("sha1").update(namespace).update(occurrenceIdentityKey(identity), "utf8").digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = ((bytes[6] ?? 0) & 15) | 80; bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
    const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  public readSegment(id: string) { return this.read("schedule_segments", id, readScheduleSegment); }
  public async segments(taskId: string, after: string | null, limit: number, window?: { from: string; to: string; currentSegmentId: string }) {
    if (!window) return this.page("schedule_segments", { taskId }, after, limit, readScheduleSegment);
    if (limit < 2) throw new Error("Window segment batch must allow a current segment.");
    // Closed segments overlap the window. The current open segment is fetched separately,
    // including a current once scheduled before creation; it deliberately ignores these bounds.
    const current = after === null ? await this.readSegment(window.currentSegmentId) : null;
    if (after === null && (!current || current.taskId !== taskId)) bad();
    const page = await this.page("schedule_segments", { taskId, effectiveFrom: this.db.command.lte(localDayBounds(window.to).to), effectiveUntil: this.db.command.gte(localDayBounds(window.from).from) }, after, limit - (current ? 1 : 0), readScheduleSegment);
    return { ...page, items: current ? [current, ...page.items.filter(segment => segment.id !== current.id)] : page.items };
  }
  public async readReminderReceipts(occurrenceIds: string[], userId: string): Promise<ReminderReceipt[]> {
    if (occurrenceIds.length > 20 || !occurrenceIds.every(isUuid) || !isUuid(userId)) throw new Error("Invalid reminder receipt batch.");
    if (!occurrenceIds.length) return [];
    const ids = [...new Set(occurrenceIds.map(id => key(id, userId)))];
    this.budget();
    const response = await this.db.collection("reminder_receipts").where({ _id: this.db.command.in(ids) }).limit(20).get();
    this.budget(); if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > ids.length) bad();
    return response.data.map(value => {
      if (!isRecord(value) || value.schemaVersion !== 1 || typeof value._id !== "string" || !ids.includes(value._id)) bad();
      const receipt = readReminderReceipt(value);
      if (receipt.userId !== userId || !occurrenceIds.includes(receipt.occurrenceId) || value._id !== key(receipt.occurrenceId, userId)) bad();
      return receipt;
    });
  }
  public async previousSegmentEnd(taskId: string, before: string): Promise<string | null> {
    this.budget();
    const response = await this.db.collection("schedule_segments").where({ taskId, effectiveUntil: this.db.command.lt(localDayBounds(before).from) }).orderBy("effectiveUntil", "desc").limit(1).get();
    this.budget(); if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > 1) bad();
    const value: unknown = response.data[0]; if (value === undefined) return null;
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value._id !== "string") bad();
    const segment = readScheduleSegment({ ...value, id: value._id });
    if (segment.taskId !== taskId || (segment.effectiveUntil !== null && segment.effectiveUntil >= localDayBounds(before).from)) bad();
    return segment.effectiveUntil;
  }
  public readOccurrenceState(id: string) { return this.read("occurrence_states", id, readOccurrenceState); }
  public async readOccurrenceStates(ids: string[]): Promise<PersistedOccurrenceState[]> {
    if (ids.length > 100 || !ids.every(isUuid)) throw new Error("Invalid occurrence batch.");
    if (!ids.length) return [];
    this.budget();
    const response = await this.db.collection("occurrence_states").where({ _id: this.db.command.in([...new Set(ids)]) }).limit(100).get();
    this.budget(); if (!isRecord(response) || !Array.isArray(response.data)) bad();
    return response.data.map(value => {
      if (!isRecord(value) || value.schemaVersion !== 1 || typeof value._id !== "string" || !ids.includes(value._id)) bad();
      return readOccurrenceState({ ...value, id: value._id });
    });
  }
  public async historicalSubjects(taskId: string, membershipIds: string[]): Promise<string[]> {
    if (membershipIds.length > 20 || !membershipIds.every(isUuid)) throw new Error("Invalid historical access batch.");
    if (!membershipIds.length) return [];
    this.budget();
    const response = await this.db.collection("historical_subject_access").where({ _id: this.db.command.in(membershipIds.map(id => key(taskId, id))) }).limit(20).get();
    this.budget(); if (!isRecord(response) || !Array.isArray(response.data)) bad();
    return response.data.map(value => {
      if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== taskId || typeof value.membershipId !== "string" || !membershipIds.includes(value.membershipId) || value._id !== key(taskId, value.membershipId)) bad();
      return value.membershipId;
    });
  }
  public async historicalSubjectAccess(taskId: string, membershipId: string): Promise<boolean> {
    const value = await this.read("historical_subject_access", key(taskId, membershipId), v => {
      if (!isRecord(v) || v.taskId !== taskId || v.membershipId !== membershipId) bad(); return true;
    });
    return value === true;
  }
  public async controlBefore(taskId: string, boundary: string): Promise<PersistedScheduleControl | null> {
    this.budget();
    const response = await this.db.collection("schedule_controls").where({ taskId, controlOrder: this.db.command.lt(`${boundary}/`) }).orderBy("controlOrder", "desc").limit(1).get();
    this.budget(); if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > 1) bad();
    const row: unknown = response.data[0]; if (row === undefined) return null;
    if (!isRecord(row) || row.schemaVersion !== 1) bad();
    const control = readScheduleControl({ ...row, id: row._id }); if (control.taskId !== taskId || control.effectiveAt >= boundary) bad(); return control;
  }
  public readMember(id: string) { return this.read("memberships", id, readMembership); }
  public readVirtualMember(id: string) { return this.read("virtual_members", id, readVirtual); }
  public readInvitation(id: string) { return this.read("invitations", id, readInvitation); }
  public readTask(id: string) { return this.read("tasks", id, readCollaborativeTask); }
  public members(query: FamilyListQuery, after: string | null, limit: number) { return this.page("memberships", query, after, limit, readMembership); }
  public virtualMembers(query: FamilyListQuery, after: string | null, limit: number) { return this.page("virtual_members", query, after, limit, readVirtual); }
  public invitations(familyId: string, after: string | null, limit: number) { return this.page("invitations", { familyId }, after, limit, readInvitation); }
  public events(taskId: string, after: string | null, limit: number) {
    return this.page("task_events", { taskId }, after, limit, value => {
      if (!isRecord(value)) bad();
      const event = { id: value.id, taskId: value.taskId, occurrenceId: value.occurrenceId, kind: value.kind, actorName: value.actorName, recordedAt: value.recordedAt, actualCompletedAt: value.actualCompletedAt, note: value.note };
      if (!isTaskEvent(event) || event.taskId !== taskId) bad();
      return event;
    }, "eventOrder");
  }
  public async findInvitation(tokenHash: string) {
    const response = await this.page("invitations", { tokenHash }, null, 1, readInvitation);
    if (response.more) bad(); return response.items[0] ?? null;
  }
  public async families(userId: string): Promise<Family[]> {
    this.budget();
    const response = await this.db.collection("membership_slots").where({ userId, active: true }).limit(11).get();
    this.budget();
    if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > 10) bad();
    const rows: unknown[] = response.data;
    const slots = rows.map(row => {
      const slot = readSlot(row); if (slot.userId !== userId || slot.activeMembershipId === null) bad(); return slot;
    });
    const families = await Promise.all(slots.map(async slot => {
      const family = await this.read("families", slot.familyId, readFamily); if (!family) bad(); return family;
    }));
    return families.sort((a, b) => ordered(a).localeCompare(ordered(b)));
  }
  public async context(familyId: string, membershipIds: string[] = []): Promise<FamilyContext | null> {
    const family = await this.read("families", familyId, readFamily); if (!family) return null;
    const cached = this.contexts.get(familyId);
    const roster = cached?.family.version === family.version ? structuredClone(cached) : null;
    const [active, virtual] = roster ? [{ items: roster.members, more: false }, { items: roster.virtualMembers, more: false }] : await Promise.all([
      this.members({ familyId, status: "active" }, null, 20),
      this.virtualMembers({ familyId, status: "active" }, null, 20)
    ]);
    if (active.more || virtual.more || active.items.filter(member => member.status === "active").length !== family.memberCount || virtual.items.length !== family.virtualMemberCount) throw new Error("Family roster changed.");
    const members = active.items;
    for (const start of membershipIds) {
      const seen = new Set<string>(); let id: string | null = start;
      while (id !== null) {
        this.budget(); if (seen.has(id)) bad(); seen.add(id);
        let member = members.find(candidate => candidate.id === id);
        if (!member) { const loaded = await this.readMember(id); if (!loaded) bad(); member = loaded; members.push(member); }
        if (member.familyId !== familyId) bad();
        if (member.status === "active") break;
        id = member.successorMembershipId; if (id === null) bad();
      }
    }
    const end = await this.read("families", familyId, readFamily);
    if (!end || end.version !== family.version) throw new Error("Family roster changed.");
    const context = { family, members, virtualMembers: virtual.items };
    this.contexts.set(familyId, structuredClone(context));
    return context;
  }
  public async scanTasks(userId: string, familyId: string | null, query: PersonalQuery, asOf: string, after: string | null, limit: number): Promise<FamilyPage<CollaborativeTask>> {
    if (query.mode === "history") throw new Error("Use task event scanner for history.");
    const c = this.db.command;
    const management = query.mode === "tasks" && !query.dateFrom && !query.dateTo && !query.unscheduled && !query.overdueBefore && !query.status;
    const filter: Record<string, unknown> = { ...(familyId ? { familyId } : { ownerUserId: userId }), ...({ lifecycle: management || query.mode === "projection" ? c.in(["active", "paused", "stopped"]) : query.mode === "recycle" ? "deleted" : "active" }) };
    const order = query.mode === "projection" || management || query.mode === "recycle" || query.unscheduled ? "createdOrder" : query.overdueBefore || query.mode === "reminders" ? "recentOrder" : "scheduleOrder";
    if (query.status) filter.status = query.status;
    if (query.unscheduled) filter.date = null;
    if (query.overdueBefore) filter.date = c.gte("0001-01-01").and(c.lt(query.overdueBefore));
    if (query.dateFrom && query.dateTo) filter.date = c.gte(query.dateFrom).and(c.lte(query.dateTo));
    if (query.mode === "reminders") { filter.status = "pending"; filter.scheduledAt = c.gte("0001-01-01T00:00:00.000Z").and(c.lte(asOf)); }
    const result = await this.page("tasks", filter, after, limit, readCollaborativeTask, order);
    return { ...result, items: result.items.filter(task => (!management || task.lifecycle !== "deleted") && (familyId ? task.collaboration?.familyId === familyId : !task.collaboration)) };
  }
  public fingerprint(value: unknown) { return this.legacy.fingerprint(value); }
  public randomToken() { return randomBytes(16).toString("base64url"); }
  private encryptionKey(secret: string, version: "v1" | "v2"): Buffer { return Buffer.from(hkdfSync("sha256", secret, "family-todo", `invitation-receipt/${version}`, 32)); }
  public seal(value: unknown): string {
    this.budget(); const id = this.keyring.activeKeyId; const secret = this.keyring.keys[id]; if (!secret) bad();
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(secret, "v2"), nonce);
    cipher.setAAD(Buffer.from(`family-todo/invitation-receipt/v2/${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v2", id, nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }
  public unseal(value: string): unknown {
    this.budget();
    const parts = value.split("."); const version = parts[0];
    const legacy = version === "v1";
    if ((legacy && parts.length !== 4) || (!legacy && (version !== "v2" || parts.length !== 5))) bad();
    const id = legacy ? null : parts[1];
    const secret = legacy ? this.keyring.legacyV1Secret : id && Object.hasOwn(this.keyring.keys, id) ? this.keyring.keys[id] : undefined;
    const nonce = parts[legacy ? 1 : 2]; const ciphertext = parts[legacy ? 2 : 3]; const tag = parts[legacy ? 3 : 4];
    if (!secret || !nonce || !ciphertext || !tag || !/^[A-Za-z0-9_-]{16}$/.test(nonce) || !/^[A-Za-z0-9_-]{22}$/.test(tag) || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) bad();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(secret, legacy ? "v1" : "v2"), Buffer.from(nonce, "base64url"));
      decipher.setAAD(Buffer.from(legacy ? "family-todo/invitation-receipt/v1" : `family-todo/invitation-receipt/v2/${id}`)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
    } catch { return bad(); }
  }
  private signature(id: string) { return createHmac("sha256", this.secret).update(`family-session/v1/${id}`).digest("base64url"); }
  public async saveSession(value: Record<string, unknown>): Promise<string> {
    this.budget();
    if (!instant(value.expiresAt) || Buffer.byteLength(JSON.stringify(value), "utf8") > 128 * 1024) throw new Error("Invalid session size or expiry.");
    const id = randomBytes(24).toString("base64url");
    await this.db.collection("query_sessions").doc(id).set({ data: { ...value, schemaVersion: 2, purpose: "family" } });
    this.budget(); return `${id}.${this.signature(id)}`;
  }
  public async readSession(token: string): Promise<Record<string, unknown> | null> {
    this.budget();
    if (!/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [id, signature] = token.split("."); if (!id || !signature || !timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(id)))) return null;
    const value = readDocument(await this.db.collection("query_sessions").doc(id).get()); this.budget();
    if (!value || value.schemaVersion !== 2 || value.purpose !== "family" || !instant(value.expiresAt)) return null;
    return value;
  }
}
