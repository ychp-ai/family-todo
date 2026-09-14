import type { ApiResponse, ErrorCode, IdentityEnsureData, UserDTO } from "@family-todo/contracts";

import { ensureIdentity } from "./identity-api";
import { createRequestId, RequestIdUnavailableError } from "./request-id";

type SessionErrorCode = ErrorCode | "NETWORK_ERROR" | "TIMEOUT" | "UNSUPPORTED" | "SESSION_INVALIDATED";

export class IdentitySessionError extends Error {
  public constructor(public readonly code: SessionErrorCode, message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "IdentitySessionError";
  }
}

export type IdentitySessionState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly user: Readonly<UserDTO> }
  | { readonly status: "error"; readonly error: IdentitySessionError };

type EnsureIdentity = (requestId: string) => Promise<ApiResponse<IdentityEnsureData>>;

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new IdentitySessionError("TIMEOUT", "身份初始化超时，请重试。", true)), 10_000);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** 仅缓存本次小程序进程的公开用户信息，不把本地缓存当作服务端授权。 */
export class IdentitySession {
  private current: IdentitySessionState = Object.freeze({ status: "idle" });
  private inFlight: Promise<Readonly<UserDTO>> | null = null;
  private requestId: string | null = null;
  private generation = 0;

  public constructor(
    private readonly ensureUser: EnsureIdentity = ensureIdentity,
    private readonly generateRequestId: () => Promise<string> = createRequestId,
    private readonly recovery?: { verified(user: Readonly<UserDTO>): void; invalidated(): void },
  ) {}

  public get state(): IdentitySessionState { return this.current; }

  public ensure(): Promise<Readonly<UserDTO>> {
    if (this.inFlight) return this.inFlight;
    if (this.current.status === "ready") { this.recovery?.verified(this.current.user); return Promise.resolve(this.current.user); }
    const generation = this.generation;
    this.current = Object.freeze({ status: "loading" });
    const operation = this.initialize(generation).finally(() => {
      if (generation === this.generation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  /** 返回前台时显式重新向服务器核验；已有初始化仍共享同一请求。 */
  public refresh(): Promise<Readonly<UserDTO>> {
    if (this.current.status === "ready") this.current = Object.freeze({ status: "idle" });
    return this.ensure();
  }

  /** 清除用户及未决身份请求；旧响应不得恢复已经失效的会话。 */
  public invalidate(): void {
    this.recovery?.invalidated();
    this.generation += 1;
    this.inFlight = null;
    this.requestId = null;
    this.current = Object.freeze({ status: "idle" });
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new IdentitySessionError("SESSION_INVALIDATED", "会话已失效，请重新进入。", false);
  }

  private async initialize(generation: number): Promise<Readonly<UserDTO>> {
    try {
      const requestId = this.requestId ?? await withTimeout(this.generateRequestId());
      this.assertCurrent(generation);
      this.requestId = requestId;
      const result = await withTimeout(this.ensureUser(requestId));
      this.assertCurrent(generation);
      if (!result.ok) throw new IdentitySessionError(result.error.code, result.error.message, result.error.retryable);
      const user = Object.freeze({ ...result.data.user });
      this.requestId = null;
      this.recovery?.verified(user);
      this.current = Object.freeze({ status: "ready", user });
      return user;
    } catch (cause) {
      this.assertCurrent(generation);
      const error = cause instanceof IdentitySessionError ? cause
        : cause instanceof RequestIdUnavailableError ? new IdentitySessionError("UNSUPPORTED", cause.message, false)
        : new IdentitySessionError("NETWORK_ERROR", "身份初始化失败，请稍后重试。", true);
      this.current = Object.freeze({ status: "error", error });
      throw error;
    }
  }
}
