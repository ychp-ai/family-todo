import type { PersonalAction, PersonalActionMap, FamilyAction, FamilyActionMap } from "@family-todo/contracts";
import { isPersonalData, isPersonalPayload, isFamilyData, FAMILY_ACTIONS, isUuid } from "../shared/contracts";
import { AppApiClient } from "./app-api-client";
import { createRequestId } from "./request-id";
import { isDurablePayload, isDurableWriteAction, isRecoveryRecord, recoveryContextKey, wxRecoveryStorage } from "./write-recovery";
import type { RecoveryRecord, RecoveryStorage } from "./write-recovery";

type BusinessMap = PersonalActionMap & FamilyActionMap;
type BusinessAction = keyof BusinessMap;
function guard<A extends BusinessAction>(action: A, value: unknown): value is BusinessMap[A]["data"] {
  return FAMILY_ACTIONS.some(a => a === action) ? isFamilyData(action as FamilyAction, value) : isPersonalData(action as PersonalAction, value);
}

export class PersonalApiError extends Error {
  public constructor(public readonly code: string,message: string,public readonly retryable: boolean) { super(message); }
}
export function isAccessDenied(error:unknown):boolean { return error instanceof PersonalApiError && !error.retryable && ["FORBIDDEN","NOT_FOUND","UNAUTHENTICATED","FAMILY_NOT_FOUND"].includes(error.code); }
function timeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new PersonalApiError("TIMEOUT","请求超时，重试会继续确认本次操作。",true)),10000);
    promise.then(resolve,reject).finally(() => clearTimeout(timer));
  });
}
/** One identity-bound intent; persist its original request before any network write. */
export class PersonalApi {
  private batchState: {payload: PersonalActionMap["task.batchAddViewers"]["payload"]; result: PersonalActionMap["task.batchAddViewers"]["data"] | null} | null = null;
  private context: string | null = null;
  private generation = 0;
  private recoveryFailure: PersonalApiError | null = null;
  private pending: {key: string; run: () => Promise<unknown>} | null = null;
  public constructor(private readonly api = new AppApiClient(), private readonly ids = createRequestId, private readonly storage?: RecoveryStorage) {}
  public get recoveryGeneration(): number { return this.generation; }
  public get recoveryContext(): string | null { return this.context; }
  public get recoveryError(): string { return this.recoveryFailure?.message ?? ""; }
  public get pendingCount(): number { return this.pending || this.recoveryFailure ? 1 : 0; }
  public get batch() { return this.batchState ? JSON.parse(JSON.stringify(this.batchState)) as typeof this.batchState : null; }

