# 接口调用示例

所有请求发送到同一个 `api` 云函数。下列业务请求是联调设计，只有 `system.health` 已有 handler；不要把业务示例当作已上线能力。完整字段和权限见 [API 契约](API.md)。UUID 为示例，业务联调必须使用实际响应中的 ID、版本和单次引用。

## 健康检查

可直接用于 CLI 的事件文件：[system-health.json](../examples/system-health.json)。成功 data 包含 status=ok、service=api、apiVersion=1 及服务端 UTC 毫秒时间，不表示数据库就绪。

```sh
npx --yes --package=@cloudbase/cli@3.8.1 tcb fn invoke api \
  -e family-todo-d3g28fx1c314f8638 -d @docs/examples/system-health.json --json
```

## 初始化与查询

小程序从可信微信调用上下文执行 identity.ensure 后，才调用业务接口；请求体不传用户身份。每个示例是独立完整 envelope。

```json
{
  "apiVersion": 1,
  "action": "identity.ensure",
  "requestId": "a1111111-1111-4111-8111-111111111111",
  "payload": {}
}
```

首次成功 data 为 `{ "user": { "id": "服务端UUID", "displayName": "我", "version": 1 } }`。随后查询跨家庭指定日期：

```json
{
  "apiVersion": 1,
  "action": "task.list",
  "requestId": "a2222222-2222-4222-8222-222222222222",
  "payload": { "dateFrom": "2026-09-12", "dateTo": "2026-09-12", "limit": 20 }
}
```

familyId 省略时聚合所有有权家庭及个人；传 null 仅查询个人。未安排用 `{ "unscheduled": true, "limit": 20 }`；过去未完成用 `{ "overdue": true, "limit": 20 }`。不能把这两个条件与日期范围组合。

```json
{
  "ok": true,
  "requestId": "a2222222-2222-4222-8222-222222222222",
  "data": {
    "items": [],
    "nextCursor": "opaque-signed-cursor",
    "complete": false,
    "asOf": "2026-09-11T10:30:00.000Z",
    "scopes": [{ "familyId": null, "status": "partial" }],
    "summary": null
  }
}
```

这表示扫描尚未完成，不能显示“没有事项”。保持原日期与 limit，增加 cursor=nextCursor，用新 requestId 继续查询。CURSOR_EXPIRED 时清空旧页并重查；不能拼接两个扫描会话的结果。

## 创建与记录

个人任务完整创建请求见 [API 契约](API.md#可复用请求示例)。家庭创建时将 draft.familyId 设为真实家庭 ID，subject 设为该家庭 member 或 virtual，并明确 access。不要填写 ownerUserId、createdByUserId、operatorUserId；服务端负责归属和操作者。

创建返回 task 与最多3个 nextOccurrences。无日期任务取返回的 occurrence，原样保存以下完整引用；不自行计算 occurrence.id 或 segmentId。

```json
{
  "apiVersion": 1,
  "action": "occurrence.record",
  "requestId": "a3333333-3333-4333-8333-333333333333",
  "payload": {
    "occurrence": {
      "id": "b1111111-1111-5111-8111-111111111111",
      "taskId": "b2222222-2222-4222-8222-222222222222",
      "segmentId": "b3333333-3333-4333-8333-333333333333",
      "localDate": null,
      "slot": "unscheduled"
    },
    "expectedVersion": 0,
    "status": "completed"
  }
}
```

省略 actualCompletedAt 时由服务端 Clock 取当前时间。响应 `{occurrence,taskVersion}` 中 occurrence.version 和 taskVersion 用于下一次修改；撤销用 occurrence.undo、相同引用和最新 occurrence.version，使用新的 requestId。

请求超时后保持原 requestId 和完整 payload 重试。修改标题、改补记时间或解决冲突后属于新命令，必须换 requestId。

```json
{
  "ok": false,
  "requestId": "a3333333-3333-4333-8333-333333333333",
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "家人刚刚更新了这件事，请刷新后重试。",
    "retryable": false
  }
}
```

message 为文案例子，客户端按 code 决策，不解析字符串。保留用户输入并获取最新状态，不自动提高版本覆盖他人的操作。

## 邀请、退出与批量操作

| 流程 | 调用顺序与必要数据 |
| --- | --- |
| 邀请加入 | 拥有人 family.get → invitation.create（expectedFamilyVersion）→ 分享 token；接收人 identity.ensure → invitation.preview → 用户确认 → invitation.accept（token、myName） |
| 撤销邀请 | invitation.list 取得 id/version → invitation.revoke；不移除已加入者 |
| 普通退出 | family.previewExit（familyId、自己的 targetMembershipId、mode=leave）→ 按 cursor 完成预览 → 展示承接范围 → family.exit（原参数、previewToken、expectedFamilyVersion） |
| 拥有人退出 | 先 family.previewTransfer → transferOwnership；再以普通成员走退出预览，不能把两个命令合并 |
| 批量追加可见人 | task.batchAddViewers，最多20个不同 taskId；个人事项额外指定 targetFamilyId；每项带最新 expectedVersion |

批量返回 complete=false 时，沿用原请求继续处理 pending 项，已成功项目不再次执行。complete=true 后才可用新 requestId 重试失败项。预览过期需重新展示影响并确认；历史分页不恢复离开成员的授权。

## 提醒与进度

reminder.list 的 payload 只包含 includeDismissed、limit、cursor，不传首页家庭筛选。reminder.setMine 的 expectedVersion 来自 task.myReminder.version，不能用 TaskDTO.version 替代。markRead/dismiss 传完整 occurrence 引用，不改变完成状态。

progress.get 固定 familyId 和 date，subject 省略表示按有权记录的执行对象聚合。complete=false 时 members=null，继续读取至完成后再显示统计；已跳过单列，不计入 denominator。统计不能推断不可见事项的总量。
