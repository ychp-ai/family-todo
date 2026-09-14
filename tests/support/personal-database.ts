import { isRecord } from "@family-todo/contracts";
import type { PersonalDatabase } from "../../packages/infra-cloudbase/src/personal-store";
import { MemoryIdentityDatabase } from "./identity-database";

class Condition {
  public constructor(public readonly matches: (value: unknown) => boolean) {}
  public and(other: unknown): Condition { if (!(other instanceof Condition)) throw new Error("Invalid test query"); return new Condition(v => this.matches(v) && other.matches(v)); }
}
class Query {
  public constructor(private readonly database: MemoryPersonalDatabase,private readonly name: string,private readonly filter: Record<string,unknown> = {},private readonly order = "_id",private readonly count = 100, private readonly direction: "asc" | "desc" = "asc") {}
  public where(filter: Record<string,unknown>): Query { return new Query(this.database,this.name,filter,this.order,this.count); }
  public orderBy(order: string, direction: "asc" | "desc"): Query { return new Query(this.database,this.name,this.filter,order,this.count,direction); }
  public limit(count: number): Query { return new Query(this.database,this.name,this.filter,this.order,count,this.direction); }
  public async get(): Promise<unknown> {
    const rows = [...this.database.documents.entries()].filter(([key,row]) => key.startsWith(this.name+"/") && Object.entries(this.filter).every(([field,value]) => value instanceof Condition ? value.matches(row[field]) : row[field] === value)).map(([,row]) => structuredClone(row));
    rows.sort((a,b) => (this.direction === "asc" ? 1 : -1) * String(a[this.order]).localeCompare(String(b[this.order])));
    return {data:rows.slice(0,this.count)};
  }
  public doc(id: string) {
    return {get:async () => ({data:structuredClone(this.database.documents.get(`${this.name}/${id}`) ?? null)}),set:async ({data}: {data: Record<string,unknown>}) => { if (!isRecord(data)) throw new Error("Invalid test data"); this.database.documents.set(`${this.name}/${id}`,{...structuredClone(data),_id:id}); }};
  }
}
export class MemoryPersonalDatabase extends MemoryIdentityDatabase implements PersonalDatabase {
  public command = {
    lt:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v < value),
    lte:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v <= value),
    gt:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v > value),
    in:(values: unknown[]) => new Condition(v => values.includes(v)),
    gte:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v >= value),
  };
  public collection(name: string): Query { return new Query(this,name); }
}
