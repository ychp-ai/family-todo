import type { MemberProgress, ResolvedSubject } from "@family-todo/contracts";
import { personalApi, PersonalApiError } from "./personal-api";
import type { MetricArgument } from "./personal-lists";
import { ListCancelledError, ListContinuationError, listMetricsConfigured, metricRequest, startListMetric } from "./list-metrics";

/** Publish only a complete, authorized progress snapshot. */
export async function familyProgress(familyId: string, date: string, active: () => boolean, options: {subject?: ResolvedSubject; metric?: MetricArgument} = {}): Promise<MemberProgress[]> {
  const metric = options.metric === false ? undefined : options.metric ?? (listMetricsConfigured() ? startListMetric("progress.get") : undefined);
  let cursor: string | undefined;
  let restarted = false;
  const seen = new Set<string>();
  try { while (active()) {
    try {
      const payload = { familyId, date, ...(options.subject ? {subject:options.subject} : {}), ...(cursor ? { cursor } : {}) };
      const result = await metricRequest(metric, observer => observer ? personalApi.read("progress.get", payload, observer) : personalApi.read("progress.get", payload));
      if (!active()) break;
      const members=result.members?.length??0;metric?.page(members,!result.complete,"members");
      if (result.complete && result.members !== null) {metric?.finish("success");return result.members;}
      if (!result.nextCursor || seen.has(result.nextCursor)) throw new ListContinuationError("进度未完整加载，请重试。");
      cursor = result.nextCursor;
      seen.add(cursor);
    } catch (error) {
      if (error instanceof PersonalApiError && error.code === "CURSOR_EXPIRED" && !restarted) {
        restarted = true; cursor = undefined; seen.clear(); metric?.restart(); continue;
      }
      throw error;
    }
  }
  throw new ListCancelledError();
  } catch(error){metric?.finishError(error);throw error;}
}
