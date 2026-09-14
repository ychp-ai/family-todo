# 个人待办数据与迁移

2026-09-11 使用 CloudBase CLI 3.8.1 在既有环境 family-todo-d3g28fx1c314f8638、数据库 tnt-5up4jdfvg（MongoConnector.InstanceId=flexdb）创建七个集合。建前 ListTables 返回空；每个集合创建后立即设为 ADMINONLY，再查询 ACL 验证，随后建立索引。实际平台 RequestId 留存于 [迁移记录](personal-provision-result.json)。

| 集合 | 文档键和职责 |
| --- | --- |
| users | 应用 UUID；称呼、版本、创建/更新时间 |
| identities | 平台身份摘要；服务端私有身份映射 |
| user_scopes | 用户 UUID；个人活跃数、家庭数、revision、元数据 |
| tasks | task UUID；个人一次性聚合、次数/提醒版本、逻辑删除、排序字段 |
| task_events | event UUID；事项、事件类型、实际操作人称呼、记录/实际时间、备注 |
| idempotency_receipts | SHA-256([userId,requestId])；请求指纹、taskId、原响应 |
| query_sessions | 随机 24 字节编码；actor、查询指纹、revision、asOf、位置、统计、expiresAt |

领域与存储隔离：tasks 保存 schemaVersion=1，_id 对应公开 id；日期/瞬时字段都是可校验字符串。一次性次数与偏好暂在聚合内，未来周期和家庭迁移必须显式映射，保留已有 ID、历史与回执。公开 DTO 不含 _openid、fileID 或 SDK 类型。

全部升序复合索引：

| 集合 / 名称 | 字段顺序 |
| --- | --- |
| tasks / personal_schedule | ownerUserId, lifecycle, scheduleOrder |
| tasks / personal_created | ownerUserId, lifecycle, createdOrder |
| tasks / personal_status_schedule | ownerUserId, lifecycle, status, scheduleOrder |
| tasks / personal_recent | ownerUserId, lifecycle, status, recentOrder |
| tasks / personal_reminders | ownerUserId, lifecycle, status, reminderEnabled, dismissedAt, recentOrder |
| tasks / personal_all_reminders | ownerUserId, lifecycle, status, reminderEnabled, recentOrder |
| task_events / task_history | taskId, eventOrder |

scheduleOrder 为日期/时刻/id，未安排排末尾；createdOrder 与 eventOrder 为反向毫秒值/id；recentOrder 按反向固定 31 天窗口、日期、时刻、id 排序。范围条件另检查 date/scheduledAt，索引与实际查询共同验证。集合保留系统 _id 唯一索引。

执行（仓库根目录；TCB_CLI 指向已安装 CLI 的 JS 入口）：

```sh
TCB_DATABASE=tnt-5up4jdfvg node tools/migration/provision-personal.mjs
TCB_DATABASE=tnt-5up4jdfvg node tools/migration/provision-personal.mjs --apply
```

脚本从忽略配置读取目标 envId；先核对 DescribeEnvs 确认数据库，再设置环境变量。脚本只创建缺失集合/索引、配置服务端权限；不删除或覆盖已有业务文档。重复执行会再次校验权限并产生新的执行记录，历史记录应留存。

验收：开发者工具以真实小程序身份对七个集合分别尝试一次 get 和指定探针 ID 的 set，全部返回 -502003，未创建探针。服务端身份和个人业务事务可读写；并发同请求新增只有一件，完成竞争返回一个成功和一个 VERSION_CONFLICT。事务四个写点失败回滚当前由本地模拟验证。

回滚优先关闭服务端身份/业务开关或部署兼容旧代码，保留数据与回执，不以删集合回退版本。query_sessions 读取时强制 15 分钟有效；目前没有 TTL 清理，过期文档需后续按 expiresAt 管理。幂等回执不自动清理，不能随意缩短重试保障。临时验收事项经业务删除移入回收站，保留验证历史。
