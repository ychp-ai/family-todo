import { createRequestId } from "./request-id";
import type { ReadObserver } from "./personal-api";

export const LIST_METRIC_ACTIONS = [
  "home.refresh", "family.list", "task.list", "reminder.list", "progress.get",
  "task.recycleList", "task.history", "virtualMember.list",
] as const;
export type ListMetricAction = typeof LIST_METRIC_ACTIONS[number];
export type ListMetricSource = "full" | "unchanged" | "cache" | "no-cache-fallback";
export type ListMetricResult = "success" | "partial" | "cancelled" | "error";
export type ListMetricError = "none" | "cursor-expired" | "invalid-continuation" | "api" | "unknown";

export type ListMetricRecord = Readonly<{
  kind: "client.logical-list";
  schemaVersion: 1;
  operationId: string;
  parentOperationId?: string;
  childOperationIds: readonly string[];
  action: ListMetricAction;
  source: ListMetricSource;
  result: ListMetricResult;
  complete: boolean;
  error: ListMetricError;
  attempts: number;
  pages: number;
  emptyContinuationPages: number;
  continuationPages: number;
  restarts: number;
  itemCount: number;
  memberCount: number;
  rpcCumulativeMs: number;
  wallClockMs: number;
  requestLinksComplete: boolean;
  droppedRequestLinks: number;
  missingChildOperationIds: number;
  requests: readonly Readonly<{requestId: string; reusedInFlight: boolean}>[];
}>;

export type ListMetricConfiguration = Readonly<{
  sampleRate: number;
  sink: (record: ListMetricRecord) => void | Promise<void>;
  clock?: () => number;
  random?: () => number;
  createOperationId?: () => Promise<string>;
}>;

let configuration: ListMetricConfiguration | null = null;

/** Process-local diagnostics only. Passing null restores the default-off path. */
export function configureListMetrics(value: ListMetricConfiguration | null): void {
  if (value && (!Number.isFinite(value.sampleRate) || value.sampleRate < 0 || value.sampleRate > 1)) throw new Error("列表观测采样率必须在 0 到 1 之间。");
  configuration = value;
}

/** Lets default-off callers retain their original synchronous request dispatch. */
export function listMetricsConfigured(): boolean { return configuration !== null && configuration.sampleRate > 0; }

export class ListCancelledError extends Error {
  public constructor() { super("已切换查看范围。"); this.name = "ListCancelledError"; }
}

export class ListContinuationError extends Error {
  public constructor(message: string) { super(message); this.name = "ListContinuationError"; }
}

function fixedError(error: unknown): ListMetricError {
  if (error instanceof ListCancelledError) return "none";
  if (error instanceof ListContinuationError) return "invalid-continuation";
  if (typeof error === "object" && error !== null && "code" in error) return error.code === "CURSOR_EXPIRED" ? "cursor-expired" : "api";
  return "unknown";
}

export class ListMetricContext {
  private static readonly REQUEST_LINK_LIMIT = 256;
  private readonly startedAt: number;
  private readonly requestsById = new Map<string, boolean>();
  private readonly children: ListMetricContext[] = [];
  private sourceValue: ListMetricSource = "full";
  private attemptsValue = 0;
  private pagesValue = 0;
  private emptyContinuationPagesValue = 0;
  private continuationPagesValue = 0;
  private restartsValue = 0;
  private itemCountValue = 0;
  private memberCountValue = 0;
  private rpcCumulativeMsValue = 0;
  private skippedPages = 0;
  private droppedRequestLinksValue = 0;
  private pendingRequests = 0;
  private started = false;
  private finished = false;
  private businessSettled = false;
  private businessSettledAt: number | undefined;
  private emissionStarted = false;
  private finishResult: ListMetricResult = "cancelled";
  private finishCause: unknown;
  private readonly operationIdPromise: Promise<string | undefined>;
  private operationIdReady = false;
  private operationIdValue: string | undefined;

  public constructor(
    public readonly action: ListMetricAction,
    private readonly options: Required<Pick<ListMetricConfiguration, "clock" | "createOperationId">> & Pick<ListMetricConfiguration, "sink">,
    private readonly parent?: ListMetricContext,
  ) {
    this.startedAt = options.clock();
    try {
      this.operationIdPromise = Promise.resolve(options.createOperationId()).then(
        value => { this.operationIdReady = true; this.operationIdValue = value || undefined; return this.operationIdValue; },
        () => { this.operationIdReady = true; return undefined; },
      );
    } catch { this.operationIdReady = true; this.operationIdPromise = Promise.resolve(undefined); }
  }

  public child(action: ListMetricAction): ListMetricContext | undefined {
    if (this.finished) return undefined;
    const child = new ListMetricContext(action, this.options, this);
    this.children.push(child);
    return child;
  }

