import type { CollaborativeTask, Family, FamilyContext, FamilyEvent, Invitation, Membership, MembershipSlot, PersonalEvent, ReminderPreference, ReminderReceipt, VirtualMember } from "@family-todo/domain";
import type { PersonalQuery, PersonalReceipt, PersonalTransaction } from "./personal";

export type FamilyReceipt = PersonalReceipt & {
  familyId?: string; resourceKind?: "family" | "member" | "virtual" | "invitation" | "task";
  minimumConfirmation?: boolean; ownerOnly?: boolean;
};
export interface FamilyTransaction extends PersonalTransaction {
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
export type FamilyPage<T> = { items: T[]; more: boolean; after: string | null };
export type FamilyListQuery = { familyId: string; status?: string };
export class FamilyBudgetExceededError extends Error {
  public constructor() { super("Family operation time budget exceeded."); this.name = "FamilyBudgetExceededError"; }
}
export interface FamilyStore {
  /** Shared invocation budget; never reset between reads and transaction retries. */
  remainingBudgetMs(): number;
  transaction<T>(work: (tx: FamilyTransaction) => Promise<T>): Promise<T>;
  /** Reads active roster, plus full successor chains for the supplied historical IDs, outside a transaction. */
  context(familyId: string, membershipIds?: string[]): Promise<FamilyContext | null>;
  readMember(id: string): Promise<Membership | null>;
  readVirtualMember(id: string): Promise<VirtualMember | null>;
  readInvitation(id: string): Promise<Invitation | null>;
  findInvitation(tokenHash: string): Promise<Invitation | null>;
  readTask(id: string): Promise<CollaborativeTask | null>;
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
