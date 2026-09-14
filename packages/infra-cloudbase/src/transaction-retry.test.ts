import { describe, expect, it, vi } from "vitest";
import { retryTransaction } from "./transaction-retry";

describe("事务冲突重试", () => {
  it.each([{code:"DATABASE_TRANSACTION_CONFLICT"},new Error("document.set:fail -501001 [ResourceUnavailable.TransactionConflict] Transaction is conflict")])("识别 SDK 保留或包装后的冲突", async error => {
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("committed");
    await expect(retryTransaction(run)).resolves.toBe("committed");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("未知失败和业务拒绝不重试", async () => {
    const error = new Error("network unavailable");
    const run = vi.fn().mockRejectedValue(error);
    await expect(retryTransaction(run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("持续冲突最多执行四次", async () => {
    const error = {code:"DATABASE_TRANSACTION_CONFLICT"};
    const run = vi.fn().mockRejectedValue(error);
    await expect(retryTransaction(run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
