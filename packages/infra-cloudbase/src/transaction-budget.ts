import type { IdentityTransaction } from "./identity-store";

export function budgetTransaction(tx: IdentityTransaction, budget: () => void): IdentityTransaction {
  let operations = 0;
  const cache = new Map<string, unknown>();
  function count() { budget(); if (++operations > 80) throw new Error("Transaction document budget exceeded."); }
  return { collection(name) { return { doc(id) { const doc = tx.collection(name).doc(id); return {
    async get() {
      budget(); const key = `${name}/${id}`; if (cache.has(key)) return structuredClone(cache.get(key));
      count(); const value = await doc.get(); budget(); cache.set(key, structuredClone(value)); return value;
    }, async set(options) {
      count(); const value = await doc.set(options); budget(); cache.set(`${name}/${id}`, { data: { ...structuredClone(options.data), _id: id } }); return value;
    }
  }; } }; } };
}
