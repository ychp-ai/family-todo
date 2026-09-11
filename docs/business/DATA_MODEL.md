# 业务数据模型与一致性设计

状态：首版开发设计，尚未创建业务集合或实现接口。产品规则来自 [需求](../REQUIREMENTS.md)，接口见 [API](API.md)，实现与验收顺序见 [开发交付](DELIVERY.md)。底层实现细节见 [一致性与数据访问](../technical/CONSISTENCY.md) 和 [日程算法](../technical/SCHEDULING.md)。下文数量和时间限制是本次选定的工程默认值，不是已上线能力。

## 统一约定

- 业务 ID 使用应用生成的 UUID；数据库 `_id` 只由适配器映射。所有实体含 `id / version / createdAt / updatedAt`；version 从 1 开始，每次写入递增。
- 瞬时为 UTC RFC3339 毫秒字符串；日历日期为严格 `YYYY-MM-DD`，时刻为 `HH:mm`，日历计算固定 `Asia/Shanghai`。日期字段不能当 UTC 午夜解析。
- 用户身份通过云函数可信微信上下文获得，入口转换为 `Actor {userId}`。OpenID 与 AppID 仅保存在身份适配层，不能作为业务 ID 或出现在 DTO、日志及错误中。
- 个人事项 `familyId=null`；家庭事项绑定一个 familyId。家庭内称呼使用 membershipId，虚拟执行对象使用 virtualMemberId，不能按称呼推断身份。
- 缺省提醒仅为创建者开启；可见名单、代记名单和提醒接收设置独立。没时刻时保留开启设置，不生成到时提示。

## 实体与存储映射

下表是拟建集合。集合名、索引和访问路径随正式迁移实现；本次不创建资源。

| 实体 / 拟建集合 | 核心字段 | 不变量与访问路径 |
| --- | --- | --- |
| User / users | displayName | 应用 UUID；个人身份不随家庭退出改变 |
| Identity / identities | provider、appId、subject、userId | `(provider,appId,subject)` 唯一；只允许服务端访问。使用稳定散列定位映射文档，不把 subject 当业务 ID |
| UserScope / user_scopes | userId、revision、activeFamilyCount、personalTaskCount | 用户家庭名单与个人数据写栅栏；容量检查与业务写同事务 |
| Family / families | name、ownerMembershipId、authEpoch、taskCount、memberCount、virtualMemberCount | 拥有人必须是真实且 active 的成员；version 为所有家庭写栅栏，authEpoch 标识权限变化；计数只含占用有效额度的资源 |
| Membership / memberships | familyId、userId、name、status(active/left/removed)、successorMembershipId | 同一家庭同一用户最多一个 active；退出后重新加入生成新 membershipId，历史身份不复活 |
| MembershipSlot / membership_slots | familyId、userId、activeMembershipId | 使用 familyId/userId 的稳定文档键，事务内保证重复接受邀请不重复加入；userId 索引查所在家庭 |
| VirtualMember / virtual_members | familyId、name、status(active/inactive) | 不含登录账号；实际管理归属解析为家庭当前拥有人 |
| Invitation / invitations | familyId、tokenHash、expiresAt、revokedAt、createdBy | 128 bit 随机邀请口令，仅服务端存散列；7 天失效，可多人接受；明确加入确认前只展示家庭名称、邀请人称呼、有效期 |
| Task / tasks | familyId、ownerBinding、createdByUserId、creatorMembershipId、subject、title、note、access、lifecycle、priorLifecycle、currentSegmentId、activeOnceSegmentId?、deletedAt | ownerBinding 为 personalUser / membership / familyOwner；subject 为 user(userId) / member / virtual。普通归属绑定创建者，虚拟归属绑定家庭当前拥有人 |
| ScheduleSegment / schedule_segments | taskId、schedule、subject、subjectNameSnapshot、effectiveFrom、effectiveUntil、allowCreationDay、createdByUserId | 不可变的历史计划片段，有时刻周期边界 `(effectiveFrom,effectiveUntil]`，until=null 表示无上界；后续修改通过封闭旧片段并创建新片段表示，不改写历史计划或执行对象；换人同样切分片段 |
| ScheduleControl / schedule_controls | taskId、segmentId?、kind(pause/resume/stop/delete/restore)、effectiveAt、taskVersion | 控制作用于整个 task，segmentId 仅供审计；暂停和删除时间段不产生新计划次数；停止后不得恢复该系列；删除周期恢复为 paused |
| OccurrenceState / occurrence_states | taskId、segmentId、localDate、slot、status(pending/completed/skipped)、actualCompletedAt、operatorUserId、version | 默认 pending 可投影，不必预先持久化；首次操作创建。日期与时刻共同定位单次记录 |
| TaskEvent / task_events | taskId、occurrenceId?、kind、actorUserId、recordedAt、actualCompletedAt?、beforeVersion、afterVersion | 追加保存，撤销不删旧事件；名称、记录人均保留当时展示快照；不存身份凭据 |
| FamilyEvent / family_events | familyId、kind、actorUserId、targetMembershipId?、recordedAt、beforeVersion、afterVersion | 家庭及成员变更追加审计，不放入某一事项事件表 |
| ReminderPreference / reminder_preferences | taskId、userId、membershipId?、enabled、selfDisabled、version | 个人仅本人；家庭真实且有效可见用户；缺省 enabled 仅创建者 true、selfDisabled=false；本人关闭置 selfDisabled=true，仅本人开启可清除 |
| ReminderReceipt / reminder_receipts | occurrenceId、userId、readAt、dismissedAt、version | 每人、每次独立，不改变完成状态；取消可见后即使保留历史行也不再可读 |
| Idempotency / idempotency | actorUserId、requestId、action、payloadHash、status、result、batchProgress?、parentRequestId?、taskId? | 单项/批量父回执按 `(actorUserId,requestId)` 定位，批量子回执按 `(actorUserId,requestId,taskId)` 定位，使用不同键前缀；事务内与业务写原子保存。不设自动清理，防止旧请求重放再次创建；邀请口令响应需加密保存，见下文 |
| QuerySession / query_sessions | actorUserId、action、filterHash、asOf、scopeRevisions、expiresAt | 查询授权和15分钟有效期；不代替实时鉴权 |
| QueryCheckpoint / query_checkpoints | sessionId、checkpointId、partIndex、scanPosition、counters、boundedBuffer、expiresAt | 不可变检查点及分片，单文档≤128 KiB；游标仅含定位标识和签名 |
| MigrationJournal / migration_journal | migrationName、schemaVersion、status、checkpoint、checksum | 按环境记录迁移状态与可重跑进度；只服务端工具访问 |

