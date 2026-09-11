import type { User } from "@family-todo/domain";
import type { IdentityDatabase, IdentityTransaction } from "../../packages/infra-cloudbase/src/identity-store";

/** 本地事务模拟：快照、原子提交、冲突重试；不代表 CloudBase 真实隔离验证。 */
export class MemoryIdentityDatabase implements IdentityDatabase {
  public documents = new Map<string, Record<string, unknown>>();
  public failCollection: string | null = null;
  public conflicts = 0;
  private revision = 0;

  public async runTransaction(work: (transaction: IdentityTransaction) => Promise<User>, retries: number): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const revision = this.revision;
      const snapshot = structuredClone(this.documents);
      let changed = false;
      const transaction: IdentityTransaction = {
        collection: (name) => ({ doc: (id) => ({
          get: async () => ({ data: structuredClone(snapshot.get(`${name}/${id}`) ?? null) }),
          set: async ({ data }) => {
            if (this.failCollection === name) throw new Error("SECRET: database write failed");
            snapshot.set(`${name}/${id}`, { ...structuredClone(data), _id: id });
            changed = true;
            return { errMsg: "set:ok" };
          },
        }) }),
      };
      const result = await work(transaction);
      if (revision !== this.revision) {
        this.conflicts += 1;
        if (attempt >= retries) throw new Error("Transaction conflict.");
        continue;
      }
      if (changed) {
        this.documents = snapshot;
        this.revision += 1;
      }
      return result;
    }
  }
}
