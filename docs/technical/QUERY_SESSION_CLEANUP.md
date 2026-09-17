# 查询会话云端定时清理

2026-09-17 按用户授权在现有环境 `family-todo-d3g28fx1c314f8638` 新建并启用独立维护函数 `cleanup-query-sessions`，函数 ID 为 `lam-5oip7m7h`。业务 API 保持原入口。

## 时间与清理范围

- 触发器：`cleanup-query-sessions-12h`，平台回读 `Enable=1`、`BindStatus=on`。
- 每天北京时间（Asia/Shanghai，UTC+8）00:00、12:00 执行；七段 Cron 为 `0 0 0,12 * * * *`。
- 仅扫描 `query_sessions`，删除 `expiresAt < 本次开始时间 - 24 小时` 且 schemaVersion 为 1 或 2 的记录。未知 schema 跳过；不清理业务数据或幂等回执。
- 复用 `tools/cleanup-query-sessions.mjs` 及现有 `session_expiry(expiresAt,_id)` 索引。条件删除同时匹配 ID、schemaVersion、expiresAt，可重复运行。
- 单次最多扫描 10,000 条，50 秒后在下一条/下一页之前停止，函数硬超时为 60 秒，内存 256 MB。单个在途数据库请求仍受平台超时约束。
- 本轮达到上限时 `complete=false`，后续定时运行重新扫描剩余过期记录。大量未知 schema 或持续积压需维护人员检查，不能据此保证一个周期内全部清完。

Cron 字段见 [CloudBase 定时触发](https://docs.cloudbase.net/cloud-function/timer-trigger)；北京时间规则见腾讯云 [定时任务配置](https://intl.cloud.tencent.com/zh/document/product/436/41621)。到期后有一天宽限，因此正常情况下会在过期后约 24–36 小时内删除，积压或执行失败时可能更晚。

## 权限与部署

客户端禁止调用本维护函数；管理员 CLI 和平台定时器可调用。函数事件只用于分派，并非鉴权凭据。环境级函数安全规则在保留既有通配规则的基础上增加：

```json
{
  "*": { "invoke": "auth != null && auth.loginType != 'ANONYMOUS'" },
  "cleanup-query-sessions": { "invoke": false }
}
```

新环境应先读取并合并函数安全规则，禁止直接覆盖其他函数规则，然后部署。本次通过 CLI 的 `DescribeResourcePermission` / `ModifyResourcePermission` 完成并回读验证。规则语义见 [函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)。

`cloudbaserc.example.json` 包含函数和触发器配置；本地忽略的 `cloudbaserc.json` 已同步。复现命令（本次 CLI 3.8.1，部署需要当前会话授权）：

```bash
npm run build
tcb fn deploy cleanup-query-sessions -e family-todo-d3g28fx1c314f8638 --json
tcb fn detail cleanup-query-sessions -e family-todo-d3g28fx1c314f8638 --json
tcb fn invoke cleanup-query-sessions -e family-todo-d3g28fx1c314f8638 -d '{"mode":"dry-run"}' --json
tcb fn invoke cleanup-query-sessions -e family-todo-d3g28fx1c314f8638 -d '{"mode":"apply"}' --json
```

函数为 Event 类型，Nodejs20.19、index.main，依赖已打包，未配置 HTTP 入口，无额外密钥。维护日志事件为 `query_sessions_cleanup`，包含 scanned、eligible、deleted、skipped、complete 和断点。运行异常向平台抛错；未另外创建告警或通知服务。发现失败、skipped 非零或多次 complete=false 时，先检查日志再处理。

## 验证边界

- 本地 `npm run check` 构建、类型检查及 656 项测试通过；随后新增维护 bundle 独立加载验证，`npx vitest run tests/build.test.ts` 的 6 项测试通过。
- CLI 首次创建成功，回读确认函数 Active、定时器已启用且 Cron 正确，客户端禁止调用规则已保存。
- 真实云端先 dry-run，再手动调用 Timer 事件执行清理，最后 dry-run 复查；均成功，符合清理条件的记录为 0。
- [部署及调用结果](../../database/query-session-cleanup-deployment-result.json) 保存实际命令、请求 ID 和结果。
- 上述验证是管理员手动调用真实云端函数；尚未等到下一次自然定时触发。下一次计划执行为 2026-09-18 00:00（北京时间），到时可通过平台日志核验。
