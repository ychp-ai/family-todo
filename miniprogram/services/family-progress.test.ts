import { afterEach, expect, it, vi } from "vitest";
import { familyProgress } from "./family-progress";
import { configureListMetrics } from "./list-metrics";
import type { ListMetricRecord } from "./list-metrics";
import { personalApi, PersonalApiError } from "./personal-api";
afterEach(() => { configureListMetrics(null); vi.restoreAllMocks(); });
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
it("counts roster members across continuations and keeps restart attempts", async () => {
  const records: ListMetricRecord[] = [];
  configureListMetrics({sampleRate:1,sink:record=>{records.push(record);},createOperationId:async()=>"progress-operation"});
  vi.spyOn(personalApi, "read")
    .mockResolvedValueOnce({ members: null, complete: false, nextCursor: "stale", asOf })
    .mockRejectedValueOnce(new PersonalApiError("CURSOR_EXPIRED", "过期", false))
    .mockResolvedValueOnce({ members: null, complete: false, nextCursor: "fresh", asOf })
    .mockResolvedValueOnce({ members: [
      {subject:{kind:"member",membershipId:"one"},name:"甲",completed:1,pending:0,skipped:0,denominator:1},
      {subject:{kind:"virtual",virtualMemberId:"two"},name:"乙",completed:0,pending:1,skipped:0,denominator:1},
    ], complete: true, nextCursor: null, asOf });
  await expect(familyProgress("family", "2026-09-14", () => true)).resolves.toHaveLength(2);
  expect(records).toEqual([expect.objectContaining({
    action:"progress.get", result:"success", attempts:4, pages:3, restarts:1,
    memberCount:2, itemCount:0, continuationPages:2, emptyContinuationPages:0,
  })]);
});
