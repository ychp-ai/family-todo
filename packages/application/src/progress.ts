import { instant, integer, isMemberProgress, isPersonalData, isPersonalPayload, isRecord, isUuid } from "@family-todo/contracts";
import type { MemberProgress, PersonalActionMap, ResolvedSubject } from "@family-todo/contracts";
import type { Clock, FamilyStore } from "@family-todo/ports";
import { ApplicationError } from "./errors";
import { OccurrenceLists } from "./occurrence-lists";
import { taskMissing } from "./task-context";

type Input = PersonalActionMap["progress.get"]["payload"];
type Output = PersonalActionMap["progress.get"]["data"];
type Binding = { actorId: string; fingerprint: string; familyVersion: number; revision: number; asOf: string; expiresAt: string };
type State = Binding & { kind: "progress"; root: string | null; listCursor: string | null; ready: boolean };
type Node = { members: MemberProgress[] } | { children: { key: string; token: string }[] };
const PAGE_SIZE = 20;
const LEAF_SIZE = 256;
function expired(): never { throw new ApplicationError("CURSOR_EXPIRED", "进度已更新，请重新加载。"); }
function unavailable(): never { throw new ApplicationError("TEMPORARILY_UNAVAILABLE", "进度暂时无法完整加载，请重试或选择具体执行人。", true); }
function key(subject: ResolvedSubject): string { return `${subject.kind}/${subject.kind === "user" ? subject.userId : subject.kind === "member" ? subject.membershipId : subject.virtualMemberId}`; }
function nullableToken(v: unknown): v is string | null { return v === null || typeof v === "string"; }
function readState(v: unknown): State {
  if (!isRecord(v) || v.kind !== "progress" || !isUuid(v.actorId) || typeof v.fingerprint !== "string" || !integer(v.familyVersion, 1) || !integer(v.revision, 1)
    || !instant(v.asOf) || !instant(v.expiresAt) || !nullableToken(v.root) || !nullableToken(v.listCursor) || typeof v.ready !== "boolean") expired();
  return { kind: "progress", actorId: v.actorId, fingerprint: v.fingerprint, familyVersion: v.familyVersion, revision: v.revision, asOf: v.asOf, expiresAt: v.expiresAt, root: v.root, listCursor: v.listCursor, ready: v.ready };
}
function sameBinding(v: Record<string, unknown>, b: Binding): boolean { return v.actorId === b.actorId && v.fingerprint === b.fingerprint && v.familyVersion === b.familyVersion && v.revision === b.revision && v.asOf === b.asOf && v.expiresAt === b.expiresAt; }
/** Persistent radix tree. Both leaf data and directory nodes are bounded; old cursor roots stay immutable. */
class Accumulator {
  public constructor(private readonly store: FamilyStore, private readonly binding: Binding) {}
  private async read(token: string): Promise<Node> {
    const v = await this.store.readSession(token);
    if (!v || v.kind !== "progress-node" || !sameBinding(v, this.binding)) expired();
    if (Array.isArray(v.members) && v.members.length <= LEAF_SIZE && v.members.every(isMemberProgress)) return { members: v.members };
    if (!Array.isArray(v.children) || v.children.length > 64) expired();
    const children: { key: string; token: string }[] = [];
    for (const child of v.children) { if (!isRecord(child) || typeof child.key !== "string" || child.key.length !== 1 || typeof child.token !== "string") expired(); children.push({ key: child.key, token: child.token }); }
    if (new Set(children.map(child => child.key)).size !== children.length) expired();
    return { children };
  }
  private save(node: Node): Promise<string> { return this.store.saveSession({ ...this.binding, kind: "progress-node", ...node }); }
  public async add(token: string | null, incoming: MemberProgress[], depth = 0): Promise<string | null> {
    if (incoming.length === 0) return token;
    const node = token ? await this.read(token) : { members: [] };
    if ("members" in node) {
      const members = new Map(node.members.map(member => [key(member.subject), member]));
      for (const value of incoming) {
        const previous = members.get(key(value.subject));
        if (previous) { previous.completed += value.completed; previous.pending += value.pending; previous.skipped += value.skipped; previous.denominator += value.denominator; }
        else members.set(key(value.subject), { ...value });
      }
      const values = [...members.values()].sort((a, b) => key(a.subject).localeCompare(key(b.subject)));
      if (values.length <= LEAF_SIZE) return this.save({ members: values });
      // Each subject has a finite exact kind/UUID key. Splitting never discards an old/inactive subject.
      const groups = new Map<string, MemberProgress[]>();
      for (const member of values) { const digit = key(member.subject)[depth]; if (!digit) throw new Error("Invalid progress radix collision."); const group = groups.get(digit) ?? []; group.push(member); groups.set(digit, group); }
      const children: { key: string; token: string }[] = [];
      for (const [digit, group] of groups) { const child = await this.add(null, group, depth + 1); if (child) children.push({ key: digit, token: child }); }
      return this.save({ children });
    }
    const children = new Map(node.children.map(child => [child.key, child.token])); const groups = new Map<string, MemberProgress[]>();
    for (const value of incoming) { const digit = key(value.subject)[depth]; if (!digit) throw new Error("Invalid progress radix key."); const group = groups.get(digit) ?? []; group.push(value); groups.set(digit, group); }
    for (const [digit, group] of groups) { const child = await this.add(children.get(digit) ?? null, group, depth + 1); if (child) children.set(digit, child); }
    return this.save({ children: [...children].map(([digit, child]) => ({ key: digit, token: child })) });
  }
  public async members(root: string | null): Promise<MemberProgress[]> {
    const result: MemberProgress[] = [];
    const visit = async (token: string): Promise<void> => {
      // The final API envelope is intentionally all-or-nothing. Never pretend a non-progressing final read is a continuation.
      if (this.store.remainingBudgetMs() < 3000) unavailable();
      const node = await this.read(token);
      if ("members" in node) result.push(...node.members);
      else for (const child of node.children) await visit(child.token);
    };
    if (root) await visit(root);
    return result.sort((a, b) => key(a.subject).localeCompare(key(b.subject)));
  }
}
export class ProgressService {
  public constructor(private readonly store: FamilyStore, private readonly clock: Clock) {}
  private async fence(input: Input, state?: State) {
    return this.store.transaction(async tx => {
      const actor = await tx.actor(); const scope = await tx.scope(actor.id);
      const family = await tx.family(input.familyId); const slot = await tx.slot(input.familyId, actor.id);
      const member = slot?.activeMembershipId ? await tx.member(slot.activeMembershipId) : null;
      if (!family || !member || member.status !== "active" || member.userId !== actor.id || member.familyId !== family.id) taskMissing();
      if (state && (actor.id !== state.actorId || family.version !== state.familyVersion || scope.revision !== state.revision)) expired();
      return { actorId: actor.id, familyVersion: family.version, revision: scope.revision };
    });
  }
  public async execute(payload: unknown): Promise<Output> {
    if (!isPersonalPayload("progress.get", payload)) throw new ApplicationError("VALIDATION_ERROR", "请选择家庭、日期和执行人。");
    const now = this.clock.now().toISOString();
    const fingerprint = this.store.fingerprint({ action: "progress.get", pageSize: PAGE_SIZE, familyId: payload.familyId, date: payload.date, subject: payload.subject });
    const start = await this.fence(payload);
    let state: State = { ...start, kind: "progress", fingerprint, asOf: now, expiresAt: new Date(Date.parse(now) + 900000).toISOString(), root: null, listCursor: null, ready: false };
    if (payload.cursor) {
      state = readState(await this.store.readSession(payload.cursor));
      if (state.fingerprint !== fingerprint || state.expiresAt <= now || state.actorId !== start.actorId || state.familyVersion !== start.familyVersion || state.revision !== start.revision) expired();
    }
    if (state.ready) {
      const members = await new Accumulator(this.store, state).members(state.root);
      await this.fence(payload, state);
      return { members, complete: true, nextCursor: null, asOf: state.asOf };
    }
    const page = await new OccurrenceLists(this.store, this.clock).execute("task.list", { familyId: payload.familyId, dateFrom: payload.date, dateTo: payload.date, limit: PAGE_SIZE, ...(state.listCursor ? { cursor: state.listCursor } : {}) }, payload.subject);
    if (!isPersonalData("task.list", page)) throw new Error("Invalid progress occurrence page.");
    if (page.scopes.some(scope => scope.status === "failed")) unavailable();
    // The first source call owns the frozen instant. Every later page must agree with it.
    if (state.listCursor && page.asOf !== state.asOf) expired();
    state.asOf = page.asOf;
    const changes: MemberProgress[] = page.items.map(({ occurrence }) => ({ subject: occurrence.subject, name: occurrence.subjectName, completed: occurrence.status === "completed" ? 1 : 0, pending: occurrence.status === "pending" ? 1 : 0, skipped: occurrence.status === "skipped" ? 1 : 0, denominator: occurrence.status === "skipped" ? 0 : 1 }));
    // A complete first page is bounded by PAGE_SIZE; no persisted tree is needed.
    if (!payload.cursor && page.complete && this.store.remainingBudgetMs() > 4000) {
      const totals = new Map<string, MemberProgress>();
      for (const value of changes) {
        const previous = totals.get(key(value.subject));
        if (previous) { previous.completed += value.completed; previous.pending += value.pending; previous.skipped += value.skipped; previous.denominator += value.denominator; }
        else totals.set(key(value.subject), { ...value });
      }
      await this.fence(payload, state);
      return { members: [...totals.values()].sort((a, b) => key(a.subject).localeCompare(key(b.subject))), complete: true, nextCursor: null, asOf: state.asOf };
    }
    state.root = await new Accumulator(this.store, state).add(state.root, changes);
    state.listCursor = page.nextCursor; state.ready = page.complete;
    await this.fence(payload, state);
    if (state.ready && !state.root) return { members: [], complete: true, nextCursor: null, asOf: state.asOf };
    // Publish completed aggregates before final materialization, giving that read a fresh invocation budget.
    const nextCursor = await this.store.saveSession({ ...state });
    return { members: null, complete: false, nextCursor, asOf: state.asOf };
  }
}
