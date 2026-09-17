import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ConditionalInput, ConditionalPage, Page } from "@family-todo/contracts";
import { AppApiClient } from "./app-api-client";
import {
  configureListMetrics,
  ListCancelledError,
  metricRequest,
  startListMetric,
} from "./list-metrics";
import type { ListMetricRecord } from "./list-metrics";
import { collect, CompleteListCache } from "./personal-lists";
import { PersonalApi, PersonalApiError } from "./personal-api";
import { familyApi, listFamilies } from "./family-api";

afterEach(() => configureListMetrics(null));

function recorder(clock: () => number = () => 0) {
  const records: ListMetricRecord[] = [];
  let id = 0;
  configureListMetrics({ sampleRate: 1, sink: record => { records.push(record); }, clock, random: () => 0, createOperationId: async () => `operation-${++id}` });
  return records;
}

describe("logical list metric contexts", () => {
  it("does zero observable work when disabled or sampled out", async () => {
    const sink = vi.fn(), random = vi.fn(() => 0), createOperationId = vi.fn(async () => "operation");
    configureListMetrics({ sampleRate: 0, sink, random, createOperationId });
    expect(await startListMetric("task.list")).toBeUndefined();
    expect(random).not.toHaveBeenCalled();
    expect(createOperationId).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    configureListMetrics(null);
    expect(await startListMetric("task.list")).toBeUndefined();
  });

  it("does not wait for diagnostic IDs or change public-helper coalescing", async () => {
    const page = {items:[],complete:true,nextCursor:null,asOf:"2026-09-16T00:00:00.000Z"};
    let physical = 0, inFlight: Promise<typeof page> | undefined;
    vi.spyOn(familyApi,"read").mockImplementation(((_action:string,_payload:unknown,observer?: (event:{requestId:string;reusedInFlight:boolean})=>void) => {
      if (inFlight) { observer?.({requestId:"physical",reusedInFlight:true}); return inFlight; }
      physical++; observer?.({requestId:"physical",reusedInFlight:false});
      const request = Promise.resolve(page).finally(()=>{if(inFlight===request)inFlight=undefined;});
      inFlight=request;return request;
    }) as typeof familyApi.read);

    const disabledA=listFamilies(true),disabledB=listFamilies(true);
    expect(physical).toBe(1);
    await Promise.all([disabledA,disabledB]);

    physical=0;inFlight=undefined;
    const releases:((value:string)=>void)[]=[],records:ListMetricRecord[]=[];
    configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:()=>new Promise(resolve=>{releases.push(resolve);})});
    const enabledA=listFamilies(true),enabledB=listFamilies(true);
    expect(physical).toBe(1);
    expect(releases).toHaveLength(2);
    releases.forEach((release,index)=>release(`operation-${index}`));
    await Promise.all([enabledA,enabledB]);
    await vi.waitFor(()=>expect(records).toHaveLength(2));
    expect(records.map(record=>record.requests[0])).toEqual([
      {requestId:"physical",reusedInFlight:false},
      {requestId:"physical",reusedInFlight:true},
    ]);
  });

  it("keeps page, empty-page, restart and request counters through a final failure", async () => {
    const records = recorder();
    const metric = await startListMetric("task.list");
    let call = 0;
    const scan = collect<string, Page<string>>(cursor => metricRequest(metric, async observer => {
      call++;
      observer?.({ requestId: `request-${call}`, reusedInFlight: false });
      if (call === 1) return { items: [], complete: false, nextCursor: "expired", asOf: "2026-09-16T00:00:00.000Z" };
      if (call === 2 || call === 4) throw new PersonalApiError("CURSOR_EXPIRED", "expired", false);
      expect(cursor).toBeUndefined();
      return { items: ["fresh"], complete: false, nextCursor: "expires-again", asOf: "2026-09-16T00:00:00.000Z" };
    }), undefined, metric);
    const error = await scan.catch(value => value);
    metric?.finishError(error);
    expect(error).toMatchObject({ code: "CURSOR_EXPIRED" });
    expect(records).toEqual([expect.objectContaining({
      action: "task.list", result: "error", error: "cursor-expired", attempts: 4,
      pages: 2, emptyContinuationPages: 1, restarts: 1, itemCount: 1,
    })]);
    expect(records[0]?.requests).toHaveLength(4);
  });

  it("counts successful multi-page scans and rejects repeated continuations", async () => {
    const records = recorder();
    const success = await startListMetric("task.list");
    let successPage = 0;
    await collect<string, Page<string>>(async () => ++successPage === 1
      ? {items:[],complete:false,nextCursor:"next",asOf:"2026-09-16T00:00:00.000Z"}
      : {items:["one"],complete:true,nextCursor:null,asOf:"2026-09-16T00:00:00.000Z"}, undefined, success);
    success?.finish("success");

    const repeated = await startListMetric("reminder.list");
    const failed = collect<string, Page<string>>(async () => ({items:[],complete:false,nextCursor:"same",asOf:"2026-09-16T00:00:00.000Z"}), undefined, repeated);
    const error = await failed.catch(value=>value); repeated?.finishError(error);

    expect(records[0]).toMatchObject({result:"success",pages:2,emptyContinuationPages:1,itemCount:1});
    expect(records[1]).toMatchObject({result:"error",error:"invalid-continuation",pages:2,emptyContinuationPages:2});
  });

  it("keeps concurrent operations isolated and classifies cancellation", async () => {
    const records = recorder();
    const first = await startListMetric("task.list"), second = await startListMetric("reminder.list");
    first?.page(2, true); second?.page(7, false);
    first?.finish("success"); second?.finish("partial");
    let active = true;
    const cancelled = await startListMetric("family.list");
    const scan = collect<string, Page<string>>(async () => {
      active = false;
      return { items: ["private-canary"], complete: true, nextCursor: null, asOf: "2026-09-16T00:00:00.000Z" };
    }, () => active, cancelled);
    const error = await scan.catch(value => value);
    cancelled?.finishError(error);
    expect(error).toBeInstanceOf(ListCancelledError);
    expect(records.map(record => [record.action, record.itemCount, record.result])).toEqual([
      ["task.list", 2, "success"], ["reminder.list", 7, "partial"], ["family.list", 0, "cancelled"],
    ]);
    expect(JSON.stringify(records)).not.toContain("private-canary");
  });

  it("measures cumulative overlapping RPC time independently from wall time", async () => {
    let now = 0, releaseFirst: (() => void) | undefined, releaseSecond: (() => void) | undefined;
    const records = recorder(() => now);
    const metric = await startListMetric("task.list");
    const first = metricRequest(metric, observer => { observer?.({requestId:"first",reusedInFlight:false}); return new Promise<void>(resolve => { releaseFirst = resolve; }); });
    const second = metricRequest(metric, observer => { observer?.({requestId:"second",reusedInFlight:false}); return new Promise<void>(resolve => { releaseSecond = resolve; }); });
    now = 10; releaseFirst?.(); await first;
    now = 20; releaseSecond?.(); await second;
    metric?.finish("success");
    expect(records[0]).toMatchObject({ attempts: 2, rpcCumulativeMs: 30, wallClockMs: 20 });
  });

  it("freezes standalone wall time before a deferred diagnostic ID resolves", async () => {
    let now = 0;
    let releaseId: ((value: string) => void) | undefined;
    const records: ListMetricRecord[] = [];
    configureListMetrics({
      sampleRate: 1,
      sink: record => { records.push(record); },
      clock: () => now,
      createOperationId: () => new Promise(resolve => { releaseId = resolve; }),
    });

    const metric = startListMetric("task.list");
    now = 10;
    metric?.finish("success");
    expect(records).toEqual([]);

    now = 1_000;
    releaseId?.("standalone");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ operationId: "standalone", wallClockMs: 10 });
  });

  it("freezes parent and child wall time at business settlement before linked IDs resolve", async () => {
    let now = 0;
    const releaseIds: Array<(value: string) => void> = [];
    const records: ListMetricRecord[] = [];
    configureListMetrics({
      sampleRate: 1,
      sink: record => { records.push(record); },
      clock: () => now,
      createOperationId: () => new Promise(resolve => { releaseIds.push(resolve); }),
    });

    const parent = startListMetric("home.refresh");
    const child = parent?.child("task.list");
    let releaseRequest: (() => void) | undefined;
    const request = metricRequest(child, () => new Promise<void>(resolve => { releaseRequest = resolve; }));
    now = 10;
    parent?.finish("success");
    now = 20;
    releaseRequest?.();
    await request;
    child?.finish("success");

    now = 100;
    releaseIds[0]?.("parent");
    await Promise.resolve();
    expect(records).toEqual([]);
    now = 1_000;
    releaseIds[1]?.("child");
    await vi.waitFor(() => expect(records).toHaveLength(2));

    expect(records.find(record => record.action === "home.refresh")).toMatchObject({
      operationId: "parent", childOperationIds: ["child"], wallClockMs: 20,
    });
    expect(records.find(record => record.action === "task.list")).toMatchObject({
      operationId: "child", parentOperationId: "parent", wallClockMs: 20,
    });
  });

  it.each([
    ["rejected", () => Promise.reject(new Error("diagnostic ID unavailable"))],
    ["empty", async () => ""],
  ])("keeps a parent incomplete when one started child ID is %s", async (_case, failedId) => {
    const records: ListMetricRecord[] = [];
    const createOperationId = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("parent")
      .mockResolvedValueOnce("family")
      .mockImplementationOnce(failedId)
      .mockResolvedValueOnce("reminder");
    configureListMetrics({
      sampleRate: 1,
      sink: record => { records.push(record); },
      createOperationId,
    });

    const parent = startListMetric("home.refresh");
    const family = parent?.child("family.list");
    const task = parent?.child("task.list");
    const reminder = parent?.child("reminder.list");
    const business = await Promise.all([
      metricRequest(family, async observer => { observer?.({requestId:"family-request",reusedInFlight:false}); return "family-result"; }),
      metricRequest(task, async observer => { observer?.({requestId:"task-request",reusedInFlight:false}); return "task-result"; }),
      metricRequest(reminder, async observer => { observer?.({requestId:"reminder-request",reusedInFlight:false}); return "reminder-result"; }),
    ]);
    family?.finish("success");
    task?.finish("success");
    reminder?.finish("success");
    parent?.finish("success");

    expect(business).toEqual(["family-result", "task-result", "reminder-result"]);
    await vi.waitFor(() => expect(records).toHaveLength(3));
    expect(records.find(record => record.operationId === "parent")).toMatchObject({
      childOperationIds: ["family", "reminder"],
      requestLinksComplete: false,
      missingChildOperationIds: 1,
    });
    expect(records.filter(record => record.parentOperationId === "parent")).toEqual([
      expect.objectContaining({operationId:"family",requestLinksComplete:true,missingChildOperationIds:0}),
      expect.objectContaining({operationId:"reminder",requestLinksComplete:true,missingChildOperationIds:0}),
    ]);
  });

  it("includes an already-started cancelled RPC but excludes deferred ID wait from wall time", async () => {
    let now = 0;
    let releaseId: ((value: string) => void) | undefined;
    let releaseRequest: (() => void) | undefined;
    const records: ListMetricRecord[] = [];
    configureListMetrics({
      sampleRate: 1,
      sink: record => { records.push(record); },
      clock: () => now,
      createOperationId: () => new Promise(resolve => { releaseId = resolve; }),
    });

    const metric = startListMetric("task.list");
    const request = metricRequest(metric, () => new Promise<void>(resolve => { releaseRequest = resolve; }));
    now = 10;
    metric?.finish("cancelled");
    now = 25;
    releaseRequest?.();
    await request;
    expect(records).toEqual([]);

    now = 1_000;
    releaseId?.("cancelled");
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      operationId: "cancelled", result: "cancelled", rpcCumulativeMs: 25, wallClockMs: 25,
    });
  });

  it("waits for in-flight observers before emitting a cancelled operation", async () => {
    let now = 0, release: (() => void) | undefined;
    const records = recorder(() => now);
    const metric = await startListMetric("task.list");
    const request = metricRequest(metric, async observer => {
      await new Promise<void>(resolve => { release = resolve; });
      observer?.({requestId:"late-real-request",reusedInFlight:false});
    });
    metric?.finish("cancelled");
    expect(records).toEqual([]);
    now = 25; release?.(); await request;
    expect(records).toEqual([expect.objectContaining({
      result:"cancelled", complete:false, attempts:1, rpcCumulativeMs:25,
      requests:[{requestId:"late-real-request",reusedInFlight:false}],
    })]);
  });

  it("bounds request links and marks the record incomplete for offline joining", async () => {
    const records = recorder();
    const metric = await startListMetric("task.list");
    for (let index = 0; index < 260; index++) {
      await metricRequest(metric, async observer => { observer?.({requestId:`request-${index}`,reusedInFlight:false}); });
    }
    metric?.finish("success");
    expect(records[0]).toMatchObject({attempts:260,requestLinksComplete:false,droppedRequestLinks:4});
    expect(records[0]?.requests).toHaveLength(256);
  });

  it("links coalesced consumers to the same real request ID without changing coalescing", async () => {
    const records = recorder();
    const requests: ApiRequest[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api = new PersonalApi(new AppApiClient({ send: async request => {
      requests.push(request); await gate;
      return { ok: true, requestId: request.requestId, data: { items: [], complete: true, nextCursor: null, asOf: "2026-09-16T00:00:00.000Z" } };
    } }), async () => randomUUID());
    const first = await startListMetric("family.list"), second = await startListMetric("family.list");
    const a = metricRequest(first, observer => api.read("family.list", {}, observer));
    const b = metricRequest(second, observer => api.read("family.list", {}, observer));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    release?.(); await Promise.all([a, b]);
    first?.finish("success"); second?.finish("success");
    expect(records[0]?.requests).toEqual([{ requestId: requests[0]?.requestId, reusedInFlight: false }]);
    expect(records[1]?.requests).toEqual([{ requestId: requests[0]?.requestId, reusedInFlight: true }]);
  });

  it("isolates synchronous and asynchronous sink failures", async () => {
    configureListMetrics({ sampleRate: 1, sink: () => { throw new Error("sink failed"); }, createOperationId: async () => "sync" });
    const sync = await startListMetric("task.list");
    expect(() => sync?.finish("success")).not.toThrow();
    configureListMetrics({ sampleRate: 1, sink: async () => { throw new Error("sink failed"); }, createOperationId: async () => "async" });
    const asyncSink = await startListMetric("task.list");
    expect(() => asyncSink?.finish("success")).not.toThrow();
    await Promise.resolve();
  });
});

