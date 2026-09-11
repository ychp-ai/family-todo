import { API_VERSION, isRecord } from "@family-todo/contracts";
import type { SystemHealthData } from "@family-todo/contracts";
import { formatUtcInstant } from "@family-todo/domain";
import type { Clock } from "@family-todo/ports";

import { ApplicationError } from "./errors";
import type { ActionHandler } from "./router";

export class SystemHealthHandler implements ActionHandler {
  public readonly action = "system.health" as const;

  public constructor(private readonly clock: Clock) {}

  public async handle(payload: unknown): Promise<SystemHealthData> {
    if (!isRecord(payload) || Object.keys(payload).length !== 0) {
      throw new ApplicationError("VALIDATION_ERROR", "健康检查参数必须为空对象。");
    }
    return {
      status: "ok",
      service: "api",
      apiVersion: API_VERSION,
      now: formatUtcInstant(this.clock.now()),
    };
  }
}
