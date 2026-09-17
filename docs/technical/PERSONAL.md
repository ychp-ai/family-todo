# 个人一次性待办实现

本文保留个人一次性待办阶段的实现与兼容基线：`familyId=null`、`subject.kind=self`、`schedule.kind=once`。家庭协作阶段已扩展同一契约与事项路由，新增共享参与者、家庭归属及15个事项/提醒 action；现行差异以 [家庭协作实现](FAMILY.md)、[客户端实现](CLIENT.md) 和 [当前范围](../SCOPE.md) 为准。周期现由独立日程片段、控制区间与稀疏次数状态支持，见 [日程实现](SCHEDULING.md)；本节以下保留一次性阶段说明。

以下 API 数量、适配器、重试次数及页面入口描述对应 2026-09-11 个人阶段；当前服务端由协作用例统一处理个人与家庭数据，既有个人实体及回执保持兼容。

## API 与分层

个人阶段接入 14 个 action：task.create/get/list/update/delete/restore/recycleList/history、occurrence.record/undo、reminder.list/setMine/markRead/dismiss。连同 system.health、identity.ensure，共 16 个 action。

contracts/personal.ts 严格校验输入、公开 DTO 和返回结果；domain/personal.ts 负责上海日期、一次性时刻和提醒判断；application/personal.ts 装配用例、归属校验和事务；ports/personal.ts 定义持久化接口；infra-cloudbase/personal-store.ts 实现数据库和签名游标。所有业务身份经可信微信映射获得，客户端不可指定 actor。

## 存储与一致性

一次性事项只有一个当前次数，日程片段、次数状态、提醒偏好暂存于 tasks 聚合文档；不提前创建周期片段、协作成员或次数集合。新增及变更同时写入 tasks、user_scopes、task_events、idempotency_receipts。后续支持周期时须显式迁移，保留现有 task/segment/occurrence UUID 和事件，不可直接套用蓝图中的多集合字段。

回执键为 SHA-256([actorId,requestId])，指纹覆盖 action 和字段排序后的请求内容；同 ID 不同内容返回 IDEMPOTENCY_CONFLICT。命中回执仍校验当前用户对事项的归属。回执无自动过期，响应丢失后能读到原结果。UUID 候选在事务重跑前生成并固定。仅明确事务冲突会退避重跑，最多四次；SDK 已回滚后再开启新事务。真实 wx-server-sdk 4.0.2 会把冲突码包装进 Error.message，适配器同时识别明确的 ResourceUnavailable.TransactionConflict 标记。

task.version、occurrence.version、myReminder.version 分别保护对应修改；每次写入递增 user_scopes.revision，让并发列表会话失效。删除/恢复调整 500 条活跃个人事项额度，历史保留。完成或跳过后必须先撤销才能修改日程；改变日程生成新片段和次数 ID，旧次数引用拒绝。实际完成时间不可晚于服务器当前时间。

## 查询与提醒

列表默认上海今天，支持最多 31 天区间、未安排、积压、状态、回收站和历史查询。每页 20，最大 50。签名游标绑定 actor、请求条件（含 limit）、revision、asOf，15 分钟有效；每页扫描前后核验 revision。统计只在 complete=true 时返回，客户端收齐分页后才更新显示。修改期间返回 CURSOR_EXPIRED，客户端重新扫描。

提醒只针对待处理、有具体日期时刻、已到时且开启个人提醒的事项。无时刻不默认午夜。已读和收起独立于完成状态；includeDismissed 可查看收起项。没有订阅消息或定时函数。

## 小程序

首页、详情、编辑、回收站均经 services 访问 API。真实胶囊和状态栏高度由系统 API 取得，不绘制假系统栏。个人阶段保留设计稿并为当时未实现的家庭/批量操作给出提示；家庭入口现已接入。回收站通过详情设置进入，删除后跳转回收站，未另加设计稿之外的首页入口。

首页/详情 onShow 加载（首页有效的短期缓存可复用），隐藏/卸载隔离旧响应；取消前台定时刷新和失败定时重试，读取失败由用户主动重试。静置期间不自动同步协作修改、到期提醒或跨天状态，进入页面、操作后及手动刷新时更新。写入期间冻结后台加载；未知结果保留原 action/payload/version，用户重试使用同一 requestId，避免超时后的“完成”误变为“撤销”。编辑保留草稿并显式解决版本冲突。回收站恢复也保留未决版本。关闭进程后的未决操作支持按可信账号保存并主动确认，详见 [异常恢复](RECOVERY.md)；不自动重放。

微信 getRandomValues 返回的 ArrayBuffer 可能来自另一个 JS realm，UUID 生成通过原生 ArrayBuffer.slice 验证和复制，不使用 instanceof 判断，也不回退 Math.random。微信云调用自动附加 userInfo/tcbContext，入口仅剥离这两个传输字段，身份仍只读取本次可信 context。

## 验证边界

本地覆盖事务四个写点失败回滚、幂等重放、并发冲突、不同用户隔离、旧引用拒绝、容量、提醒和签名分页，以及客户端超时/迟到响应和 SDK 冲突包装。真实云端结果见 [发布记录](CLOUD_DEPLOYMENT.md)。异常恢复已补齐本地服务重建与 Page 行为测试；两真实账号隔离、iOS/Android 真机、平台进程重启持久化验收及 SDK 依赖告警处理仍未完成。
