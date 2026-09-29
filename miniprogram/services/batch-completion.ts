import type { TaskListItem } from "@family-todo/contracts";

export type CompletionResult = {
  id: string;
  title: string;
  context: string;
  status: "waiting" | "succeeded" | "failed" | "pending";
  label: string;
};

export function canComplete(item: TaskListItem): boolean {
  return item.occurrence.status === "pending" && item.occurrence.canRecord;
}

export function selectCompletion(selected: TaskListItem[], item: TaskListItem): TaskListItem[] {
  if (!canComplete(item)) return selected;
  if (selected.some(row => row.occurrence.id === item.occurrence.id)) {
    return selected.filter(row => row.occurrence.id !== item.occurrence.id);
  }
  if (selected.length >= 20) throw new Error("一次最多选择 20 次待办。");
  return [...selected, item];
}

export function completionRows(items: TaskListItem[]): CompletionResult[] {
  return items.map(({ task, occurrence }) => ({
    id: occurrence.id,
    title: task.title,
    context: [task.familyName || "历史个人事项", occurrence.subjectName, occurrence.localDate || "未安排", occurrence.time || "不限定时刻"].join(" · "),
    status: "waiting",
    label: "尚未提交",
  }));
}
