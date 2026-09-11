# 日程与记录算法

以 [需求](../REQUIREMENTS.md) 为准。所有算法在 domain 中实现，显式传入 Clock 的服务端时间；不依赖客户端时钟、不启动定时函数。本文件是待实现算法和测试输入，未将浏览器 demo 当正式引擎。

## 值对象与时间边界

- LocalDate 严格校验公历存在性，范围2000–2100；LocalTime 为24小时 `HH:mm`；ISO weekday 1–7。Instant 采用 UTC RFC3339 毫秒。
- 日期枚举使用年月日历运算；不把 `new Date('YYYY-MM-DD')` 的 UTC 解释当上海当天。范围2000–2100内按 Asia/Shanghai（UTC+08:00）转换，限制范围的依据和测试写在 calendar 模块；将来扩展时区或历史范围须另行设计。
- 先验证年月日，再允许加天/月末进位；不能让 Date 自动把2月30日修正成3月而通过校验。
- 有时刻的 `scheduledAt = localDate + localTime` 转UTC；date-only 的 scheduledAt=null，但 eligibilityBoundary 是本地当日开始。无日期一次性没有日历边界。
- 系列开始、结束日期两端包含；有时刻周期以 `effectiveFrom < scheduledAt <= effectiveUntil` 归属片段（until=null 表示无上界），使切分时刻已到时的旧次数保留；date-only 使用下文当天特例，once 使用有效片段指针。服务端 now 等于一个周期时刻时，已到时旧次数保留，新建/恢复的该时刻不生成。

建议纯函数：`parseLocalDate`、`addDays`、`isoWeekday`、`toInstant`、`enumerateSlots`、`projectOccurrences`、`splitSchedule`、`transitionLifecycle`、`canRecordOccurrence`。domain 不依赖 crypto 或 contracts；UUIDv5 由端口实现，传入规范化身份元组后返回ID。

## 数据分工与身份

Task 保存最新内容、所属家庭、当前 subject、当前计划指针、归属和权限；ScheduleSegment 保存不可改写的计划内容、执行对象、展示名快照及生效区间。关旧片段只允许设置原为空的 effectiveUntil；不更改其 schedule/subject。ScheduleControl 按 task 生效，segmentId 仅作审计关联，不能使编辑后的新片段绕过已有暂停。

单次规范身份元组为 JSON 数组 `[taskId,segmentId,localDate,slot]` 的固定UTF-8序列化结果，不能用无分隔符的字符串相加。slot 为 `HH:mm`、`date-only` 或 `unscheduled`；用数据模型指定 namespace 派生 UUIDv5。UUID不是凭证。

没有实际操作时只投影 pending/version=0；首个完成、跳过或撤销后的状态才持久化。所有请求带 OccurrenceRef，服务端重新校验所属、片段、日期/时刻、控制区间与UUID。已失效的旧未来引用不能生成记录，返回 INVALID_STATE 并提示刷新。

OccurrenceDTO.subject 使用该片段的执行对象；TaskDTO.subject 仅表示最新安排。在 DTO 中将 self 解析成稳定用户身份语义，读取者不能把“创建者自己”误解为“当前查看者自己”：draft 允许 `{kind:'self'}`，个人保存为 userId、家庭保存为当前 membershipId；输出采用 `{kind:'user',userId}` / member / virtual 的 ResolvedSubject。历史成员退出后仍可展示快照，但不因快照获得权限。

## 投影步骤

输入为 task、有限日期窗口、片段迭代器、control 区间、稀疏状态、now；返回有序记录迭代器及扫描位置。

1. 检查正常列表是否允许该 lifecycle；deleted 只经回收入口访问，不投影进提醒/进度。
2. 取与窗口相交的片段。daily 枚举每个有效日期，weekly 先过滤ISO weekday。times=[] 每日一次 date-only，否则按已排序去重时刻枚举。
3. 按片段生效边界、系列起止、创建时刻和暂停/删除/停止控制区间过滤；不同片段不能生成相同的逻辑旧次数。
4. 构造确定性 ref，合并其 OccurrenceState；未存在则 pending/version=0。操作状态不能改变计划日期、片段或下一次数。
5. 输出该次 subject、status、scheduledAt 和按当前权限计算的 canRecord，排序与去重后交给查询层。提醒再叠加当前 preference/receipt 条件。
6. 达到查询计算预算后暂停迭代，保存位置；不能把预算用尽当作系列结束。

未来次数可以展示计划，但不能记录完成或跳过。当天多时刻独立；无时刻次数今天可操作。一次性可提前完成，区别于未来周期限制。

## 新建与编辑

| 操作 | 旧次数 | 新安排 |
| --- | --- | --- |
| 今天18:30新建每日08:00/20:00 | 无 | 今天20:00及后续，不补今天08:00 |
| 今天18:30新建每日无时刻 | 无 | 今天一次，后续每天一次 |
| 今天18:30把08:00/20:00改成19:00 | 今天08:00保留；旧20:00引用失效 | 今天19:00开始 |
| 今天18:30周期由爸爸换成妈妈 | 今天已到时次数仍爸爸 | 下一有效次数妈妈；不授予妈妈代记爸爸的权限 |
| 今天无时刻系列换人 | 今天已存在次数仍旧人 | 新人从下一有效日期开始 |
| 未完成once改日期/时刻/执行人 | 旧计划引用失效，旧审计不删 | 新片段产生唯一有效pending，不新增重复待办 |
| 已完成once改安排 | 保留原安排 | INVALID_STATE；另建事项 |
| 已有历史周期改once | 保留历史 | INVALID_STATE；停止后另建 |

