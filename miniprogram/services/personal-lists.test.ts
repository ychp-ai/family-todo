import { describe, expect, it, vi } from "vitest";
import type { Page } from "@family-todo/contracts";
import { PersonalApiError } from "./personal-api";
import { authorizedItems, collect } from "./personal-lists";

const asOf = "2026-09-14T00:00:00.000Z";
function page(items: string[], nextCursor: string | null = null): Page<string> {
  return { items, nextCursor, complete: nextCursor === null, asOf };
}

describe("complete list collection", () => {
  it("continues through empty pages until the scan completes", async () => {
    const last = page(["family"]);
    const fetch = vi.fn<(cursor?: string) => Promise<Page<string>>>()
      .mockResolvedValueOnce(page([], "next"))
      .mockResolvedValueOnce(last);
    await expect(collect(fetch)).resolves.toEqual({ items: ["family"], last });
    expect(fetch.mock.calls).toEqual([[undefined], ["next"]]);
  });

  it("discards earlier pages when restarting an expired cursor", async () => {
    const last = page(["current"]);
    const fetch = vi.fn<(cursor?: string) => Promise<Page<string>>>()
      .mockResolvedValueOnce(page(["stale"], "next"))
      .mockRejectedValueOnce(new PersonalApiError("CURSOR_EXPIRED", "过期", false))
      .mockResolvedValueOnce(last);

    await expect(collect(fetch)).resolves.toEqual({ items: ["current"], last });
    expect(fetch.mock.calls).toEqual([[undefined], ["next"], [undefined]]);
  });

  it("does not retry a second cursor expiration", async () => {
    const error = new PersonalApiError("CURSOR_EXPIRED", "过期", false);
    const fetch = vi.fn<(cursor?: string) => Promise<Page<string>>>().mockRejectedValue(error);
    await expect(collect(fetch)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, "next"])("rejects an incomplete scan with invalid continuation %s", async nextCursor => {
    const fetch = vi.fn<(cursor?: string) => Promise<Page<string>>>()
      .mockResolvedValueOnce(page(["first"], "next"))
      .mockResolvedValue({ ...page(["second"], nextCursor), complete: false });
    await expect(collect(fetch)).rejects.toThrow("列表未完整加载");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("discards a response after the viewing scope changes", async () => {
    let active = true;
    const fetch = vi.fn(async () => {
      active = false;
      return page(["old scope"]);
    });
    await expect(collect(fetch, () => active)).rejects.toThrow("已切换查看范围");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not begin reading an inactive scope", async () => {
    const fetch = vi.fn(async () => page([]));
    await expect(collect(fetch, () => false)).rejects.toThrow("已切换查看范围");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("keeps only authorized scopes, preserving personal items and list order", () => {
  const items = [
    { id: "personal", familyId: null },
    { id: "partial", familyId: "partial" },
    { id: "family", familyId: "allowed" },
    { id: "failed", familyId: "failed" },
    { id: "unknown", familyId: "unknown" },
    { id: "family-again", familyId: "allowed" },
  ];
  expect(authorizedItems(items, [
    { familyId: null, status: "ok" },
    { familyId: "allowed", status: "ok" },
    { familyId: "partial", status: "partial" },
    { familyId: "failed", status: "failed" },
  ], item => item.familyId)).toEqual([items[0], items[2], items[5]]);
  expect(authorizedItems(items, [], item => item.familyId)).toEqual([]);
});
