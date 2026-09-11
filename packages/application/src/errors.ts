import type { ErrorCode } from "@family-todo/contracts";

/** 仅用于可安全返回客户端的错误，不传入 SDK 原始异常。 */
export class ApplicationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
