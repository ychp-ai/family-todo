import { isRecord } from "@family-todo/contracts";
import type { PersonalDatabase } from "../../packages/infra-cloudbase/src/personal-store";
import { MemoryIdentityDatabase } from "./identity-database";

class Condition {
  public constructor(public readonly matches: (value: unknown) => boolean) {}
  public and(other: unknown): Condition { if (!(other instanceof Condition)) throw new Error("Invalid test query"); return new Condition(v => this.matches(v) && other.matches(v)); }
}
class Query {
  public constructor(private readonly database: MemoryPersonalDatabase,private readonly name: string,private readonly filter: Record<string,unknown> = {},private readonly order = "_id",private readonly count = 100, private readonly direction: "asc" | "desc" = "asc", private readonly fields?: Record<string, boolean>) {}
  public where(filter: Record<string,unknown>): Query { return new Query(this.database,this.name,filter,this.order,this.count,this.direction,this.fields); }
  public orderBy(order: string, direction: "asc" | "desc"): Query { return new Query(this.database,this.name,this.filter,order,this.count,direction,this.fields); }
  public limit(count: number): Query { return new Query(this.database,this.name,this.filter,this.order,count,this.direction,this.fields); }
  public field(fields: Record<string, boolean>): Query { return new Query(this.database,this.name,this.filter,this.order,this.count,this.direction,fields); }
  public async get(): Promise<unknown> {
    const rows = [...this.database.documents.entries()].filter(([key,row]) => key.startsWith(this.name+"/") && Object.entries(this.filter).every(([field,value]) => value instanceof Condition ? value.matches(row[field]) : row[field] === value)).map(([,row]) => structuredClone(row));
    rows.sort((a,b) => (this.direction === "asc" ? 1 : -1) * String(a[this.order]).localeCompare(String(b[this.order])));
    const selected = rows.slice(0,this.count).map(row => this.fields ? Object.fromEntries(Object.entries(row).filter(([key]) => this.fields?.[key])) : row);
    this.database.queryRows.push({ collection: this.name, fields: this.fields, rows: structuredClone(selected) });
    return {data:selected};
  }
  public doc(id: string) {
    return {get:async () => ({data:structuredClone(this.database.documents.get(`${this.name}/${id}`) ?? null)}),set:async ({data}: {data: Record<string,unknown>}) => { if (!isRecord(data)) throw new Error("Invalid test data"); this.database.documents.set(`${this.name}/${id}`,{...structuredClone(data),_id:id}); }};
  }
}
export class MemoryPersonalDatabase extends MemoryIdentityDatabase implements PersonalDatabase {
  public queryRows: { collection: string; fields: Record<string, boolean> | undefined; rows: Record<string, unknown>[] }[] = [];
  public command = {
    lt:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v < value),
    lte:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v <= value),
    gt:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v > value),
    in:(values: unknown[]) => new Condition(v => values.includes(v)),
    gte:(value: unknown) => new Condition(v => typeof v === "string" && typeof value === "string" && v >= value),
  };
  public collection(name: string): Query { return new Query(this,name); }
}
