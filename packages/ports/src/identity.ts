import type { User } from "@family-todo/domain";

/** 每次调用绑定可信平台身份；原始身份不能进入应用层。 */
export interface IdentityStore {
  /** 原子读取或创建映射、用户及容量文档；重试和并发返回同一个应用用户。 */
  ensureUser(candidate: User): Promise<User>;
}
