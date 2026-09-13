# 家庭协作存储

状态：8个新增集合与家庭索引已在现有环境建立，实际命令与核验以 `family-provision-result.json` 与家庭发布记录为准。迁移在开启家庭云入口前执行，保留已有个人事项与身份数据。

## 集合与键

新增 8 个集合，均 `ADMINONLY`，仅 api 云函数访问。沿用既有 7 个集合，完成后共 15 个集合。

| 集合 | 文档键 | 内容 |
| --- | --- | --- |
| families | family UUID | 名称、ownerMembershipId、version/authEpoch、有效事项/真实/虚拟成员计数 |
| memberships | membership UUID | familyId/userId、家庭称呼、active/left/removed、successorMembershipId、version |
| membership_slots | SHA256(JSON([familyId,userId])) | activeMembershipId 或 null；active 用于用户家庭索引 |
| virtual_members | virtual UUID | familyId、称呼、active/inactive、version |
| invitations | invitation UUID | familyId、tokenHash、创建者 membershipId、到期/撤销时间；不保存原口令 |
| family_events | event UUID | 操作者业务 userId、目标成员、家庭前后版本、操作时间 |
| reminder_preferences | SHA256(JSON([taskId,userId])) | 当前 membershipId、enabled/selfDisabled/version |
| reminder_receipts | SHA256(JSON([occurrenceId,userId])) | 每人每次 readAt/dismissedAt/version |

实体仍使用 schemaVersion=1。tasks 的个人字段保持兼容；家庭事项增加顶层 familyId（索引）与 collaboration（familyId、creatorMembershipId、createdByUserId、ownerBinding、subject/subjectName、可选 occurrenceSnapshot、显式查看/代记名单）。公开 ownerUserId 由当前成员链解析，不直接采用个人兼容字段。旧个人读取器拒绝带 collaboration 的文档，防止按创建者错误读取家庭事项。

提醒与幂等为不同集合：idempotency_receipts 继续使用 SHA256(JSON([actorUserId,requestId]))，family action 和 task action 共享唯一命名空间。兼容字段 taskId 存放本次资源 UUID；新增 resourceKind/familyId/ownerOnly/minimumConfirmation 指示重放检查，result 为已提交结果。退出/转交及修改后失去查看权的 task.update 只保存 API 最小确认。邀请创建结果认证加密，重放前检查原调用者仍为拥有人且邀请有效。

query_sessions 中家庭查询采用 schemaVersion=2、purpose=family，随机32字符会话 ID 和服务端 HMAC 签名。检查点不可变、15分钟有效、序列化最多128KiB。确认预览另存5分钟 token。个人旧会话保持原schema读取；无需批量改写。

## 索引与迁移

运行前通过 CLI 核对 cloudbaserc.json 环境及数据库 InstanceId。工具默认只输出计划，不执行资源写入：

```sh
TCB_CLI=/已核验的/cloudbase/cli.js TCB_DATABASE=已核验的数据库 node tools/migration/provision-family.mjs
TCB_CLI=/已核验的/cloudbase/cli.js TCB_DATABASE=已核验的数据库 node tools/migration/provision-family.mjs --apply
```

工具按名称检查集合与索引，缺失时创建；逐集合设置并读取 ADMINONLY；再次查询索引，写 migration journal。重复运行不删除已有数据或索引。tokenHash 另建唯一索引；成员槽通过确定性键与事务保证一个家庭/用户最多一个有效身份。退出后重新加入生成新 membership UUID。

| 查询 | 复合索引字段 |
| --- | --- |
| 用户家庭 | membership_slots(userId,active) |
| 成员历史/有效名单 | memberships(familyId,listOrder)、(familyId,status,listOrder) |
| 虚拟成员历史/有效名单 | virtual_members(familyId,listOrder)、(familyId,status,listOrder) |
| 邀请管理/口令查找 | invitations(familyId,listOrder)、(tokenHash,listOrder)、unique(tokenHash) |
| 家庭事项日期/回收 | tasks(familyId,lifecycle,scheduleOrder)、(familyId,lifecycle,createdOrder) |
| 家庭状态/提醒 | tasks(familyId,lifecycle,status,scheduleOrder)、(familyId,lifecycle,status,recentOrder) |

既有个人索引、task_events(taskId,eventOrder) 保留。家庭协作在候选扫描后按实时权限过滤，无权内容不进入结果或摘要。每次扫描上限200，空续页代表仍在扫描，不代表无数据。

## 一致性与回退

所有家庭写持有 family.version 栅栏；成员/权限变更递增 authEpoch。用户加入退出同时更新 user_scopes 家庭计数与revision。事务最多80次文档读写，不在事务中扫描无限集合或调用外部服务。

退出只修改 membership/successor/slot/user scope/family/审计/回执，事项不逐条更新。家庭读取加载最多20有效成员与20有效虚拟成员，并按本次事项需要读取完整历史继承链；循环或缺失链导致请求失败，不能回退旧归属。家庭版本前后保持一致后，事务内再次核验。

上线回退不得清空家庭集合或让旧个人 api 接管家庭数据。需保持兼容读取与旧个人隔离，关闭新增入口并修复后再部署。不能通过删除成员历史、偏好、审计或回执恢复旧状态。
