import { BATCH_OPERATION_LIMIT, isPersonalData, isPersonalPayload, isRecord } from "@family-todo/contracts";
import type { BatchItemResult, PersonalActionMap } from "@family-todo/contracts";
import { familyTaskRights } from "@family-todo/domain";
import type { FamilyContext } from "@family-todo/domain";
import type { Clock, FamilyReceipt, FamilyStore, FamilyTransaction, UuidGenerator } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { appendTaskViewers } from "./task-access";
import { occurrenceDTO, taskContext, taskInvalid, taskMissing, taskVersion, verifyContext } from "./task-context";

// Leave room under the adapter's 80-document transaction budget.
const RECEIPT_BATCH_SIZE = 50;

type Input = PersonalActionMap["task.batchAddViewers"]["payload"];
type Item = Input["items"][number];
function conflict(): never { throw new ApplicationError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他操作，请重新发起。"); }
function failed(taskId: string, error: ApplicationError): BatchItemResult { return { taskId, status: "failed", error: { code: error.code, message: error.message, retryable: error.retryable } }; }
function resultOf(receipt: FamilyReceipt, fingerprint: string, taskId: string): BatchItemResult {
  if (receipt.fingerprint !== fingerprint) conflict();
  const data = { complete: true, results: [receipt.result] };
  if (receipt.taskId !== taskId || !isPersonalData("task.batchAddViewers", data)) throw new Error("Invalid batch child receipt.");
  const result = data.results[0]; if (!result) throw new Error("Missing child result."); return result;
}
/** Parent uses the shared actor/requestId namespace. Children have a separate physical key prefix. */
export class BatchViewers {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock, private readonly uuids: UuidGenerator) {}
  public async execute(payload: unknown, requestId: string): Promise<PersonalActionMap["task.batchAddViewers"]["data"]> {
    if (!isPersonalPayload("task.batchAddViewers", payload)) throw new ApplicationError("VALIDATION_ERROR", `每批请选择至多${BATCH_OPERATION_LIMIT}个不同事项。`);
    const fingerprint = this.store.fingerprint({ action: "task.batchAddViewers", payload });
    const { actorId, terminalResults } = await this.store.transaction(async tx => {
      const actor = await tx.actor(); const parent = await tx.receipt(actor.id, requestId);
      if (parent) { if (parent.fingerprint !== fingerprint || !isRecord(parent.result) || parent.result.kind !== "batch") conflict(); }
      else {
        const first = payload.items[0]; if (!first) throw new Error("Empty batch.");
        await tx.saveReceipt(actor.id, requestId, { fingerprint, taskId: first.taskId, result: { kind: "batch", status: "running", items: payload.items } });
      }
      const terminalResults = await this.terminalBatch(tx, payload.items.slice(0, RECEIPT_BATCH_SIZE), actor.id, requestId, fingerprint);
      return { actorId: actor.id, terminalResults };
    });
    // Immutable child receipts can be scanned across bounded transactions. Prioritize
    // unfinished children so replay authorization cannot starve new work on continuation.
    const remainingResults = await this.terminalResults(payload.items.slice(RECEIPT_BATCH_SIZE), actorId, requestId, fingerprint);
    for (const [taskId, result] of remainingResults) terminalResults.set(taskId, result);
    const results: BatchItemResult[] = [];
    const scheduled = [...payload.items.filter(item => !terminalResults.has(item.taskId)), ...payload.items.filter(item => terminalResults.has(item.taskId))];
    for (const item of scheduled) {
      if (this.store.remainingBudgetMs() < 2000) { results.push({ taskId: item.taskId, status: "pending" }); continue; }
      try {
        const terminal = terminalResults.get(item.taskId);
        results.push(terminal ? await this.replay(item, actorId, terminal) : await this.item(item, actorId, requestId, fingerprint));
      }
      catch (error) {
        // Only explicit application failures prove the business transaction aborted. Unknown commits stay pending.
        if (error instanceof ApplicationError && !error.retryable && error.code !== "IDEMPOTENCY_CONFLICT" && this.store.remainingBudgetMs() >= 2000) {
          try {
            const result = await this.store.transaction(async tx => {
              const existing = await tx.batchReceipt(actorId, requestId, item.taskId);
              if (existing) return resultOf(existing, fingerprint, item.taskId);
              const result = failed(item.taskId, error);
              await tx.saveBatchReceipt(actorId, requestId, item.taskId, { fingerprint, taskId: item.taskId, result }); return result;
            });
            // A concurrent invocation may have committed success; apply replay authorization to that result.
            results.push(result.status === "succeeded" ? await this.replay(item, actorId, result) : result);
          } catch (failure) { if (failure instanceof ApplicationError && failure.code === "IDEMPOTENCY_CONFLICT") throw failure; results.push({ taskId: item.taskId, status: "pending" }); }
        } else { if (error instanceof ApplicationError && error.code === "IDEMPOTENCY_CONFLICT") throw error; results.push({ taskId: item.taskId, status: "pending" }); }
      }
    }
    const complete = results.every(result => result.status !== "pending");
    if (complete && this.store.remainingBudgetMs() >= 2000) {
      // Derive completion from durable children; receipts are immutable once committed,
      // so checking them in separate bounded transactions does not weaken completion.
      try {
        const finalBatchStart = Math.floor((payload.items.length - 1) / RECEIPT_BATCH_SIZE) * RECEIPT_BATCH_SIZE;
        const terminal = await this.terminalResults(payload.items.slice(0, finalBatchStart), actorId, requestId, fingerprint);
        if (terminal.size === finalBatchStart && this.store.remainingBudgetMs() >= 2000) {
          await this.store.transaction(async tx => {
            const parent = await tx.receipt(actorId, requestId); if (!parent || parent.fingerprint !== fingerprint) conflict();
            const finalBatch = payload.items.slice(finalBatchStart);
            const receipts = await this.terminalBatch(tx, finalBatch, actorId, requestId, fingerprint);
            if (receipts.size !== finalBatch.length) return;
            await tx.saveReceipt(actorId, requestId, { ...parent, result: { kind: "batch", status: "completed", items: payload.items } });
          });
        }
      } catch { /* Derived child results remain authoritative if marking the parent loses its response. */ }
    }
    // Response order remains the original payload order. A terminal success that could not
    // be freshly authorized within this budget is pending here, never a leaked old version.
    const byTask = new Map(results.map(result => [result.taskId, result]));
    return { complete, results: payload.items.map(item => byTask.get(item.taskId) ?? { taskId: item.taskId, status: "pending" }) };
  }
  private async terminalResults(items: Item[], actorId: string, requestId: string, fingerprint: string): Promise<Map<string, BatchItemResult>> {
    const results = new Map<string, BatchItemResult>();
    for (let offset = 0; offset < items.length; offset += RECEIPT_BATCH_SIZE) {
      if (this.store.remainingBudgetMs() < 2000) break;
      const batch = items.slice(offset, offset + RECEIPT_BATCH_SIZE);
      const receipts = await this.store.transaction(tx => this.terminalBatch(tx, batch, actorId, requestId, fingerprint));
      for (const [taskId, result] of receipts) results.set(taskId, result);
    }
    return results;
  }
  private async terminalBatch(tx: FamilyTransaction, items: Item[], actorId: string, requestId: string, fingerprint: string): Promise<Map<string, BatchItemResult>> {
    const receipts = await Promise.all(items.map(async item => {
      const receipt = await tx.batchReceipt(actorId, requestId, item.taskId);
      return receipt ? resultOf(receipt, fingerprint, item.taskId) : null;
    }));
    const results = new Map<string, BatchItemResult>();
    for (const result of receipts) if (result) results.set(result.taskId, result);
    return results;
  }
  private async context(item: Item, actorId: string): Promise<FamilyContext | null> {
    const task = await this.store.readTask(item.taskId);
    if (!task) taskMissing();
    if (task.collaboration) return taskContext(this.store, task);
    if (task.ownerUserId !== actorId) taskMissing();
    if (!item.targetFamilyId) taskInvalid("个人事项需要明确选择目标家庭。");
    return this.store.context(item.targetFamilyId);
  }
  private async authorize(tx: FamilyTransaction, context: FamilyContext | null, item: Item, actorId: string) {
    const task = await tx.task(item.taskId); if (!task || task.lifecycle === "deleted") taskMissing();
    if (!context) taskMissing();
    const actor = await verifyContext(tx, context, actorId);
    if (task.collaboration) {
      if (task.collaboration.familyId !== context.family.id) taskMissing();
      const rights = familyTaskRights(task, context, actorId); if (!rights.canView || !rights.manager) taskMissing();
    } else if (task.ownerUserId !== actorId) taskMissing();
    return { task, actor };
  }
  private async replay(item: Item, actorId: string, result: BatchItemResult): Promise<BatchItemResult> {
    if (result.status !== "succeeded") return result;
    try { const context = await this.context(item, actorId); await this.store.transaction(async tx => { await this.authorize(tx, context, item, actorId); }); return result; }
    catch (error) { if (error instanceof ApplicationError && error.code === "NOT_FOUND") return failed(item.taskId, error); throw error; }
  }
  private async item(item: Item, actorId: string, requestId: string, fingerprint: string): Promise<BatchItemResult> {
    const snapshot = await this.context(item, actorId); const eventId = this.uuids.generate();
    if (this.store.remainingBudgetMs() < 2000) return { taskId: item.taskId, status: "pending" };
    return this.store.transaction(async tx => {
      const receipt = await tx.batchReceipt(actorId, requestId, item.taskId);
      const context = snapshot ? { ...snapshot, family: { ...snapshot.family } } : null;
      if (receipt) {
        const result = resultOf(receipt, fingerprint, item.taskId);
        if (result.status === "succeeded") await this.authorize(tx, context, item, actorId);
        return result;
      }
      const { task, actor } = await this.authorize(tx, context, item, actorId); if (!context) taskMissing();
      taskVersion(task.version, item.expectedVersion);
      const now = this.clock.now().toISOString(); const promotion = !task.collaboration;
      if (!promotion && item.targetFamilyId !== undefined) taskInvalid("已归属家庭的事项不能更换家庭。");
      if (promotion) {
        const scope = await tx.scope(actorId);
        if (!item.targetFamilyId || context.family.id !== item.targetFamilyId) taskMissing();
        if (context.family.taskCount >= 500) throw new ApplicationError("LIMIT_EXCEEDED", "家庭事项已达500条，请先整理。");
        const original = occurrenceDTO(task, false);
        task.collaboration = { familyId: context.family.id, creatorMembershipId: actor.id, createdByUserId: actorId, ownerBinding: { kind: "membership", membershipId: actor.id }, subject: { kind: "member", membershipId: actor.id }, subjectName: actor.name, viewerMembershipIds: [], helperMembershipIds: [], occurrenceSnapshot: { subject: original.subject, subjectName: original.subjectName } };
        context.family.taskCount++; scope.personalTaskCount--; if (scope.personalTaskCount < 0) throw new Error("Invalid personal quota.");
        // No rewriting schedule segments, sparse states, past subjects, or other users' preferences.
        const existing = await tx.preference(task.id, actorId);
        if (existing) await tx.savePreference({ ...existing, membershipId: actor.id });
        else await tx.savePreference({ taskId: task.id, userId: actorId, membershipId: actor.id, enabled: task.reminderEnabled, selfDisabled: task.reminderSelfDisabled, version: Math.max(1, task.reminderVersion) });
        if (!task.recurrence && (task.readAt || task.dismissedAt)) {
          const existingReceipt = await tx.reminderReceipt(task.occurrenceId, actorId);
          if (!existingReceipt) await tx.saveReminderReceipt({ occurrenceId: task.occurrenceId, userId: actorId, readAt: task.readAt, dismissedAt: task.dismissedAt, version: 1 });
        }
        scope.revision++; await tx.saveScope(scope);
      }
      const changed = appendTaskViewers(task, context, actorId, item.viewerMembershipIds);
      if (changed || promotion) {
      task.version++; task.updatedAt = now; context.family.version++; context.family.authEpoch++; context.family.updatedAt = now;
      await tx.saveTask(task); await tx.saveFamily(context.family);
      await tx.addEvent({ id: eventId, taskId: task.id, occurrenceId: null, kind: "task.accessChanged", actorUserId: actorId, actorName: actor.name, recordedAt: now, actualCompletedAt: null, note: "" });
      }
      const result: BatchItemResult = { taskId: task.id, status: "succeeded", version: task.version };
      await tx.saveBatchReceipt(actorId, requestId, task.id, { fingerprint, taskId: task.id, familyId: context.family.id, resourceKind: "task", result }); return result;
    });
  }
}
