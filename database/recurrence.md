# 周期存储与迁移

2026-09-14 已通过 `tools/migration/provision-recurrence.mjs --apply` 创建以下 4 个服务端集合并核验索引/ACL，环境共19个集合。原有15个集合的数据、旧 once 行和回执保持兼容。实际操作见 [迁移记录](recurrence-provision-result.json)，调用及重复执行证据见 [验证记录](recurrence-verification-result.json)。

| 集合 | 主键与用途 | 索引 |
| --- | --- | --- |
| schedule_segments | 应用 UUID；不可变日程及执行人快照，只允许关闭 effectiveUntil | taskId + listOrder（effectiveFrom/id） |
| schedule_controls | 应用 UUID；task 级暂停/恢复/停止/删除/恢复，保存 enabled/stopped 结果 | taskId + controlOrder（effectiveAt/16 位 taskVersion） |
| occurrence_states | 固定 namespace UUIDv5；首次记录才落库，pending 未落库 version=0 | taskId + segmentId + localDate + slot 唯一 |
| historical_subject_access | taskId/membershipId 的 SHA256 文档 ID；有历史应做次数的真实执行人必要可见权 | 按文档 ID 直接查询 |

所有新行 schemaVersion=1，所有集合 ADMINONLY。公开 DTO 不包含数据库字段。历史可见权仍要求该 membership 当前 active，不转授给其 successor；管理归属和创建者链按现有规则继任。

Task 的可选 recurrence 保存当前 schedule/currentSegmentId、activeOnceSegmentId、stopped、priorLifecycle、enabledFrom、firstEligibleAt、hasHistory、currentSubjectHasHistory。未触及的旧 once 不添加扩展、不改随机 occurrenceId，不扫描迁移旧文档。记录一次性改周期后旧字段仍保留用于兼容，投影仅使用有效片段指针。

任务全量候选扫描新增 `ownerUserId + createdOrder`、`familyId + createdOrder` 索引，避免以 inline date/status 过滤周期。家庭管理预览使用 active/paused/stopped，回收站单独使用 deleted，均按任务计数。控制查询严格 `controlOrder < boundary/` 倒序 limit=1，同一时刻控制不抹掉当刻已经应做的次数。UUIDv5 namespace 为 `736cf0e0-7e51-468b-b869-2a7c9fe41241`，输入为规范 JSON `[taskId,segmentId,localDate,slot]`，ID 小写。

查询会话复用 query_sessions，actor、查询指纹、个人 revision、所有家庭 version、asOf 及 15 分钟过期时间绑定；存储大小上限 128 KiB。每个请求最多 180 工作单位并保留 4 秒事务预算，历史范围不截断：每个窗口不超过 31 天，积压/提醒从最近窗口向历史遍历；完整扫描窗口后，使用当前/重叠片段的日程日期上界和窗口前最近关闭片段的 effectiveUntil，跳过可证明没有次数的区间。旧会话没有上界时先保守回退一个窗口。暂停或已完成造成的空窗仍保留扫描。窗口内按 localDate、time（日期型为99:99）、taskId、occurrenceId 排序；请求内保存 limit+1 最小候选，完整扫描该窗口后才发布一页。本地优化版另外保存最多 50 个次数一块的不可变 occurrence-run 会话，后续页扫描会话块而不重扫源片段/次数状态；小结果直接使用内联候选。未完成扫描时允许返回空页及继续游标；summary 只累计已经发布的去重次数，全部窗口及范围完成且无失败家庭时才返回最终值。暂停/停止历史仍参与投影，控制按相同生效区间批量复用，稀疏状态按最多 20 个 ID 批量覆盖。不存在任意 90 天或 365 天历史上限。

迁移脚本默认只输出计划，设置已核验的 `TCB_CLI`、`TCB_DATABASE` 后加 `--apply` 才实际调用平台。脚本先查询集合和索引，仅创建缺项，重复运行不改业务数据；核验每个 ACL 和索引字段/唯一性，日志默认 `database/recurrence-provision-result.json`，可用 `TCB_MIGRATION_JOURNAL` 指定。回滚应用代码无需删集合；不提供数据删除步骤。本次真实执行创建4个集合，重复执行未再次创建集合或索引；真实函数业务调用通过。新集合及 tasks 的客户端直接读取均被拒绝。

`progress.get` 复用统一次数扫描，仅聚合当前可见的家庭/日期/执行人次数。进度游标固定每页 20 次，并绑定 actor、过滤条件、个人 revision、family version、asOf 和 15 分钟有效期。`query_sessions` 内的 `progress` 状态引用不可变 `progress-node` 基数树：叶最多 256 个执行人，目录最多 64 个子引用，所有行仍受 128 KiB 限制。没有活跃成员数量或历史执行人数量截断；未完成扫描和最终汇总前返回 `members:null`。扫描完成先发布可续读根节点，下一调用使用新预算读取最终数组并再次鉴权。最终数组必须一次返回，极端历史执行人数仍受单次运行/响应容量约束；预算不足返回可重试 `TEMPORARILY_UNAVAILABLE`，保留原游标，不能用永不推进的游标冒充进度。

`task.batchAddViewers` 复用 `idempotency_receipts`，不新增集合或索引。父回执使用既有 actor/requestId 主键，指纹包含 action 与完整有序 payload，结果保存 `kind:batch`、`status:running|completed` 和原始 items；子主键为 `SHA256(JSON.stringify(['batch-child/v1',actorId,requestId,taskId]))`。子成功回执与事项修改在同一事务内提交，确定失败持久化后为终态，提交结果未知保留 pending。续跑必须使用原 requestId 和完整原 payload，不能只传 pending 项；全部终态后以新 requestId 仅重试失败项。每项及成功回放均重新鉴权，失权返回 NOT_FOUND 且不泄漏旧 version，原子回执不被覆盖。单项个人归属保留 ID、日程片段、历史次数/状态/执行人快照、提醒与本人关闭选择，只追加可见人。

## 2026-09-15 性能索引与会话清理

2026-09-15 性能迁移新增 `task_segment_window(taskId,effectiveUntil,effectiveFrom,listOrder)` 和 `task_segment_previous_end(taskId,effectiveUntil)`（支持按关闭时间倒序取最近片段），仅查询日期窗口重叠的已关闭片段，当前片段另行读取；不会以 inline date 排除周期。以上索引已在云端创建并回读验证，见 [性能迁移记录](performance-provision-result.json)，前面的 2026-09-14 验证记录不包含它。

本次另增并核验 `query_sessions.session_expiry(expiresAt,_id)`。本地清理工具默认只预览过期超过一天的 schemaVersion 1/2 会话，包含次数块、进度节点及确认会话；不处理 `idempotency_receipts`，不新增定时函数。操作边界、上线验证和剩余优化见 [落地记录](../docs/technical/API_PERFORMANCE_IMPLEMENTATION.md)。
