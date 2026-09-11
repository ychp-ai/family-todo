# 数据库

当前不创建业务集合、索引、初始化数据或迁移脚本。

后续新增存储时在此维护集合和索引说明，迁移脚本放 tools/migration；按实际 schema 创建目录。规则位于 domain/application，数据库实现在 infra-cloudbase，通过 ports 访问。

公开 DTO 使用应用 ID、普通 JSON 字段和 UTC 时间字符串，不携带 CloudBase 专有类型。schema 变更同步记录迁移及回滚方式。

拟建集合、字段、查询索引、迁移及回滚边界已整理在 [业务数据模型](../docs/business/DATA_MODEL.md)。该文档是实施方案，尚未创建任何业务资源。

事务预算、用户/家庭写栅栏、幂等回执和查询会话见 [一致性与数据访问](../docs/technical/CONSISTENCY.md)。正式迁移须同时建立业务与技术集合、服务端权限规则及 migration journal；过期查询会话可由运维工具清理，审计和幂等结果不在该清理范围。
