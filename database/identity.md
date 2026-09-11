# 身份数据存储与接入

仅完成本地适配，尚未创建以下集合、索引或权限规则。首次真实写入前必须完成权限验证和接入记录，不能通过调用 ensure 隐式创建集合。

| 集合 | 文档键 | 字段 | 查询索引 |
| --- | --- | --- | --- |
| identities | SHA-256(JSON.stringify([provider, appId, subject])) | provider=wechat、appId、subject、userId | 仅内置唯一 `_id` |
| users | 应用 UUID | displayName | 仅内置唯一 `_id` |
| user_scopes | userId | userId、revision、activeFamilyCount、personalTaskCount | 仅内置唯一 `_id` |

三类文档均包含 schemaVersion=1、version=1 起始、createdAt/updatedAt（UTC RFC3339 毫秒）。领域 User.id 映射 users._id，DTO 只公开 id/displayName/version。身份散列仅用于服务端定位映射；不作为业务 ID，不将 OpenID 用作用户 ID。

创建时在一个事务内按键读取映射，存在则读取关联用户；不存在则确认随机 UUID 无冲突，并一次提交用户、零计数容量文档和映射。事务最多 6 次文档操作；冲突交给 SDK 最多重试 2 次。网络响应丢失后的再次调用使用相同映射键，不会重复建用户。该唯一键是 identity.ensure 的幂等依据，尚未实现其他业务写入使用的 requestId 回执。

缺失用户、畸形文档、写入失败均明确报错；不把异常当作“未注册”。get 的 throwOnNotFound=false 仅将不存在文档映射为 null，集合不存在和平台异常仍应失败。

接入步骤：核对目标环境及同名集合 → 建立上述集合并设置客户端 read=false/write=false → 验证真实客户端不能直读写 → 验证两实例首次初始化与冲突回滚 → 核对每个映射有且只有一个 users 和 user_scopes → 记录迁移、权限与验证结果 → 开启身份入口。当前没有已有业务数据，不需回填；后续迁移工具须可重跑，复用已正确配置的集合，不覆盖已存在用户。

回滚先关闭身份发布开关、恢复兼容版本，保留集合和身份映射；不删除数据，也不重新生成已有用户 UUID。后续 schema 升级需增加显式兼容和迁移，不能覆盖未知 schemaVersion。