周期 schedule 或 subject 真正变化时才切分片段，改标题/备注/权限不新建片段。old.effectiveUntil=effectiveAt，新片段从 effectiveAt 生效；有时刻新slot必须严格晚于 effectiveAt。date-only 当天旧次数保留，不从新片段再生成一次同日date-only；新建当天特例单独表示为片段 allowCreationDay，不复用于恢复或编辑。

一次性pending改安排不受“已到时不可改未来片段”的周期限制；从 Task 的 activeOnceSegmentId 指向新片段，旧一次性引用失效但事件可回看。被撤销成pending的事项允许按未完成规则编辑；已完成状态下不得通过一次 update 隐式撤销并改期。skipped 也须显式撤销。

“已有历史”包括已经产生的应做次数，即使尚未落库也算；不能只通过 occurrence_states 是否为空判断是否允许周期转once。

标题/备注的当前展示跟随 Task；审计保存修改时的快照。历史执行对象名称采用片段快照，改名后当前成员列表用新名，历史显示当时名并可标注当前称呼；身份始终按ID而非名称。

## 生命周期与控制区间

| 当前状态 | 动作 | 结果及次数影响 |
| --- | --- | --- |
| active周期 | pause | paused；已经到时保留，后续暂停 |
| paused且未stop | resume | active；下一有效时刻继续；无时刻从下一有效日期 |
| active/paused周期 | stop | stopped；终止后续，历史/积压可记录 |
| 非deleted | delete | deleted；正常列表、提醒、统计隐藏全部 |
| deleted一次性 | restore | 原单次状态，重新鉴权及容量检查 |
| deleted周期 | restore | paused；已停止者 canResume=false |

控制事件以服务端逻辑顺序保存（同毫秒用单调 task/control version 排序），还原出暂停与删除的禁用区间。对于已存在周期，控制动作发生时刻本身已到时的slot保留，后续slot排除；恢复时刻本身不新生成slot。不能简单用一组未经边界处理的 `[pause,resume)` 比较覆盖这些规则。

暂停系列在暂停期间编辑，只记录未来计划变更，新片段仍受 task 级暂停控制；直到resume才出现新次数。停止后不通过编辑或恢复取消stop，另建才有新系列。delete→restore→resume全过程不补删除或恢复暂停期间次数。

date-only 的生成边界是当天开始；当天中途pause仍保留当天次数，第二天才无次数；当天resume不补暂停期间缺失的今天次数。已有当天旧次数也不能重复产生。

## 记录、提醒与进度

completed 的实际时间不得晚于服务端now。周期补记不得早于该次本地日期起点，允许当天早于具体计划时刻的实际完成时间，但只能在该周期已到时后提交。一次性提前完成不得早于事项创建时刻。skipped 不含实际完成时间；系统 recordedAt 与用户填写时间分开。

完成与跳过只能从pending进入；撤销回pending并追加事件。原执行人、当前管理者、有效代记者按当前权限记录，operatorUserId永远来自Actor。撤销他人记录仍保留原事件，不伪装原操作者。

提醒满足：当前可见有效真实接收人、enabled=true且selfDisabled=false、有时刻且到时、pending、未删除。已读/收起只读当前用户receipt；撤销完成重新判断到时条件，但不重置本人的既有已读/收起选择。下一次ref不同，自带新receipt状态。

进度按所选日期、家庭、各次subject及当前可见范围聚合。denominator=completed+pending，skipped单列。未来周期次数在选定日期的安排总量中计入pending，但 canRecord=false；首页提醒仅含已到时。未完整扫描不返回最终计数。

## 必测边界

所有测试注入Clock，使用精确瞬时；例如上海2026-09-11 18:30对应 `2026-09-11T10:30:00.000Z`。

- 月末、闰日、周日到周一、23:59到次日、起止同日与无下一次；2月30日拒绝。
- new/edit/pause/resume与slot恰好同一毫秒；新建不生成该slot，已有已到时slot保留。
- date-only新建当天、编辑当天、暂停当天、恢复当天分别测试，避免共用错误特例。
- 今日08:00/20:00已有08:00历史，18:30改19:00或换人；08:00身份不变，旧20:00不可记录。
- 连续多次修改形成多片段，扫描重复分页，结果等于同范围完整投影且无重复ref。
- 暂停跨两天、暂停时编辑、删除后恢复、已停止再删除恢复；不补缺口、不重启停止系列。
- 未完成once改日期后只有一个有效ref，旧ref请求失败；完成与改期并发只能一个成功。
- 随机有效周期：窗口拆分再合并等于完整窗口；重复投影完全一致；完成某次不改变其余次数。
