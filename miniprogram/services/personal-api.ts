import type { PersonalAction, PersonalActionMap, FamilyAction, FamilyActionMap } from "@family-todo/contracts";
import { isPersonalData, isFamilyData, FAMILY_ACTIONS } from "../shared/contracts";
import { AppApiClient } from "./app-api-client";
import { createRequestId } from "./request-id";

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
/** 未决写请求跨页面保留同一个 ID；只有明确成功或业务拒绝才释放。 */
export class PersonalApi {
  private readonly pending = new Map<string, { run: () => Promise<unknown> }>();
  public get pendingCount(): number { return this.pending.size; }
  public async retryPending(): Promise<void> { for (const operation of [...this.pending.values()]) await operation.run(); }
  public constructor(private readonly api = new AppApiClient(),private readonly ids = createRequestId) {}
  public async read<A extends BusinessAction>(action: A,payload: BusinessMap[A]["payload"]): Promise<BusinessMap[A]["data"]> { return this.call(action,payload,await timeout(this.ids())); }
  public async write<A extends BusinessAction>(action: A,payload: BusinessMap[A]["payload"]): Promise<BusinessMap[A]["data"]> {
    const key = JSON.stringify({action,payload});
    const previous = this.pending.get(key);
    if (previous) {
      const data = await previous.run();
      if (guard(action, data)) return data;
      throw new PersonalApiError("NETWORK_ERROR", "响应未能确认，请重试。", true);
    }
    if (this.pending.size) throw new PersonalApiError("PENDING_WRITE", "请先返回首页，重试确认上一次操作的结果。", false);
    // Clone before sending: retries retain the complete original payload even after page unload.
    const original: BusinessMap[A]["payload"] = JSON.parse(JSON.stringify(payload));
    const id = timeout(this.ids());
    const run = async (): Promise<BusinessMap[A]["data"]> => {
      let requestId: string;
      try { requestId = await id; } catch (error) { this.pending.delete(key); throw error; }
      try { const data = await this.call(action, original, requestId); this.pending.delete(key); return data; }
      catch (error) { if (error instanceof PersonalApiError && !error.retryable) this.pending.delete(key); throw error; }
    };
    this.pending.set(key, {run});
    return run();
  }
  private async call<A extends BusinessAction>(action: A,payload: BusinessMap[A]["payload"],requestId: string): Promise<BusinessMap[A]["data"]> {
    try {
      const result = await timeout(this.api.call({apiVersion:1,action,payload,requestId},(value): value is BusinessMap[A]["data"] => guard(action,value)));
      if (!result.ok) throw new PersonalApiError(result.error.code,result.error.message,result.error.retryable);
      return result.data;
    } catch (error) { if (error instanceof PersonalApiError) throw error; throw new PersonalApiError("NETWORK_ERROR","网络暂时不可用，请重试。",true); }
  }
}
export const personalApi = new PersonalApi();