  public bindRecovery(environment: string, userId: string): void {
    const context = recoveryContextKey(environment, userId);
    if (context === this.context) { if (this.recoveryFailure && !this.pending) this.loadRecovery(); return; }
    this.generation++;
    this.context = context;
    this.pending = null;
    this.batchState = null;
    this.recoveryFailure = null;
    this.loadRecovery();
  }
  public unbindRecovery(): void {
    this.generation++;
    this.context = null;
    this.pending = null;
    this.batchState = null;
    this.recoveryFailure = null;
  }
  private storageError(): PersonalApiError { return new PersonalApiError("RECOVERY_STORAGE", "操作恢复记录暂时无法读取或保存，请返回首页重试确认，暂勿重复新建。", true); }
  private loadRecovery(): void {
    if (!this.storage || !this.context) return;
    try {
      const value = this.storage.read(this.context + ":pending");
      if (value !== undefined && value !== "") {
        if (!isRecoveryRecord(value)) throw this.storageError();
        this.install(value.action, value.payload, Promise.resolve(value.requestId), value.draftId, value);
      }
      this.recoveryFailure = null;
    } catch { this.recoveryFailure = this.storageError(); }
  }
  /** Draft owners persist their UUID before write, check this marker before restoring, then remove it AFTER deleting the draft. */
  public isDraftCompleted(draftId: string): boolean {
    if (!this.storage) return false;
    if (!this.context) throw this.storageError();
    try {
      const value = this.storage.read(this.context + ":completed:" + draftId);
      if (value === undefined || value === "") return false;
      if (value !== true) throw this.storageError();
      return true;
    } catch { throw this.storageError(); }
  }
  public forgetDraftCompletion(draftId: string): void {
    if (!this.storage) return;
    if (!this.context) throw this.storageError();
    try { this.storage.remove(this.context + ":completed:" + draftId); } catch { throw this.storageError(); }
  }
  public async continueBatch() {
    if (!this.batchState) throw new PersonalApiError("NOT_FOUND", "没有待继续的批量操作。", false);
    if (this.batchState.result?.complete) return this.batchState.result;
    if (!this.pending) throw new PersonalApiError("NOT_FOUND", "本次操作已结束，请重新选择事项。", false);
    return this.write("task.batchAddViewers", this.batchState.payload);
  }
  public async retryPending(): Promise<void> {
    if (this.recoveryFailure && !this.pending) this.loadRecovery();
    if (this.recoveryFailure) throw this.recoveryFailure;
    await this.pending?.run();
  }
  public async read<A extends BusinessAction>(action: A,payload: BusinessMap[A]["payload"]): Promise<BusinessMap[A]["data"]> { return this.call(action,payload,await timeout(this.ids())); }
  public async write<A extends BusinessAction>(action: A, payload: BusinessMap[A]["payload"], options: {draftId?: string} = {}): Promise<BusinessMap[A]["data"]> {
    if (!isDurableWriteAction(action) && action !== "invitation.accept") throw new PersonalApiError("INVALID_ARGUMENT", "此操作不支持写入重试。", false);
    if ((isDurableWriteAction(action) && !isDurablePayload(action, payload)) || (options.draftId !== undefined && !isUuid(options.draftId))) throw new PersonalApiError("INVALID_ARGUMENT", "操作内容无效，请检查后重试。", false);
    if (this.recoveryFailure) throw this.recoveryFailure;
    if (this.storage && !this.context) throw new PersonalApiError("UNAUTHENTICATED", "请先确认身份后再操作。", false);
    const key = JSON.stringify({action,payload});
    if (this.pending && this.pending.key !== key) throw new PersonalApiError("PENDING_WRITE", "请先返回首页，重试确认上一次操作的结果。", false);
    const operation = this.pending ?? this.install(action, payload, timeout(this.ids()), options.draftId);
    const data = await operation.run();
    if (guard(action, data)) return data;
    throw new PersonalApiError("WRITE_CONFIRMED", "上次操作已确认，请刷新查看最新结果。", false);
  }
  private install(action: BusinessAction, payload: unknown, id: Promise<string>, draftId?: string, restored?: RecoveryRecord) {
    const original: unknown = JSON.parse(JSON.stringify(payload));
    const key = JSON.stringify({action, payload: original});
    const generation = this.generation;
    const context = this.context;
    const durable = this.storage && context && isDurableWriteAction(action);
    let record = restored;
    let confirmedData: unknown;
    let confirmedState: "succeeded" | "rejected" | undefined = restored?.state === "pending" ? undefined : restored?.state;
    const current = () => generation === this.generation && this.pending === operation;
    const assertCurrent = () => { if (!current()) throw new PersonalApiError("SESSION_INVALIDATED", "会话已切换，请重新进入。", false); };
    if (action === "task.batchAddViewers" && isPersonalDataPayloadBatch(original)) this.batchState = {payload: original, result: null};
    const finalize = () => {
      assertCurrent();
      if (durable && record && confirmedState) {
        try {
          if (confirmedState === "succeeded" && record.draftId) this.storage?.write(context + ":completed:" + record.draftId, true);
          this.storage?.write(context + ":pending", {...record, state: confirmedState});
          this.storage?.remove(context + ":pending");
        } catch { throw this.storageError(); }
      }
      this.pending = null;
    };
    const execute = async (): Promise<unknown> => {
      assertCurrent();
      if (confirmedState) { finalize(); return confirmedData; }
      let requestId: string;
      try { requestId = await id; } catch (error) { if (current()) this.pending = null; throw error; }
      assertCurrent();
      if (durable) {
        if (!record && isDurableWriteAction(action)) record = {version: 1, action, payload: original, requestId, state: "pending", ...(draftId ? {draftId} : {})};
        if (!isRecoveryRecord(record)) throw this.storageError();
        try { this.storage?.write(context + ":pending", record); } catch { throw this.storageError(); }
      }
      let data: unknown;
      try { data = await this.call(action, original as BusinessMap[typeof action]["payload"], requestId); }
      catch (error) {
        assertCurrent();
        if (error instanceof PersonalApiError && !error.retryable) { confirmedState = "rejected"; finalize(); }
        throw error;
      }
      assertCurrent();
      if (action === "task.batchAddViewers" && isPersonalData("task.batchAddViewers", data)) {
        if (this.batchState) this.batchState.result = data;
        if (!data.complete) return data;
      }
      confirmedData = data;
      confirmedState = "succeeded";
      finalize();
      return data;
    };
    let inFlight: Promise<unknown> | undefined;
    const operation = {key, run: (): Promise<unknown> => { inFlight ??= execute().finally(() => { inFlight = undefined; }); return inFlight; }};
    this.pending = operation;
    return operation;
  }
  private async call<A extends BusinessAction>(action: A,payload: BusinessMap[A]["payload"],requestId: string): Promise<BusinessMap[A]["data"]> {
    try {
      const result = await timeout(this.api.call({apiVersion:1,action,payload,requestId},(value): value is BusinessMap[A]["data"] => guard(action,value)));
      if (!result.ok) throw new PersonalApiError(result.error.code,result.error.message,result.error.retryable);
      return result.data;
    } catch (error) { if (error instanceof PersonalApiError) throw error; throw new PersonalApiError("NETWORK_ERROR","网络暂时不可用，请重试。",true); }
  }
}
export const personalApi = new PersonalApi(new AppApiClient(), createRequestId, wxRecoveryStorage);

function isPersonalDataPayloadBatch(value:unknown):value is PersonalActionMap["task.batchAddViewers"]["payload"] { return isPersonalPayload("task.batchAddViewers",value); }
