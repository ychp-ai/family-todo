# 成本优化验收记录

本地实施日期：2026-09-16。2026-09-17 已执行云端发布、技术回填及一次过期会话清理，真实账单验收仍待完成。实现进度见[优化计划](../plans/cost-optimization.md)，本地基准见[性能落地记录](API_PERFORMANCE_IMPLEMENTATION.md)。

## 2026-09-17 提交与线上预检

用户授权提交、推送及处理线上数据库。优化代码提交为 `51c88b1`，分支 `codex/cost-optimization`；本次重新执行 `npm run check`，57 个测试文件、649 项测试通过。

通过已登录的 CloudBase CLI 3.8.1 执行 `env list --json`，目标 `family-todo-d3g28fx1c314f8638` 状态 NORMAL。通过 `api tcb DescribeTable --api-version 2018-06-08`，指定该环境与 `MongoConnector={DatabaseName:tnt-5up4jdfvg,InstanceId:flexdb}` 核查：

- `tasks`：14 个索引，尚无 `task_date_candidates`；`personal_projection` / `family_projection` 累计访问计数分别为 15118 / 9314。计数起点为 2026-09-14，不代表本次账单窗口，也不能作为删除其他索引的依据。请求 ID：`f22b261c-ce05-4dda-b326-b489e1672c3d`。
- `query_sessions`：3 个索引，已有正确顺序的 `session_expiry(expiresAt,_id)`，无需重复创建。请求 ID：`24b3e9a4-4646-4be2-b650-8a4daca548f4`。

该轮仅完成线上只读预检，没有部署、建索引、回填或删除数据。当时的发布阻塞（已在后续执行中解决）：本机 `cloud-functions` 技能明确要求部署前读取的 `cloudbase-platform/references/protocols/` 下 `change-safety-protocol.md`、`deployment-gate.md`、`sensitive-runtime-data-protection.md` 缺失，搜索本机技能目录后仍未找到；该技能要求补齐 CloudBase 插件/缺失技能，禁止远程抓取协议替代。补齐后继续准备并验证兼容读取回退版本，再按下述发布顺序处理数据库。MCP 未登录，但 CLI 已登录，CLI 认证并非阻塞。

## 2026-09-17 线上执行结果

用户随后授权“补齐并继续执行”。从官方 TencentCloudBase/CloudBase-AI-Toolkit 安装缺失的 cloudbase-platform 技能并读取三份协议，沿用既有上线授权。

- 本地完整检查：57 个测试文件、650 项测试通过。
- 先发布兼容读取、旧格式写入版本（08:00:20），再发布精简写入版本（08:01:57，Asia/Shanghai）。两次健康检查均成功；最终函数 Active，Nodejs20.19、256 MiB、10 秒，服务端环境变量值与发布前一致。函数列表仅有 api。
- 线上 system.health 固定响应正常，family.list 无可信身份返回 UNAUTHENTICATED；这不是登录业务全流程或真机验收。
- 新增并复查 tasks.task_date_candidates 非唯一升序四列索引，旧索引保留。31 条任务仅补写派生字段；新一轮完整 dry-run 为 covered=31，missing/invalid/unknown/conflict 均为 0。
- 固定清理截止为 2026-09-16T00:05:00.000Z，清理已知 schema 的过期查询会话 66 条，条件删除成功 66 条，复查 eligible=0。未清理幂等回执或业务历史。随后已配置每天北京时间 00:00、12:00 的云端定时清理，见 [定时清理记录](QUERY_SESSION_CLEANUP.md)。
- 候选开关保持 OFF。当前任务量小，缺少真实完整流程收益及查询计划证据；不因回填成功自动启用。
- 历史实体冗余字段不批量重写，精简随后续业务保存生效。本次未上传或发布小程序，客户端条件缓存的收益需客户端发布后验收；未宣称真实账单下降比例。

维护中修正了两处实际环境差异：CLI 凭据经官方 secrets get 在子进程内获取，未输出密钥；数据库 SDK 实际导出的事务为 transaction/index.js，改用 tx.collection().doc().get()/update()，修正前 dry-run 零写入，修正后线上回填和复核成功。详细非敏感证据见 [线上结果](../../database/cost-optimization-release-result.json)。

可复现命令（CLI 为已登录的 CloudBase 3.8.1；环境均显式核对）：

```sh
node tools/build-storage-compatible.mjs
tcb fn deploy api -e family-todo-d3g28fx1c314f8638 --force --json
npm run build:cloudfunctions
tcb fn deploy api -e family-todo-d3g28fx1c314f8638 --force --json
tcb fn detail api -e family-todo-d3g28fx1c314f8638 --json
tcb fn invoke api -e family-todo-d3g28fx1c314f8638 -d @docs/examples/system-health.json --json
# 已核对 TCB_CLI、TCB_DATABASE 后执行：
node tools/migration/provision-task-candidates.mjs --apply
```

回填和清理通过本机维护包装器调用仓库导出函数，凭据仅驻内存；先 dry-run，再 apply，再新一轮 dry-run，固定上限 1000 行。结果文件包含计数和请求 ID。原始函数详情可能包含密钥，仅保留在忽略目录且不提交。

回退：在本次提交上运行 node tools/build-storage-compatible.mjs 并重新部署 api，可读取新旧文档且恢复旧写入格式；已保留兼容构建及 SHA256。不要直接回退到依赖冗余字段的更早版本。过期会话删除不能通过代码回滚恢复，客户端可按原流程重建查询会话。

