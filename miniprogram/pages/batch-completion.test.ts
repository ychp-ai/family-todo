import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { TaskListItem } from "@family-todo/contracts";
import { applyNativeData } from "../../tests/helpers/native-data";

type NativePage = Record<string, unknown> & { data: Record<string, unknown>; setData(patch: Record<string, unknown>): void };
let page: NativePage;
async function invoke(name: string, ...args: unknown[]) {
  const fn = page[name];
  if (typeof fn !== "function") throw new Error(name);
  await fn.apply(page, args);
}
const tap = (id: string) => ({ currentTarget: { dataset: { id } } });
function row(id: string, taskId = "series"): TaskListItem & { id: string; selected: boolean; group: string } {
  return {
    id, selected: false, group: "我来做",
    task: {
      id: taskId, title: "读书", version: 1, familyId: "family", familyName: "我的家", ownerUserId: "me", ownerName: "我", createdByUserId: "me",
      subject: { kind: "user", userId: "me" }, subjectName: "我", lifecycle: "active",
      schedule: { kind: "daily", startDate: "2026-09-28", endDate: null, times: ["08:00", "09:00"] },
      capabilities: { canEdit: true, canShare: true, canRecord: true, canDelete: true, canRestore: false, canResume: false },
    },
    occurrence: {
      id, taskId, segmentId: "segment", localDate: "2026-09-28", slot: id === "first" ? "08:00" : "09:00", time: id === "first" ? "08:00" : "09:00",
      subject: { kind: "user", userId: "me" }, subjectName: "我", status: "pending", canRecord: true, version: 0,
      scheduledAt: "2026-09-28T00:00:00.000Z", actualCompletedAt: null, recordedAt: null, operatorName: null,
    },
  };
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("Page", (p: NativePage) => { page = p; p.setData = patch => applyNativeData(p.data, patch); });
  vi.stubGlobal("wx", { showToast: vi.fn() });
  await import("./home/index");
  page.visible = true;
  page.refresh = vi.fn();
  const items = [row("first"), row("second")];
  // Native page data may share references between the source list and grouped cards.
  Object.assign(page.data, { items, visibleItems: items, groups: [{ name: "我来做", items }], batchMode: true, today: "2026-09-28" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["complete", "viewers"])("%s 连选不同卡片保留勾选，取消和再次进入无残留", async action => {
  if (action === "viewers") {
    const items = [row("first", "one"), row("second", "two")];
    Object.assign(page.data, { batchAction: action, items, visibleItems: items, groups: [{ name: "我来做", items }] });
  }
  await invoke("toggleTask", tap("first"));
  expect(page.data.groups).toMatchObject([{ items: [{ selected: true }, { selected: false }] }]);
  await invoke("openTask", tap("second"));
  expect(page.data.groups).toMatchObject([{ items: [{ selected: true }, { selected: true }] }]);
  expect(page.data.visibleItems).toMatchObject([{ selected: true }, { selected: true }]);
  expect(page.data[action === "complete" ? "selectedOccurrences" : "selectedTasks"]).toHaveLength(2);
  await invoke("toggleTask", tap("first"));
  expect(page.data.groups).toMatchObject([{ items: [{ selected: false }, { selected: true }] }]);
  await invoke("futureFeature");
  await invoke("futureFeature");
  expect(page.data.groups).toMatchObject([{ items: [{ selected: false }, { selected: false }] }]);
});

it("只选可记录的未完成次数，代记无需管理权，每批最多 20 次", async () => {
  const helper = row("helper");
  helper.task.capabilities.canEdit = false; helper.task.capabilities.canShare = false;
  const readonly = row("readonly"); readonly.occurrence.canRecord = false;
  const future = row("future"); future.occurrence.canRecord = false;
  const completed = row("completed"); completed.occurrence.status = "completed";
  const skipped = row("skipped"); skipped.occurrence.status = "skipped";
  page.setData({ items: [helper, readonly, future, completed, skipped, ...Array.from({ length: 20 }, (_, i) => row(`row${i}`))] });
  for (const id of ["helper", "readonly", "future", "completed", "skipped", ...Array.from({ length: 20 }, (_, i) => `row${i}`)]) await invoke("selectTask", tap(id));
  expect(page.data.selectedOccurrences).toHaveLength(20);
  expect(page.data.selectedOccurrences).toEqual(expect.arrayContaining([helper]));
  expect(page.data.batchError).toContain("20");
});

it("同一周期两个次数独立提交，保留原版本；一次提交后不可重复发送", async () => {
  const { personalApi } = await import("../services/personal-api");
  const write = vi.spyOn(personalApi, "write").mockResolvedValue({ occurrence: row("first").occurrence, taskVersion: 2 });
  await invoke("selectTask", tap("first")); await invoke("selectTask", tap("second"));
  await invoke("openCompletion");
  expect(write).not.toHaveBeenCalled();
  await invoke("submitCompletion"); await invoke("submitCompletion");
  expect(write.mock.calls.map(call => call[1])).toEqual(["first", "second"].map(id => ({
    occurrence: { id, taskId: "series", segmentId: "segment", localDate: "2026-09-28", slot: id === "first" ? "08:00" : "09:00" }, expectedVersion: 0, status: "completed",
  })));
  expect(page.data.completionResults).toMatchObject([{ status: "succeeded" }, { status: "succeeded" }]);
  expect(page.refresh).toHaveBeenCalledWith("record");
  expect(page.data).toMatchObject({ sheet: "", batchBusy: false, batchMode: false, selectedOccurrences: [] });
});

it("版本冲突显示失败但继续其他项，不自动覆盖或重试成功项", async () => {
  const { personalApi, PersonalApiError } = await import("../services/personal-api");
  const write = vi.spyOn(personalApi, "write").mockRejectedValueOnce(new PersonalApiError("VERSION_CONFLICT", "家人已修改，请刷新", false)).mockResolvedValueOnce({ occurrence: row("second").occurrence, taskVersion: 2 });
  await invoke("selectTask", tap("first")); await invoke("selectTask", tap("second"));
  await invoke("openCompletion"); await invoke("submitCompletion");
  expect(write).toHaveBeenCalledTimes(2);
  expect(page.data.completionResults).toMatchObject([{ status: "failed", label: "家人已修改，请刷新" }, { status: "succeeded" }]);
  expect(page.data.sheet).toBe("");
  expect(page.refresh).toHaveBeenCalledWith("record");
});

it("未知结果停止后续提交，使用已有未决写入口确认", async () => {
  const { personalApi, PersonalApiError } = await import("../services/personal-api");
  const write = vi.spyOn(personalApi, "write").mockRejectedValue(new PersonalApiError("TIMEOUT", "未知", true));
  const retry = vi.spyOn(personalApi, "retryPending").mockResolvedValue();
  await invoke("selectTask", tap("first")); await invoke("selectTask", tap("second"));
  await invoke("openCompletion"); await invoke("submitCompletion");
  expect(write).toHaveBeenCalledTimes(1);
  expect(page.data.completionResults).toMatchObject([{ status: "pending" }, { status: "waiting" }]);
  expect(page.data.sheet).toBe("complete");
  await invoke("retryPending");
  expect(page.data.sheet).toBe("");
  expect(retry).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledTimes(1);
  expect(page.data.completionResults).toEqual([]);
});

it.each(["onHide", "identity"])("%s 中断批量，不向新上下文提交剩余项或回填旧结果", async interruption => {
  const { personalApi } = await import("../services/personal-api");
  let finish: (() => void) | undefined;
  const write = vi.spyOn(personalApi, "write").mockImplementation(() => new Promise(resolve => { finish = () => resolve({ occurrence: row("first").occurrence, taskVersion: 2 }); }));
  await invoke("selectTask", tap("first")); await invoke("selectTask", tap("second"));
  await invoke("openCompletion"); const saving = invoke("submitCompletion");
  await invoke("submitCompletion"); await invoke("familyChange", { detail: { value: "1" } });
  await invoke("changeTab", { currentTarget: { dataset: { tab: "tomorrow" } } });
  expect(page.data).toMatchObject({ familyIndex: 0, tab: "today", batchBusy: true });
  if (interruption === "onHide") await invoke("onHide"); else personalApi.unbindRecovery();
  finish?.(); await saving;
  expect(write).toHaveBeenCalledTimes(1);
  expect(page.data.completionResults).toEqual([]);
  expect(page.data.batchBusy).toBe(false);
});

it.each([true, false])("追加可见人 complete=%s：终态关闭并刷新，未决保留弹层", async complete => {
  const { personalApi } = await import("../services/personal-api");
  vi.spyOn(personalApi, "continueBatch").mockResolvedValue({ complete, results: [] });
  vi.spyOn(personalApi, "batch", "get").mockReturnValue({
    payload: { items: [] },
    result: { complete, results: [] },
  });
  page.setData({ sheet: "batch", batchAction: "viewers" });
  page.refresh = vi.fn(() => {
    expect(page.data).toMatchObject({ sheet: "", batchMode: false, batchBusy: false, listRefreshing: true });
  });
  await invoke("submitBatch", { currentTarget: { dataset: { mode: "continue" } } });
  expect(page.data.sheet).toBe(complete ? "" : "batch");
  expect(page.refresh).toHaveBeenCalledTimes(complete ? 1 : 0);
});