邀请集合只保存 tokenHash。为支持 invitation.create 响应丢失后的相同请求重试，幂等结果中的 token 使用服务端注入密钥做认证加密（记录 keyId、nonce、ciphertext），仅原调用者仍为拥有人且邀请有效时解密返回；其他 DTO 及日志一律不含 token。密钥不得入仓库或客户端；历史 keyId 在幂等记录有效期间保留解密能力。实际 SDK 与密钥注入方式在云端适配时实现并验收。

### 事项字段

`ownerBinding` 是领域归属规则的存储表示，公开返回 `ownerUserId`（解析后的实际归属人）。不能让客户端选择或改写归属人。

`access` 保存显式 viewerMembershipIds 和 helperMembershipIds；实际归属人、有效创建者、真实执行人的必要访问权由服务端计算，不依赖客户端补齐名单。执行人必需可见，无需接单确认；新增执行人不自动取得代记他人的权限或提醒。必要执行人访问覆盖当前及保留历史次数的执行人，均须仍为有效成员；每次本人记录能力按该次片段 subject 判断，不能仅按 Task 当前 subject 判断。提醒偏好单独保存，取消可见时逻辑上立即撤销相关提醒及代记，不能等清理任务运行。

`lifecycle` 为 active / paused / stopped / deleted。只有周期允许 paused/stopped。完成与跳过属于 occurrence，不属于整个 Task。删除时保存 priorLifecycle；恢复一次性事项保持原状态，恢复周期始终 paused，保留停止历史且只能由用户另建事项替代已停止系列。为避免恢复已停止系列被误继续，DTO 同时返回 `canResume=false`。

### 已确认的编辑与提醒边界

