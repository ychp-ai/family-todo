# 任务日期候选与技术回填

2026-09-17 已在线创建候选索引、回填并完整复核 31 条任务，新读路径仍关闭。结果见 [发布验收](../docs/technical/COST_OPTIMIZATION_ACCEPTANCE.md)。`FAMILY_TODO_INDEXED_CANDIDATES` 未设置或不等于 `1` 时沿用旧扫描。开关仅接入普通日期范围 task.list；进度 progress.get、逾期、提醒、管理列表、回收站和旧索引不变。

## 派生字段与写入

`tasks` 仍为 `schemaVersion:1`，新增 `candidateSchema:1`、`scopeKey`（`p/<ownerUserId>` 或 `f/<collaboration.familyId>`）、`candidateKind:single|history`、`candidateOrder`（日期/时间/UUID，无日期为 `9999-12-31`，无时间为 `99:99`）。`candidateKind` 是内部可选持久化类型；不进入 API DTO。完整与无 note 投影 codec 都保留分类，所有 task writer 通过 `taskFields` 原子写入元数据，不增加读取。

新无 recurrence 的 once 为 single，新周期为 history；新 RecurrenceService once 明确写入 single。读旧无 recurrence 行可证明 single；旧 recurrence 缺失/未知技术字段一律 history，不能依据当前 once 或 hasHistory=false 降级。已标记 history 永不自动降级，single 首次保存非 once 时晋升 history；后续修改、状态、提醒、批量、迁移继续传递该标志。个人迁入家庭随原任务事务派生新的 scopeKey，不重写历史片段和执行人快照。

候选使用独立 `candidateOrder`，保留旧 `scheduleOrder/recentOrder/createdOrder` 的值。原因：历史/内部 RecurrenceService 创建 once 时顶层 date/time 可以为空，但 recurrence.schedule 与当前片段有 once 日期；复用并修正旧键会改变 OFF 旧查询行为。candidateOrder 取当前真实 once schedule 日期，其他任务取原 date/time。样本 JSON UTF-8 净增：single 170 字节、history 171 字节（包含4字段名、值和 JSON 标点）；不等于平台 BSON/索引实际容量。

## 候选索引与查询

保留旧索引，新增非唯一升序 `task_date_candidates(scopeKey,candidateKind,lifecycle,candidateOrder)`。调用侧仅在 action=task.list、非 projectionOnly、非 backlog 时提供 candidateWindow；progress.get 虽复用 task.list 投影，仍使用旧 scanner。单次日期窗口最多6个等值分支：single/history × active/paused/stopped。single 范围 `[from+'/',to+'/~']`；时间、UUID 的 ASCII 字符严格小于 `~`。history 不按当前日期或 enabledFrom 过滤。续页与日期范围都只比较 candidateOrder；游标固定保存版本、分支号及当前位置，互斥分支无需去重集。

内部保留但正式开关不接入的 backlog 候选实验，在每个 single 生命周期分支第一页，额外查询同作用域 `candidateOrder < from+'/'` 的最大1行，日期前缀作为 olderHint；允许无权限/已完成行产生保守多查，不能漏古老提醒。每作用域每窗口最多增加3次 predecessor 查询。history 的 previousSegmentEnd / previousSegmentDate 路径保留，不读取 personalTaskCount 推断历史完成。创建时间快照、服务端归属检查、即时权限、家庭版本与最终事务围栏保持原样。

算法 `indexed-candidates/v1` / `legacy` 进入列表游标和条件验证 fingerprint；切换算法时旧 continuation 返回 CURSOR_EXPIRED，旧条件验证缓存失效。先前不含算法字段的 occurrence-list 游标同样显式过期。

## 有界回填和验证

本地无网络索引计划：`node tools/migration/provision-task-candidates.mjs`。`--apply` 才允许对已存在 tasks 集合执行 DescribeTable/UpdateTable 并复查键顺序；不创建集合、不改 ACL、不删旧索引。索引同名不同定义会失败，不自动替换。正式运行前人工核对 cloudbaserc.json 环境及 TCB_DATABASE。

回填 CLI：`node tools/migration/task-candidates.mjs [--apply] [--max-rows 1..10000] [--after CHECKPOINT]`；默认 dry-run。通过环境注入已核对的 TCB_ENV_ID 和临时维护凭据。不要把凭据传入命令参数。输出只含计数、最多100个失败任务ID及检查点，不输出任务正文或凭据。

- 按 `_id` 稳定分页，每页最多100行，每次最多 maxRows；仅读取派生所需字段。检查点绑定环境、操作模式、算法版本，累计缺失、未知、无效、冲突计数；resume 不能抹掉早期失败。
- 仅处理 schemaVersion 1；未知 candidateSchema 同样拒绝。旧 recurrence 保守回填 history，不枚举历史以尝试降级。已有 single recurrence 验证全部片段都是合法 once 且包含匹配当前片段；最多20页×100，超过上限或缺片段不能证明 single，保守修复 history。
- 在 Node SDK 原生 `startTransaction/collection().doc().get().data/update(fields)/commit` 内重新读取行，对照 version、归属、createdAt、当前 schedule 及原技术字段。只 `$set` 4个派生字段，不修改业务 version、不覆写整行快照。并发更新、迁移、替换或提交错误标记 conflict，回滚后重跑；需从头重扫失败行，检查点不会自动回退。
- 线上 dry-run 发现包内遗留的 `transaction.js` 并非实际导出；SDK 当前使用 `transaction/index.js` 的 `tx.collection().doc()` 接口。已修正脚本与行为测试，使用显式事务，并通过线上回填与完整复核；尚未验证查询计划。
- apply 成功不等于覆盖率验证。必须再从头完整 dry-run；unknown/missing/invalid/conflict 任一非零均不得通过。分页恢复累计所有计数；合法数据变更后的早期失败仍需完整重扫。

## 发布、成本与回滚门槛

先发布所有理解并持续写元数据的 writer，保持开关 OFF；另行授权应用索引和有界技术回填；完成全范围验证、真实索引正/反向查询计划验证和代表性工作负载完整流程成本对比，再人工启用。验证本身不是自动切换授权。扫描期间有在线变更不构成覆盖率的静态快照，必须确保所有 writer 已升级并对冲突进行重扫。

小数据/历史占主导时6分支及 predecessor 会增加调用。当前本地小集21个结果从2页增至3页，完整代理成本（documentReads+queries+documentWrites）78→101；1000个窗外一次性事项压力样本为148→101，但该合成单家庭样本超过500条业务上限，仅测试算法缩放。历史数量仍线性影响成本。backlog 实验完整代理成本 task 184→226、reminder 175→279，因此正式开关明确排除 backlog，两种模式都走旧路径，完整计数相同。不得仅凭候选行减少启用普通日期范围优化，必须基于完整用户流程、session 写入及平台计费选择上线范围。

回滚先关闭开关，再回滚服务器；旧 writer 可能覆盖/丢失元数据，重新启用前重新回填和全量验证。保留旧索引整个回退窗口。本次已完成云端维护与函数冒烟；真机和真实计费收益尚未验证。
