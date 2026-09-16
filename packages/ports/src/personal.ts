import type { PersonalEvent, PersonalScope, PersonalTask, User } from "@family-todo/domain";

export type PersonalReceipt = { fingerprint: string; taskId: string; result: unknown };
export interface PersonalTransaction {
  actor(): Promise<User>;
  scope(userId: string): Promise<PersonalScope>;
  saveScope(scope: PersonalScope): Promise<void>;
  task(id: string): Promise<PersonalTask | null>;
  saveTask(task: PersonalTask): Promise<void>;
  receipt(userId: string, requestId: string): Promise<PersonalReceipt | null>;
  saveReceipt(userId: string, requestId: string, receipt: PersonalReceipt): Promise<void>;
  addEvent(event: PersonalEvent): Promise<void>;
}
export type PersonalQuery = {
  mode: "tasks" | "recycle" | "reminders" | "history" | "projection";
  candidateWindow?: { from: string; to: string; backlog: boolean };
  taskId?: string; dateFrom?: string; dateTo?: string; unscheduled?: boolean;
  overdueBefore?: string; status?: "pending" | "completed" | "skipped"; includeDismissed?: boolean;
};
export type QueryCheckpoint = { actorId: string; fingerprint: string; revision: number; asOf: string; after: string | null; summary: { completed: number; pending: number; skipped: number; denominator: number }; expiresAt: string };
export interface PersonalStore {
  transaction<T>(work: (transaction: PersonalTransaction) => Promise<T>): Promise<T>;
  scan(userId: string, query: PersonalQuery, asOf: string, after: string | null, limit: number): Promise<{ tasks: PersonalTask[]; events: PersonalEvent[]; more: boolean; after: string | null }>;
  saveCheckpoint(checkpoint: QueryCheckpoint): Promise<string>;
  readCheckpoint(token: string): Promise<QueryCheckpoint | null>;
  fingerprint(value: unknown): string;
}