- Task.subject 表达最新安排对象，ScheduleSegment.subject 保存各次所属片段的对象；OccurrenceDTO 和按人进度从片段解析执行人及展示名，不能用当前 Task.subject 覆盖旧次数。计划或执行人变更共用一次片段切分，旧已到时次数保留，新未来次数使用新片段；当前管理归属仍由 ownerBinding 解析。
- 改为虚拟人时最新事项归属绑定 familyOwner，改为真实人时按有效创建者（已退出则其管理承接人）解析普通归属；沿用已有归属规则并在保存前展示管理范围影响，不改变历史执行人或操作人。
- task.update 在事务内检查单次状态和历史：已完成 once 不允许改变 schedule/subject；skipped 先撤销；已有应做或操作历史的 daily/weekly 不允许改 once。返回 INVALID_STATE，不能通过全量提交绕过限制。标题和备注可编辑，事件历史保留。
- selfDisabled 表示本人明确关闭，和缺省 enabled=false 分开。reminder.setMine(false) 设置该标记；本人主动开启清除。管理者操作只能调整未被本人关闭的有效接收设置，不能写 selfDisabled。若请求把 selfDisabled=true 的他人列为接收人，返回 INVALID_STATE 并保持整次写入不变；UI 提示该成员已自行关闭。
- 本人关闭按 taskId/userId 保留；撤销可见、成员退出后重新加入或删除恢复均不清除此选择。权限失效与提醒关闭分别判断，重新有权时只有本人能解除 selfDisabled。新建时 remindMe=false 表示创建者主动关闭，设置其 selfDisabled=true。本人全量编辑中对自己 remindMe 的明确变更等同 setMine，未改变时不得重置标记。

### 默认字段限制

| 字段 | 默认值 / 上限 |
| --- | --- |
| 标题、备注 | 去首尾空白后 1–80、0–1000 个 Unicode code points |
| 用户称呼、成员称呼、家庭名称 | 1–12、1–12、1–24 个 Unicode code points |
| 用户有效家庭数 | 10；删除/退出的历史关系不占用 |
| 家庭有效真实成员、虚拟成员 | 20、20；停用虚拟成员不占有效名额 |
| 单用户个人或单家庭未删除事项 | 各 500；单次批量最多 20 项 |
| 周期 | once/daily/weekly；weekly 选 1–7 个星期，ISO 星期一为 1；最多 6 个不同的每日时刻，排序后去重 |
| 起止日期 | 2000-01-01 至 2100-12-31；结束日期可空且不得早于开始日期 |
| 补记完成时间 | 不得晚于服务端当前时间，也不得早于对应单次的本地日期起点；一次性提前完成允许早于计划日期，最早不早于事项创建时刻 |
| 列表分页 / 日期窗口 | 默认 20，最大 50；单次窗口最多 31 个本地日期；历史通过窗口与游标遍历 |
| 邀请 | 7 天；已撤销/过期不能加入，已是成员返回既有成员身份 |

用户达到容量上限时明确提示，不静默截断。上限是保护首版操作与聚合成本的工程默认，后续可按测量调整。

## 周期投影：不依赖定时函数

通过 `Clock` 提供 now，domain 用不可变计划片段投影指定日期区间的应做记录，再合并 occurrence_states。没有打开小程序也能回看历史，不需要每晚生成未来所有记录。

1. 一次性事项无日期：只在未安排列表；有日期无时刻：该日期一个 `slot=date-only`；有时刻：一个时刻。无日期不能单独设置时刻。
2. daily/weekly 按开始/结束日期（含当天）及星期生成 slot。times 为空时每天只生成 date-only，不转为 00:00 提醒。
3. 有时刻新周期只保留 `scheduledAt > createdAt` 的计划；无时刻新周期包含创建当天。正式实现遇到今天某时刻已过，跳过该时刻并预览下一有效次数，不整单拒绝。
4. occurrenceId 用固定应用 namespace `736cf0e0-7e51-468b-b869-2a7c9fe41241` 的 UUIDv5，由 JSON 数组 `[taskId,segmentId,localDate,slot]` 的规范 UTF-8 序列化派生，不做无分隔符拼接。不同日期、时刻、计划片段不会共享状态。同样输入在多个实例重算得到同一 ID。
5. 修改周期计划或执行人在服务端 now 切分；`scheduledAt <= now` 的旧次数保留，未来次数使用新片段。日期型次数以本地当日开始作为不可改写边界，创建当天的 date-only 仍特例包含一次。新片段不重复产生今天已经存在的 date-only 次数。
6. pause 截止时刻前应做和历史仍保留；恢复有时刻周期从 `> now` 的下一有效 slot 开始，日期型从下一本地日期开始；停止不再开放后续。
7. 对未来周期完成/跳过返回 INVALID_STATE；一次性可提前完成。跳过后分母排除；撤销完成或跳过恢复 pending。补记不改变下一次时间。
8. 开启提醒且有具体时刻、到时、未完成/未跳过/未删除、当前用户有效可见且接收开启，才进入到时提示；历史未完成仍可进入提醒，不局限于今天。

