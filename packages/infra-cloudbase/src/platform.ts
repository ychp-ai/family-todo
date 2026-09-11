import { randomUUID } from "node:crypto";

import type { Clock, UuidGenerator } from "@family-todo/ports";

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class NodeUuidGenerator implements UuidGenerator {
  public generate(): string {
    return randomUUID();
  }
}
