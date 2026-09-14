import { afterEach, expect, it, vi } from "vitest";
import { familyProgress } from "./family-progress";
import { personalApi, PersonalApiError } from "./personal-api";
afterEach(() => vi.restoreAllMocks());
const asOf = "2026-09-14T00:00:00.000Z";
it("waits for complete progress and restarts an expired cursor once", async () => {
  const read = vi.spyOn(personalApi, "read")
    .mockResolvedValueOnce({ members: null, complete: false, nextCursor: "cursor", asOf })
    .mockRejectedValueOnce(new PersonalApiError("CURSOR_EXPIRED", "过期", false))
    .mockResolvedValueOnce({ members: [], complete: true, nextCursor: null, asOf });
  await expect(familyProgress("family", "2026-09-14", () => true)).resolves.toEqual([]);
  expect(read.mock.calls.map(call => call[1])).toEqual([
    { familyId: "family", date: "2026-09-14" },
    { familyId: "family", date: "2026-09-14", cursor: "cursor" },
    { familyId: "family", date: "2026-09-14" },
  ]);
});
it("rejects incomplete progress without a continuation", async () => {
  vi.spyOn(personalApi, "read").mockResolvedValue({ members: null, complete: false, nextCursor: null, asOf });
  await expect(familyProgress("family", "2026-09-14", () => true)).rejects.toThrow("进度未完整加载");
});
