import type { HistoricalSubjectAccess, OccurrenceIdentity, PersistedOccurrenceState, PersistedScheduleControl, PersistedScheduleSegment, CollaborativeTask, TaskListSource, Family, FamilyContext, FamilyEvent, Invitation, Membership, MembershipSlot, PersonalEvent, ReminderPreference, ReminderReceipt, VirtualMember } from "@family-todo/domain";
import type { PersonalQuery, PersonalReceipt, PersonalTransaction } from "./personal";

export type FamilyReceipt = PersonalReceipt & {
  familyId?: string; resourceKind?: "family" | "member" | "virtual" | "invitation" | "task";
  minimumConfirmation?: boolean; ownerOnly?: boolean;
};
export interface FamilyTransaction extends PersonalTransaction {
  batchReceipt(userId: string, requestId: string, taskId: string): Promise<FamilyReceipt | null>;
  saveBatchReceipt(userId: string, requestId: string, taskId: string, receipt: FamilyReceipt): Promise<void>;
  segment(id: string): Promise<PersistedScheduleSegment | null>;
  saveSegment(segment: PersistedScheduleSegment): Promise<void>;
  saveControl(control: PersistedScheduleControl): Promise<void>;
  occurrenceState(id: string): Promise<PersistedOccurrenceState | null>;
  saveOccurrenceState(state: PersistedOccurrenceState): Promise<void>;
  saveHistoricalSubjectAccess(access: HistoricalSubjectAccess): Promise<void>;
  task(id: string): Promise<CollaborativeTask | null>;
  saveTask(task: CollaborativeTask): Promise<void>;
  receipt(userId: string, requestId: string): Promise<FamilyReceipt | null>;
  saveReceipt(userId: string, requestId: string, receipt: FamilyReceipt): Promise<void>;
  family(id: string): Promise<Family | null>;
  saveFamily(family: Family): Promise<void>;
  member(id: string): Promise<Membership | null>;
  saveMember(member: Membership): Promise<void>;
  slot(familyId: string, userId: string): Promise<MembershipSlot | null>;
  saveSlot(slot: MembershipSlot): Promise<void>;
  virtualMember(id: string): Promise<VirtualMember | null>;
  saveVirtualMember(member: VirtualMember): Promise<void>;
  invitation(id: string): Promise<Invitation | null>;
  saveInvitation(invitation: Invitation): Promise<void>;
  preference(taskId: string, userId: string): Promise<ReminderPreference | null>;
  savePreference(preference: ReminderPreference): Promise<void>;
  reminderReceipt(occurrenceId: string, userId: string): Promise<ReminderReceipt | null>;
  saveReminderReceipt(receipt: ReminderReceipt): Promise<void>;
  addFamilyEvent(event: FamilyEvent): Promise<void>;
}
export type FamilyPage<T> = { items: T[]; more: boolean; after: string | null; olderHint?: string | null };
export type FamilyListQuery = { familyId: string; status?: string };
export class FamilyBudgetExceededError extends Error {
  public constructor() { super("Family operation time budget exceeded."); this.name = "FamilyBudgetExceededError"; }
}
export interface FamilyStore {
  /** Server-selected algorithm; included in continuation and conditional fingerprints. */
  readonly candidateAlgorithm?: "indexed-candidates/v1" | "legacy";
  /** Shared invocation budget; never reset between reads and transaction retries. */
  remainingBudgetMs(): number;
  transaction<T>(work: (tx: FamilyTransaction) => Promise<T>): Promise<T>;
  /** Reads active roster, plus full successor chains for the supplied historical IDs, outside a transaction. */
  context(familyId: string, membershipIds?: string[]): Promise<FamilyContext | null>;
  readMember(id: string): Promise<Membership | null>;
  readVirtualMember(id: string): Promise<VirtualMember | null>;
  readInvitation(id: string): Promise<Invitation | null>;
  findInvitation(tokenHash: string): Promise<Invitation | null>;
  readListTask(id: string): Promise<TaskListSource | null>;
  readListTasks(ids: string[]): Promise<TaskListSource[]>;
  scanListTasks(userId: string, familyId: string | null, query: PersonalQuery, asOf: string, after: string | null, limit: number): Promise<FamilyPage<TaskListSource>>;
  readTask(id: string): Promise<CollaborativeTask | null>;
  readTasks(ids: string[]): Promise<CollaborativeTask[]>;
  readSegments(pairs: { taskId: string; segmentId: string }[]): Promise<PersistedScheduleSegment[]>;
  readPreferences(taskIds: string[], userId: string): Promise<ReminderPreference[]>;
  historicalSubjectPairs(pairs: { taskId: string; membershipId: string }[]): Promise<HistoricalSubjectAccess[]>;
  deriveOccurrenceId(identity: OccurrenceIdentity): string;
  readSegment(id: string): Promise<PersistedScheduleSegment | null>;
  segments(taskId: string, after: string | null, limit: number, window?: { from: string; to: string; currentSegmentId: string; currentSegment?: PersistedScheduleSegment }): Promise<FamilyPage<PersistedScheduleSegment>>;
  /** Strictly before boundary; descending effectiveAt then taskVersion, at most one row. */
  controlBefore(taskId: string, boundary: string): Promise<PersistedScheduleControl | null>;
  readOccurrenceState(id: string): Promise<PersistedOccurrenceState | null>;
  readReminderReceipts(occurrenceIds: string[], userId: string): Promise<ReminderReceipt[]>;
  previousSegmentEnd(taskId: string, before: string): Promise<string | null>;
  readOccurrenceStates(ids: string[]): Promise<PersistedOccurrenceState[]>;
  historicalSubjectAccess(taskId: string, membershipId: string): Promise<boolean>;
  historicalSubjects(taskId: string, membershipIds: string[]): Promise<string[]>;
  families(userId: string): Promise<Family[]>;
  members(query: FamilyListQuery, after: string | null, limit: number): Promise<FamilyPage<Membership>>;
  virtualMembers(query: FamilyListQuery, after: string | null, limit: number): Promise<FamilyPage<VirtualMember>>;
  invitations(familyId: string, after: string | null, limit: number): Promise<FamilyPage<Invitation>>;
  events(taskId: string, after: string | null, limit: number): Promise<FamilyPage<PersonalEvent>>;
  /** familyId=null scans legacy personal rows, otherwise scans all family candidates for server-side filtering. */
  scanTasks(userId: string, familyId: string | null, query: PersonalQuery, asOf: string, after: string | null, limit: number): Promise<FamilyPage<CollaborativeTask>>;
  fingerprint(value: unknown): string;
  randomToken(): string;
  /** Authenticated encryption with purpose-bound server keys; never stores invitation plaintext. */
  seal(value: unknown): string;
  unseal(value: string): unknown;
  saveSession(value: Record<string, unknown>): Promise<string>;
  readSession(token: string): Promise<Record<string, unknown> | null>;
}
