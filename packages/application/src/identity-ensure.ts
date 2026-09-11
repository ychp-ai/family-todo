import { isIdentityEnsurePayload } from "@family-todo/contracts";
import type { IdentityEnsureData } from "@family-todo/contracts";
import { createUser } from "@family-todo/domain";
import type { Clock, IdentityStore, UuidGenerator } from "@family-todo/ports";

import { ApplicationError } from "./errors";
import type { ActionHandler } from "./router";

export class IdentityEnsureHandler implements ActionHandler {
  public readonly action = "identity.ensure";

  public constructor(
    private readonly resolveStore: () => Promise<IdentityStore>,
    private readonly clock: Clock,
    private readonly uuids: UuidGenerator,
  ) {}

  public async handle(payload: unknown): Promise<IdentityEnsureData> {
    if (!isIdentityEnsurePayload(payload)) {
      throw new ApplicationError("VALIDATION_ERROR", "身份初始化参数不正确。");
    }
    const store = await this.resolveStore();
    const user = await store.ensureUser(createUser(this.uuids.generate(), this.clock.now()));
    // 显式映射公开字段，不透传身份、数据库字段或后续新增的内部信息。
    return { user: { id: user.id, displayName: user.displayName, version: user.version } };
  }
}
