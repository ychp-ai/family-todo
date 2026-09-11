import type { ApiAction, ApiRequest } from "@family-todo/contracts";

import { ApplicationError } from "./errors";

export type RequestContext = { requestId: string };

export interface ActionHandler {
  readonly action: ApiAction;
  handle(payload: unknown, context: RequestContext): Promise<unknown>;
}

export class ActionRouter {
  private readonly handlers = new Map<string, ActionHandler>();

  public register(handler: ActionHandler): void {
    if (this.handlers.has(handler.action)) {
      throw new Error(`Handler already registered for ${handler.action}.`);
    }
    this.handlers.set(handler.action, handler);
  }

  public async dispatch(request: ApiRequest<unknown, string>): Promise<unknown> {
    const handler = this.handlers.get(request.action);
    if (!handler) throw new ApplicationError("NOT_FOUND", "请求的接口不存在。");
    return handler.handle(request.payload, { requestId: request.requestId });
  }
}
