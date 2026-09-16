import type {
  AggregatePage,
  ConditionalInput,
  ConditionalPage,
  Page,
  ReminderDTO,
  ScopeResult,
  TaskSummaryDTO,
  TaskEventDTO,
  TaskListInput,
  TaskListItem,
} from "@family-todo/contracts";
import { personalApi, PersonalApi, PersonalApiError } from "./personal-api";
import type { ReadObserver } from "./personal-api";
import { ListCancelledError, ListContinuationError, ListMetricContext, listMetricsConfigured, metricRequest, startListMetric } from "./list-metrics";

type ActiveCheck = () => boolean;

/** Only publish a complete scan; an expired cursor discards all earlier pages. */
export async function collect<T, P extends Page<T>>(
  fetch: (cursor?: string) => Promise<P>,
  active: ActiveCheck = () => true,
  metric?: ListMetricContext,
): Promise<{ items: T[]; last: P }> {
  let items: T[] = [];
  let cursor: string | undefined;
  let restarted = false;
  const seen = new Set<string>();

  for (;;) {
    if (!active()) throw new ListCancelledError();
    let result: P;
    try {
      result = await fetch(cursor);
    } catch (error) {
      if (active() && !restarted && error instanceof PersonalApiError && error.code === "CURSOR_EXPIRED") {
        items = [];
        cursor = undefined;
        seen.clear();
        restarted = true;
        metric?.restart();
        continue;
      }
      throw error;
    }
    if (!active()) throw new ListCancelledError();
    metric?.page(result.items.length, !result.complete);
    items.push(...result.items);
    if (result.complete) return { items, last: result };
    if (!result.nextCursor || seen.has(result.nextCursor)) {
      throw new ListContinuationError("列表未完整加载，请重试。");
    }
    cursor = result.nextCursor;
    seen.add(cursor);
  }
}