## 测量范围

先记录目标环境、函数版本、客户端版本、统计起止时间、活跃账号数、页面打开次数及业务写入数。使用相同隔离测试家庭和固定操作序列比较版本；不要把不同流量的两天账单直接作为优化收益。控制台访问、迁移、开发工具常驻轮询和数据准备单列。

| 指标 | 基线版本/窗口 | 优化版本/窗口 | 说明 |
| --- | --- | --- | --- |
| 数据库平台计费调用 | 待采集 | 待采集 | 按平台明细，不替换为 SDK 计数 |
| 云函数调用/资源 GBs | 待采集 | 待采集 | 完整分页与重启全部纳入 |
| 首页完整加载 p50/p95 | 待采集 | 待采集 | 包含家庭、事项、提醒 |
| 10 分钟前台刷新总数据库操作 | 待采集 | 待采集 | 保持 30 秒检查时效 |
| 错误、超时、游标重启率 | 待采集 | 待采集 | 同时记录调用分母 |
| 集合/索引容量 | 待采集 | 待采集 | 优先控制台统计，避免反复全表扫描 |
| 候选字段覆盖与索引计划 | 不适用/旧路径 | 待验证 | 缺失、未知 schema、冲突及错误归属分别记录 |
| 查询会话每天新增/过期/清理数 | 待采集 | 待采集 | 删除自身的费用也计入 |
| 冷/暖请求时延、峰值内存 | 待采集 | 待采集 | 按动作和结果规模分组 |

## 日志口径

服务端基础指标由 `FAMILY_TODO_PERFORMANCE_LOGS=true` 开启，集合/操作明细由 `FAMILY_TODO_PERFORMANCE_DETAILS=true` 额外开启，默认关闭。仅在获准的观察窗口启用，窗口结束恢复原配置；平台配置变更需在部署记录中记录。日志不记录业务内容、OpenID 或完整 payload。

将已导出的原始 JSON 行日志交给本地汇总工具：

```sh
node tools/summarize-api-performance.mjs /path/to/api-performance.jsonl
```

客户端完整流程观测通过 `configureListMetrics` 在受控验证版本显式启用，默认关闭，配置示例见[性能观测记录](API_PERFORMANCE_IMPLEMENTATION.md#观测开关)。将客户端与服务端日志合并后，使用 `node tools/summarize-api-performance.mjs --logical-lists /path/to/combined.jsonl` 关联分析。每个流程统计与全局物理请求去重统计分别核对；缺少日志或关联记录被截断时不能视为完整成本。

应用层代理操作数为文档读 + 文档写 + 查询，事务、重试和返回行数单列。`databaseWaitCumulativeMs` 是各 SDK 等待之和，并行时可能超过请求墙钟时间；不能用请求耗时减去它推导 CPU 时间。缺少细分观测的记录不能证明某集合没有调用。函数执行时间的汇总不等于 GBs，应使用平台资源量核验。

## 发布与验证顺序

1. 发布前保留旧版本标识，检查新旧契约兼容和本地完整检查结果。
2. 若涉及新索引或候选字段，先部署兼容写入和旧读取路径，再按迁移文档建立索引、有界回填并验证覆盖；覆盖未证实时不启用新候选读取。确认全部在线写者均已升级，并验证实际查询计划；一次回填脚本成功不等于持续覆盖，未知格式、并发冲突或缺失行尚未处理时不能切换。覆盖和索引正确也不等于成本必降：候选分支存在固定开销，须以代表性大小、日期外数据比例和提醒历史验证完整读写总量；小数据变贵时保持兼容路径。当前本地实验的过期事项/提醒历史分支未达到成本收益门槛，正式候选优化限定普通日期事项列表；进度、逾期和提醒继续旧读取，不能据日期场景收益开启其他入口。
3. 在隔离测试家庭验证完整分页、重放、另一成员修改、撤权、退出重入、到时和上海跨天。小程序真机验证与内存模拟结果分开记录。
4. 保持同一工作负载，对小结果和大结果统计全部读取、会话写入、页数、错误率和资源量；单页变快不足以判定总成本下降。大结果归并必须把排序准备、空续页、归并块和检查点全部计入，另列未来会话删除及清理扫描；失败或重放产生的过期孤立块也纳入实际会话增长。
5. 查询会话清理先默认 dry-run 核对范围；实际删除另行授权。固定截止时间、一天宽限、已知 schema 和条件删除均保留。2026-09-17 已部署云端定时清理并手动验证；按时触发记录和长期清理量仍须在云日志中持续观察。
6. 观察一个与原账单可比的窗口后填写上表。按每次页面打开、每个活跃账号或业务操作归一化；不把不同优化阶段的百分比直接相加。

## 回退和暂不调整项

客户端异常可回退到兼容的完整读取；候选读取只有在覆盖验证后启用，异常时回到旧路径，保留已经写入的新字段。数据库兼容读取先于精简写入发布；回退版本须能读取已经精简的文档，不能直接回滚到依赖被省略字段的旧 codec。

持久化幂等回执和必要历史不清理。缺少真实回执体积、冷暖请求及峰值内存证据时，保留现有函数内存/超时配置；不依据本地调用次数估计实际 GBs 节省。真实删除不能依赖代码回滚恢复。
