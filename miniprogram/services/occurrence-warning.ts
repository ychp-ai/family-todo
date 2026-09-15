import type { OccurrenceDTO } from "@family-todo/contracts";
import { dateAt } from "./personal-view";

/** Render time hints against the list's server snapshot, independently of reminder preferences. */
export function occurrenceWarning(occurrence: OccurrenceDTO, asOf: string): string {
  if (occurrence.status !== "pending") return "";
  if (occurrence.localDate && occurrence.localDate < dateAt(asOf)) return "计划日期已过";
  if (occurrence.scheduledAt && Date.parse(occurrence.scheduledAt) <= Date.parse(asOf)) return "已到计划时间";
  return "";
}
