import { describe, expect, it, vi } from "vitest";
import type { AggregatePage, ConditionalInput, ConditionalPage, Page } from "@family-todo/contracts";
import { AppApiClient } from "./app-api-client";
import { CompleteListCache } from "./personal-lists";
import { PersonalApi, PersonalApiError } from "./personal-api";

const asOf = "2026-09-16T00:00:00.000Z", end = "2026-09-16T00:15:00.000Z";
const user = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
type Pagination = ConditionalInput & { cursor?: string };
function page(items = ["item"], token = "token"): Page<string> { return { items, complete: true, nextCursor: null, asOf, serverTime: asOf, cache: { token, nextInvalidationAt: end, expiresAt: end } }; }
function setup(bound = true) {
  const api = new PersonalApi(); if (bound) api.bindRecovery("env", user);
  const cache = new CompleteListCache(api);
  const fetch = vi.fn<(pagination: Pagination) => Promise<ConditionalPage<Page<string>>>>().mockResolvedValue(page());
  const read = (input: unknown = {}, active?: () => boolean, forceFull = false) => cache.read<string, Page<string>>("task.list", input, fetch, active, forceFull);
  return { api, cache, fetch, read };
}

describe("identity-bound complete-result memory cache", () => {
  it("reuses the whole multi-page result, preserves snapshot time and refreshes serverTime", async () => {
    const f = setup();
    f.fetch.mockResolvedValueOnce({ items: ["first"], complete: false, nextCursor: "second", asOf })
      .mockResolvedValueOnce({ items: [], complete: false, nextCursor: "third", asOf })
      .mockResolvedValueOnce(page(["last"]));
    const initial = await f.read(); expect(initial.items).toEqual(["first", "last"]);
    initial.items.push("page decoration"); delete initial.last.cache;
    f.fetch.mockResolvedValueOnce({ unchanged: true, token: "token", serverTime: "2026-09-16T00:00:30.000Z" });
    const hit = await f.read(); expect(hit.items).toEqual(["first", "last"]); expect(hit.last.asOf).toBe(asOf); expect(hit.last.serverTime).toBe("2026-09-16T00:00:30.000Z");
    expect(f.fetch.mock.calls[3]).toEqual([{ conditional: { token: "token" } }]);
  });
  it("does not install partial/failed scopes even if a faulty server includes a token", async () => {
    const f = setup();
    for (const status of ["partial", "failed"] as const) {
      const fetch = vi.fn<(pagination: Pagination) => Promise<ConditionalPage<AggregatePage<string>>>>().mockResolvedValue({ ...page(), scopes: [{ familyId: null, status }], summary: null });
      await f.cache.read<string, AggregatePage<string>>("task.list", { status }, fetch);
      await f.cache.read<string, AggregatePage<string>>("task.list", { status }, fetch);
      expect(fetch.mock.calls[1]).toEqual([{ conditional: {} }]);
    }
  });
  it("discards all earlier pages and candidate tokens after cursor restart", async () => {
    const f = setup();
    f.fetch.mockResolvedValueOnce({ items: ["stale"], complete: false, nextCursor: "expired", asOf })
      .mockRejectedValueOnce(new PersonalApiError("CURSOR_EXPIRED", "expired", false)).mockResolvedValueOnce(page(["new"], "new-token"));
    expect((await f.read()).items).toEqual(["new"]);
    f.fetch.mockResolvedValueOnce({ unchanged: true, token: "new-token", serverTime: asOf });
    expect((await f.read()).items).toEqual(["new"]); expect(f.fetch.mock.calls[2]).toEqual([{ conditional: {} }]);
  });
  it("failed scans cannot populate the cache, and failed refresh removes an old snapshot", async () => {
    const f = setup();
    f.fetch.mockResolvedValueOnce({ items: ["partial"], complete: false, nextCursor: "next", asOf }).mockRejectedValueOnce(new Error("offline"));
    await expect(f.read()).rejects.toThrow("offline");
    await f.read(); expect(f.fetch.mock.calls[2]).toEqual([{ conditional: {} }]);
    f.fetch.mockRejectedValueOnce(new Error("offline")); await expect(f.read()).rejects.toThrow("offline");
    await f.read(); expect(f.fetch.mock.calls[4]).toEqual([{ conditional: {} }]);
  });
  it("falls back once when unchanged arrives without a matching complete token", async () => {
    const f = setup();
    f.fetch.mockResolvedValueOnce({ unchanged: true, token: "missing", serverTime: asOf });
    await expect(f.read()).resolves.toMatchObject({ items: ["item"] });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.fetch.mockResolvedValue({ unchanged: true, token: "wrong", serverTime: asOf });
    await expect(f.read()).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it("separates accounts, environment, action and filters, and never caches an unbound identity", async () => {
    const f = setup(false); await f.read(); await f.read(); expect(f.fetch.mock.calls[1]).toEqual([{ conditional: {} }]);
    f.api.bindRecovery("env", user); await f.read();
    f.api.bindRecovery("other-env", user); await f.read(); expect(f.fetch.mock.calls[3]).toEqual([{ conditional: {} }]);
    f.api.bindRecovery("other-env", other); await f.read(); expect(f.fetch.mock.calls[4]).toEqual([{ conditional: {} }]);
    await f.read({ familyId: null }); expect(f.fetch.mock.calls[5]).toEqual([{ conditional: {} }]);
    await f.cache.read<string, Page<string>>("family.list", {}, f.fetch); expect(f.fetch.mock.calls[6]).toEqual([{ conditional: {} }]);
    await f.read({}, undefined, true); expect(f.fetch.mock.calls[7]).toEqual([{ conditional: {} }]);
  });
  it.each(["account", "environment", "clear", "view"])("does not reuse or install a late response after %s switch", async change => {
    const f = setup(); let active = true; let resolve: ((value: ConditionalPage<Page<string>>) => void) | undefined;
    f.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const read = f.read({}, () => active);
    if (change === "account") f.api.bindRecovery("env", other);
    if (change === "environment") f.api.bindRecovery("other-env", user);
    if (change === "clear") f.api.unbindRecovery();
    if (change === "view") active = false;
    resolve?.(page(["old"])); await expect(read).rejects.toThrow("已切换查看范围");
    await f.read(); expect(f.fetch.mock.calls[1]).toEqual([{ conditional: {} }]);
  });
  it("bounds cache entries and discards unchanged after privacy clearing", async () => {
    const f = setup(); await f.read();
    for (let index = 0; index < 12; index++) await f.read({ index });
    await f.read(); expect(f.fetch.mock.calls[13]).toEqual([{ conditional: {} }]);
    f.fetch.mockImplementationOnce(async () => { f.api.clearCompleteLists(); return { unchanged: true, token: "token", serverTime: asOf }; });
    await expect(f.read()).rejects.toThrow("已切换查看范围");
    await f.read(); expect(f.fetch.mock.calls.at(-1)).toEqual([{ conditional: {} }]);
  });
});

it("a write invalidates complete snapshots and rejects late pre-write scans", async () => {
  const api = new PersonalApi(new AppApiClient({send: async request => ({ok:true,requestId:request.requestId,data:{id:other,version:2,deleted:true}})}), async () => other);
  api.bindRecovery("env", user);
  const cache = new CompleteListCache(api);
  const fetch = vi.fn<(pagination: Pagination) => Promise<ConditionalPage<Page<string>>>>().mockResolvedValue(page());
  const read = () => cache.read<string, Page<string>>("task.list", {}, fetch);
  await read();
  let resolve: ((value: Page<string>) => void) | undefined;
  fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const late = read();
  await api.write("task.delete", {id:other,expectedVersion:1});
  resolve?.(page(["stale"])); await expect(late).rejects.toThrow("已切换查看范围");
  await read(); expect(fetch.mock.calls.at(-1)).toEqual([{conditional:{}}]);
});
