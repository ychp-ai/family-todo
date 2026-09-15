import { expect, it } from "vitest";
import type { OccurrenceDTO } from "@family-todo/contracts";
import { occurrenceWarning } from "./occurrence-warning";

const occurrence: OccurrenceDTO = {
  id: "one", taskId: "task", segmentId: "segment", slot: "09:00",
  localDate: "2026-09-15", time: "09:00", scheduledAt: "2026-09-15T01:00:00.000Z",
  subject: { kind: "user", userId: "me" }, subjectName: "我", version: 0,
  status: "pending", actualCompletedAt: null, recordedAt: null, operatorName: null, canRecord: true,
};

it.each([
  ["2026-09-15T00:59:59.999Z", ""],
  ["2026-09-15T01:00:00.000Z", "已到计划时间"],
  ["2026-09-15T01:00:00.001Z", "已到计划时间"],
  ["2026-09-15T16:00:00.000Z", "计划日期已过"],
])("按服务端时间 %s 展示预警 %s", (asOf, label) => {
  expect(occurrenceWarning(occurrence, asOf)).toBe(label);
});

it("无具体时刻仅在上海日期结束后预警，未安排不预警", () => {
  const untimed = { ...occurrence, time: null, scheduledAt: null };
  expect(occurrenceWarning(untimed, "2026-09-15T15:59:59.999Z")).toBe("");
  expect(occurrenceWarning(untimed, "2026-09-15T16:00:00.000Z")).toBe("计划日期已过");
  expect(occurrenceWarning({ ...untimed, localDate: null }, "2026-09-15T16:00:00.000Z")).toBe("");
});

it.each(["completed", "skipped"] as const)("%s 不预警，撤销后恢复预警", status => {
  expect(occurrenceWarning({ ...occurrence, status }, "2026-09-16T01:00:00.000Z")).toBe("");
  expect(occurrenceWarning(occurrence, "2026-09-16T01:00:00.000Z")).toBe("计划日期已过");
});
