import { countMetric } from "./api-metrics";
import { isRecord } from "@family-todo/contracts";

function conflict(error: unknown): boolean {
  if (isRecord(error) && error.code === "DATABASE_TRANSACTION_CONFLICT") return true;
  // wx-server-sdk 4.0.2 会把底层 code 转成 Error.message，原生自动重试无法识别。
  return error instanceof Error && error.message.includes("[ResourceUnavailable.TransactionConflict]");
}

/** runTransaction 已回滚后重开事务；只重试明确的冲突，业务错误和未知失败直接抛出。 */
export async function retryTransaction<T>(run: () => Promise<T>, options: { maxRetries?: number } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= (options.maxRetries ?? 3) || !conflict(error)) throw error;
      countMetric("retries");
      await new Promise(resolve => setTimeout(resolve, Math.floor((0.5 + Math.random() * 0.5) * 100 * 2 ** attempt)));
    }
  }
}