  public setSource(source: ListMetricSource): void { if (!this.finished) this.sourceValue = source; }
  /** A conditional unchanged response is an authorization check, not a list page. */
  public skipNextPage(): void { if (!this.finished) this.skippedPages++; }
  public page(count: number, hasContinuation: boolean, kind: "items" | "members" = "items"): void {
    if (this.finished) return;
    if (this.skippedPages > 0) { this.skippedPages--; return; }
    this.pagesValue++;
    if (kind === "members") {
      if (hasContinuation) this.continuationPagesValue++;
      this.memberCountValue += count;
    } else {
      if (hasContinuation && count === 0) this.emptyContinuationPagesValue++;
      this.itemCountValue += count;
    }
  }
  public restart(): void { if (!this.finished) this.restartsValue++; }

  public async request<T>(read: (observer: ReadObserver) => Promise<T>): Promise<T> {
    if (this.finished) return read(() => undefined);
    this.started = true;
    this.attemptsValue++;
    this.pendingRequests++;
    const startedAt = this.options.clock();
    try {
      return await read(event => {
        const previous = this.requestsById.get(event.requestId);
        if (previous !== undefined) this.requestsById.set(event.requestId, previous || event.reusedInFlight);
        else if (this.requestsById.size < ListMetricContext.REQUEST_LINK_LIMIT) this.requestsById.set(event.requestId, event.reusedInFlight);
        else this.droppedRequestLinksValue++;
      });
    } finally {
      this.rpcCumulativeMsValue += Math.max(0, this.options.clock() - startedAt);
      this.pendingRequests--;
      this.settleBusinessWhenReady();
    }
  }

  public finish(result: ListMetricResult, cause?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.finishResult = result;
    this.finishCause = cause;
    // A parent may finish while a sibling list is still paging. Only close children
    // whose business operation never started; started children settle themselves.
    for (const child of this.children) if (!child.started && !child.finished) child.finish("cancelled");
    this.settleBusinessWhenReady();
  }

  private settleBusinessWhenReady(): void {
    if (!this.finished || this.businessSettled || this.pendingRequests > 0 || this.children.some(child => !child.businessSettled)) return;
    this.businessSettled = true;
    this.businessSettledAt = this.options.clock();
    this.parent?.settleBusinessWhenReady();
    this.emitWhenIdsReady();
  }

  private emitWhenIdsReady(): void {
    if (!this.businessSettled || this.emissionStarted) return;
    this.emissionStarted = true;
    const related = [this, ...(this.parent ? [this.parent] : []), ...this.children];
    if (related.every(context => context.operationIdReady)) this.emit();
    else void Promise.all(related.map(context => context.operationIdPromise)).then(() => this.emit());
  }

  private emit(): void {
    const businessSettledAt = this.businessSettledAt;
    if (businessSettledAt === undefined) return;
    const operationId = this.operationIdValue;
    const parentOperationId = this.parent?.operationIdValue;
    const childOperationIds = this.children.map(child => child.operationIdValue).filter((value): value is string => value !== undefined);
    const missingChildOperationIds = this.children.length - childOperationIds.length;
    if (!operationId || (this.parent && !parentOperationId)) return;
    const record: ListMetricRecord = Object.freeze({
      kind: "client.logical-list", schemaVersion: 1, operationId,
      ...(parentOperationId ? {parentOperationId} : {}),
      childOperationIds: Object.freeze(childOperationIds),
      action: this.action, source: this.sourceValue, result: this.finishResult, complete: this.finishResult !== "cancelled",
      error: this.finishResult === "error" ? fixedError(this.finishCause) : "none",
      attempts: this.attemptsValue, pages: this.pagesValue, emptyContinuationPages: this.emptyContinuationPagesValue,
      continuationPages: this.continuationPagesValue,
      restarts: this.restartsValue, itemCount: this.itemCountValue, memberCount: this.memberCountValue,
      rpcCumulativeMs: this.rpcCumulativeMsValue, wallClockMs: Math.max(0, businessSettledAt - this.startedAt),
      requestLinksComplete: this.droppedRequestLinksValue === 0 && missingChildOperationIds === 0,
      droppedRequestLinks: this.droppedRequestLinksValue,
      missingChildOperationIds,
      requests: Object.freeze([...this.requestsById].map(([requestId, reusedInFlight]) => Object.freeze({requestId, reusedInFlight}))),
    });
    try { void Promise.resolve(this.options.sink(record)).catch(() => undefined); } catch { /* Diagnostics cannot change business results. */ }
  }

  public finishError(error: unknown): void { this.finish(error instanceof ListCancelledError ? "cancelled" : "error", error); }
}

export function startListMetric(action: ListMetricAction): ListMetricContext | undefined {
  const selected = configuration;
  if (!selected || selected.sampleRate === 0) return undefined;
  try { if ((selected.random ?? Math.random)() >= selected.sampleRate) return undefined; }
  catch { return undefined; }
  const options = {sink:selected.sink, clock:selected.clock ?? Date.now, createOperationId:selected.createOperationId ?? createRequestId};
  return new ListMetricContext(action, options);
}

export async function metricRequest<T>(metric: ListMetricContext | undefined, read: (observer?: ReadObserver) => Promise<T>): Promise<T> {
  return metric ? metric.request(observer => read(observer)) : read();
}