describe("conditional complete-list metric sources", () => {
  const asOf = "2026-09-16T00:00:00.000Z";
  const page = (items: string[], token: string): Page<string> => ({ items, complete: true, nextCursor: null, asOf, serverTime: asOf, cache: { token, nextInvalidationAt: asOf, expiresAt: asOf } });

  it("separates full, unchanged, and no-cache fallback paths", async () => {
    const records = recorder();
    const api = new PersonalApi(); api.bindRecovery("env", randomUUID());
    const cache = new CompleteListCache(api);
    const responses: ConditionalPage<Page<string>>[] = [page(["one"], "token"), { unchanged: true, token: "token", serverTime: asOf }];
    const fetch = vi.fn(async (_input: ConditionalInput & {cursor?: string}) => responses.shift() ?? page(["fallback"], "fallback"));
    const full = await startListMetric("task.list");
    await cache.read<string, Page<string>>("task.list", {}, fetch, undefined, false, full);
    const unchanged = await startListMetric("task.list");
    await cache.read<string, Page<string>>("task.list", {}, fetch, undefined, false, unchanged);

    const freshCache = new CompleteListCache(api);
    const fallbackFetch = vi.fn()
      .mockResolvedValueOnce({ unchanged: true, token: "orphan", serverTime: asOf })
      .mockResolvedValueOnce(page(["fallback"], "fallback"));
    const fallback = await startListMetric("task.list");
    await freshCache.read<string, Page<string>>("task.list", {}, fallbackFetch, undefined, false, fallback);

    expect(records.map(record => ({source:record.source, attempts:record.attempts, pages:record.pages, items:record.itemCount}))).toEqual([
      { source: "full", attempts: 1, pages: 1, items: 1 },
      { source: "unchanged", attempts: 1, pages: 0, items: 0 },
      { source: "no-cache-fallback", attempts: 2, pages: 1, items: 1 },
    ]);
  });
});