删除/恢复与 Task 状态同事务追加 control，以保留删除区间；恢复后周期仍 paused，只有后续 resume 才关闭暂停区间。已到时边界、date-only 创建当天特例及一次性改期指针见 [日程算法](../technical/SCHEDULING.md)。

分页不能把无限周期全部展开。先按有限日期窗口投影；提醒与积压按日期分段向过去扫描，返回 continuation 与 `complete=false` 直到扫描完成。未扫描完成时不得给出“总计 0”或“全部完成”。客户端提供“继续加载更早记录”。历史最早边界为当前可见事项的最早有效片段日期，不任意丢弃旧记录。

## 权限和退出交接

鉴权顺序：可信 Actor → 当前家庭成员关系 → 当前 Task 归属/必要访问/显式访问 → 操作能力 → expectedVersion。知道 UUID 不构成权限。读不到资源统一 NOT_FOUND；能看到但无操作能力才返回 FORBIDDEN。

- 普通家庭事项实际归属解析 membership。成员退出时，在一个小事务内写 `status=left/removed, successorMembershipId=当时拥有人` 并更新 slot、family.authEpoch 和审计。原事项不需要在一个事务内逐条更新。
- 如承接人以后也退出，沿其 successor 继续解析到有效成员；重新加入使用新 membership，不能形成身份环或恢复旧权限。归属链访问失败时整项失败，不回退给旧成员。实现检测环并拒绝异常数据，不能使用“最多查几跳”静默选错归属人。
- 虚拟事项归属绑定 familyOwner，转交家庭拥有权时随 family.ownerMembershipId 一并生效；原创建人如果仍有效继续保留管理权。
- 原创建人退出后不再靠 createdBy 取得管理权；旧 viewer/helper/提醒条目结合 membership.status 即刻失效；必要时异步清理只是存储优化。
- 拥有人先转交给 active 真实成员再退出。转交与退出是两个确认动作；转交前预览虚拟人职责，退出前预览普通归属及创建人管理职责。没有其他真实成员时拒绝退出。
- 非归属但由退出者创建的事项，创建者额外管理职责用退出 membership 的 successor 链继承；不能因此改变其实际归属人或开放全家查看。
- 聚合检索除了直接归属，还查归属链/创建管理链最终指向当前用户的原 membershipId；不只按 task.ownerUserId 索引，否则会漏掉交接事项。查候选后逐项重新鉴权。

采用以上归属间接解析方案，是为了让任意数量事项的权限交接在单个家庭事务内生效，而不进行无界事务或出现一半交接。DTO 展示的归属人会变化，历史创建人、执行人、事件保持原值。

## 持久化与并发

