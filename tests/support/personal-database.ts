import { isRecord } from "@family-todo/contracts";
import type { PersonalDatabase } from "../../packages/infra-cloudbase/src/personal-store";
import { MemoryIdentityDatabase } from "./identity-database";

class Condition {
  public constructor(public readonly matches: (value: unknown) => boolean) {}
  public and(other: unknown): Condition { if (!(other instanceof Condition)) throw new Error("Invalid test query"); return new Condition(v => this.matches(v) && other.matches(v)); }
}
class Query {
  public constructor(private readonly database: MemoryPersonalDatabase,private readonly name: string,private readonly filter: Record<string,unknown> = {},private readonly order = "_id",private readonly count = 100) {}
  public where(filter: Record<string,unknown>): Query { return new Query(this.database,this.name,filter,this.order,this.count); }
  public orderBy(order: string, direction: "asc" | "desc"): Query { if (direction !== "asc") throw new Error("Unsupported test order"); return new Query(this.database,this.name,this.filter,order,this.count); }
  public limit(count: number): Query { return new Query(this.database,this.name,this.filter,this.order,count); }
  public async get(): Promise<unknown> {
    const rows = [...this.database.documents.entries()].filter(([key,row]) => key.startsWith(this.name+"/") && Object.entries(this.filter).every(([field,value]) => value instanceof Condition ? value.matches(row[field]) : row[field] === value)).map(([,row]) => structuredClone(row));
    rows.sort((a,b) => String(a[this.order]).localeCompare(String(b[this.order])));
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
    gte:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v >= value),
  };
  public collection(name: string): Query { return new Query(this,name); }
}