/** Cache values are complete snapshots; serverTime is the latest authorization check. */
type Complete<T, P extends Page<T>> = { items: T[]; last: P };
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export class CompleteListCache {
  private readonly entries = new Map<string, unknown>();
  private epoch = 0;
  public constructor(private readonly api: PersonalApi) { api.onListsInvalidated(() => this.clear()); }
  public clear(): void { this.epoch++; this.entries.clear(); }
  public async read<T, P extends Page<T>>(
    action: string, input: unknown,
    fetch: (pagination: ConditionalInput & { cursor?: string }, observer?: ReadObserver) => Promise<ConditionalPage<P>>,
    active: ActiveCheck = () => true, forceFull = false, metric?: ListMetricContext,
  ): Promise<Complete<T, P>> {
    const epoch = this.epoch;
    const context = this.api.recoveryContext, generation = this.api.recoveryGeneration, revision = this.api.readRevision;
    const current = () => active() && epoch === this.epoch && context === this.api.recoveryContext && generation === this.api.recoveryGeneration && revision === this.api.readRevision;
    const key = JSON.stringify({ context, generation, revision, action, input }, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    // Private map contents were installed only by this generic action+representation key.
    const cached = context && !forceFull ? this.entries.get(key) as Complete<T, P> | undefined : undefined;
    let first = true;
    let reused: Complete<T, P> | undefined;
    try {
      const result = await collect<T, P>(async cursor => {
        const candidate = first ? cached : undefined; first = false;
        const pagination = { conditional: candidate?.last.cache ? { token: candidate.last.cache.token } : {}, ...(cursor ? { cursor } : {}) };
        let response = await metricRequest(metric, observer => observer ? fetch(pagination, observer) : fetch(pagination));
        if (!current()) throw new ListCancelledError();
        if ("unchanged" in response) {
          if (current() && candidate?.last.cache?.token === response.token && this.entries.get(key) === candidate) {
            metric?.setSource("unchanged");
            reused = clone(candidate); reused.last.serverTime = response.serverTime;
            metric?.skipNextPage();
            return { ...reused.last, items: reused.items };
          }
          // One unconditional fallback, including a spurious unchanged without a snapshot.
          metric?.setSource("no-cache-fallback");
          response = await metricRequest(metric, observer => observer ? fetch({ conditional: {} }, observer) : fetch({ conditional: {} }));
          if ("unchanged" in response) throw new PersonalApiError("INVALID_RESPONSE", "完整列表已失效，请重试。", true);
        }
        return response;
      }, current, metric);
      if (!current()) throw new ListCancelledError();
      const value = reused ?? result;
      const scopes = "scopes" in value.last ? value.last.scopes : undefined;
      const allOk = scopes === undefined || (Array.isArray(scopes) && scopes.every(scope => typeof scope === "object" && scope !== null && "status" in scope && scope.status === "ok"));
      if (context && value.last.cache && allOk) {
        this.entries.delete(key);
        // Bound both entry count and retained result size (rough UTF-16 bytes).
        if (JSON.stringify(value).length <= 512000) this.entries.set(key, clone(value));
        while (this.entries.size > 12) { const oldest = this.entries.keys().next().value; if (oldest === undefined) break; this.entries.delete(oldest); }
      } else this.entries.delete(key);
      metric?.finish(allOk ? "success" : "partial");
      return value;
    } catch (error) { this.entries.delete(key); metric?.finishError(error); throw error; }
  }
}
export const completeLists = new CompleteListCache(personalApi);

export function authorizedItems<T>(
  items: T[],
  scopes: ScopeResult[],
  family: (item: T) => string | null,
): T[] {
  const authorizedFamilies = new Set(scopes.filter(scope => scope.status === "ok").map(scope => scope.familyId));
  return items.filter(item => authorizedFamilies.has(family(item)));
}

export type MetricArgument = ListMetricContext | false | undefined;
function operationMetric(action: "task.list" | "reminder.list" | "task.recycleList" | "task.history", supplied: MetricArgument): ListMetricContext | undefined {
  if (supplied === false || !listMetricsConfigured()) return supplied || undefined;
  return supplied ?? startListMetric(action);
}

export async function listTasks(input: TaskListInput, active?: ActiveCheck, forceFull = false, suppliedMetric?: MetricArgument) {
  const metric = operationMetric("task.list", suppliedMetric);
  const result = await completeLists.read<TaskListItem, AggregatePage<TaskListItem>>("task.list", input,
    (pagination, observer) => { const payload = { ...input, view: "summary" as const, limit: 50, ...pagination }; return observer ? personalApi.read("task.list", payload, observer) : personalApi.read("task.list", payload); },
    active, forceFull, metric,
  );
  return {
    ...result,
    items: authorizedItems(result.items, result.last.scopes, item => item.task.familyId),
  };
}

export async function listReminders(includeDismissed = false, active?: ActiveCheck, forceFull = false, suppliedMetric?: MetricArgument) {
  const metric = operationMetric("reminder.list", suppliedMetric);
  const result = await completeLists.read<ReminderDTO, AggregatePage<ReminderDTO>>("reminder.list", { includeDismissed },
    (pagination, observer) => { const payload = { includeDismissed, limit: 50, ...pagination }; return observer ? personalApi.read("reminder.list", payload, observer) : personalApi.read("reminder.list", payload); },
    active, forceFull, metric,
  );
  return {
    ...result,
    items: authorizedItems(result.items, result.last.scopes, item => item.familyId),
  };
}

export async function listRecycle(familyId?: string | null) {
  const metric = operationMetric("task.recycleList", undefined);
  try {
    const result = await collect<TaskSummaryDTO, Page<TaskSummaryDTO>>(cursor => metricRequest(metric, observer => {
      const payload = { ...(familyId === undefined ? {} : { familyId }), view: "summary" as const, limit: 50, ...(cursor ? { cursor } : {}) };
      return observer ? personalApi.read("task.recycleList", payload, observer) : personalApi.read("task.recycleList", payload);
    }), undefined, metric);
    metric?.finish("success"); return result;
  } catch (error) { metric?.finishError(error); throw error; }
}

export async function listHistory(taskId: string, active?: ActiveCheck) {
  const metric = operationMetric("task.history", undefined);
  try {
    const result = await collect<TaskEventDTO, Page<TaskEventDTO>>(
      cursor => metricRequest(metric, observer => {
        const payload = { taskId, limit: 50, ...(cursor ? { cursor } : {}) };
        return observer ? personalApi.read("task.history", payload, observer) : personalApi.read("task.history", payload);
      }), active, metric,
    );
    metric?.finish("success"); return result;
  } catch (error) { metric?.finishError(error); throw error; }
}