- 写操作携带 expectedVersion；新建由 requestId 保证幂等。事务内验证权限、版本、生命周期，写业务状态、审计和幂等结果；没有状态变化的重复命令也必须明确结果。
- 先检查同 actor/requestId 的记录。action 或 canonical payload 散列不同返回 IDEMPOTENCY_CONFLICT；相同返回原结果（重新检查现有读取权限，权限已撤销返回 NOT_FOUND 而不重放旧 DTO；退出/转交仅允许按原 actor、requestId、hash 重放无敏感详情的最小成功确认）。JSON 对象键规范排序，数组保持语义顺序。
- 同一用户重试保留 requestId 和 payload；修改输入/冲突后重新提交使用新 requestId。业务版本冲突不自动覆写；前端保留草稿、拉取最新并让用户合并。
- 所有家庭写事务读取并更新 family 写栅栏版本；权限调整同时递增 authEpoch。候选查询在事务外进行，事务里只按文档 ID 重读必要对象并验证。归属/创建管理的长链在事务外基于 family.version 快照解析；事务内重读 family 版本必须与解析快照一致，否则整次重算，不能无界读取链上的每个文档。所有链结构变更也必须递增同一 family.version。不在事务中使用 where 扫描或发起外部请求。
- 普通写控制在 80 次文档操作以内；人数上限与批量拆项使事务有界。家庭变更以 family 文档串行化，先保证正确性；未来有吞吐证据再优化锁粒度。
- 个人写以 task/version 及 UserScope.revision 容量文档保护，所有影响个人查询的写递增 revision。家庭创建/邀请接受同时更新 user 容量 guard、slot、membership；并发不能突破家庭/成员/事项限额。删除释放事项额度，恢复先校验额度再占用。
- 批量操作是最多 20 个单项事务，不是跨家庭总事务。外层幂等记录保存逐项进度；每项用 `(actor,requestId,taskId)` 独立结果键，输入 taskId 不得重复，单项归属与权限一并提交。受8秒应用预算约束，一次调用可返回 complete=false 与 pending；相同 ID 和完整 payload 继续未提交项。complete=true 后只重试失败项并使用新 requestId/最新版本。
- 读取跨家庭数据时记录每个 scope 的 authEpoch/version，投影后复查；改变则重新读取，最多 2 次，仍冲突返回该 scope 暂不可用。不得返回一半旧权限的数据。前端清除失权缓存；服务端不能撤回已在屏幕上看过的信息。
- reminder.setMine 及管理者权限写在同一事务内检查 selfDisabled，防止并发绕过本人关闭；检查本人偏好版本，并同时递增 Task.version；管理者全量提交 access 必须检查 Task.version，避免覆盖别人在编辑期间修改的提醒设置。取消可见则在同一权限事务内使其偏好失效。
- 记录完成和撤销的竞争，以 occurrence version 解决；首次从投影 pending 写入使用 expectedVersion=0；确定性 ID 避免双创建；完成/撤销同时递增 Task.version 与 scope revision，防止完成和改期同时依旧状态成功。

## 索引、迁移与运维边界

| 集合 | 必需查询索引（按顺序） |
| --- | --- |
| user_scopes | userId 确定性文档键 |
| membership_slots | userId；familyId（slot 文档键保证组合唯一） |
| memberships | familyId/status；familyId/successorMembershipId |
| virtual_members | familyId/status/createdAt/id |
| invitations | familyId/createdAt/id；tokenHash 唯一 |
| tasks | familyId/lifecycle/createdAt/id；familyId/ownerBinding.membershipId；familyId/creatorMembershipId；ownerBinding.userId/lifecycle |
| schedule_segments | taskId/effectiveFrom/id |
| schedule_controls | taskId/effectiveAt/id |
| occurrence_states | taskId/localDate/id；occurrence 文档键保证单次唯一 |
| task_events | taskId/recordedAt/id |
| family_events | familyId/recordedAt/id |
| reminder_preferences | userId/enabled/taskId（文档键 taskId/userId） |
| reminder_receipts | userId/occurrenceId（文档键 occurrenceId/userId） |
| idempotency | actorUserId/requestId（确定性文档键，批量子项再含 taskId）；status/updatedAt |
| query_sessions | expiresAt/id |
| query_checkpoints | sessionId/checkpointId/partIndex；expiresAt/id（清理用） |
| migration_journal | migrationName（文档键） |

家庭最多 500 项，首版可分页读取家庭候选后服务端按 access 过滤，不能将全部候选发给客户端；个人按 user 索引查。索引是否需要专用数组能力不作依赖。

实施时新增独立、可重跑的迁移脚本：创建集合/索引 → 校验只允许服务端访问 → 小数据回填 → 对账 → 接入业务 action。以 schemaVersion 标记记录格式，应用至少兼容上一个版本；回滚切回兼容代码，保留数据和审计，不删除集合抵消迁移。正式环境操作仍需当次授权。

2026-09-11 核对依据：CloudBase 的[事务文档](https://docs.cloudbase.net/database/transaction)列出仅服务端、最多 100 个操作、30 秒及事务内不支持 where 的限制；因此本设计使用有界按 ID 事务与归属间接解析。微信身份入口参考[小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)，只使用可信上下文的身份；生产接入时再锁定 SDK 版本并做真实环境集成测试。本次不调整既有运行时或安装 SDK。
