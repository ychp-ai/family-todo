import { formatUtcInstant } from "./time";

export type Actor = { readonly userId: string };
export type User = {
  readonly id: string;
  readonly displayName: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export function createUser(id: string, now: Date): User {
  const instant = formatUtcInstant(now);
  return { id, displayName: "我", version: 1, createdAt: instant, updatedAt: instant };
}
