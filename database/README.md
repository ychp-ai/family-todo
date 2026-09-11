# 数据库

当前不创建业务集合、索引、初始化数据或迁移脚本。

后续新增存储时在此维护集合和索引说明，迁移脚本放 tools/migration；按实际 schema 创建目录。规则位于 domain/application，数据库实现在 infra-cloudbase，通过 ports 访问。

公开 DTO 使用应用 ID、普通 JSON 字段和 UTC 时间字符串，不携带 CloudBase 专有类型。schema 变更同步记录迁移及回滚方式。
