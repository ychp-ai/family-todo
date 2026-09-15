# 数据库

现有环境共19个集合，均为 ADMINONLY，仅服务端读写。身份数据、个人事项和回执见 [身份数据](identity.md)、[个人待办数据](personal.md)；新增家庭、成员、邀请、协作提醒等8个集合及索引见 [家庭协作存储](family.md)。实际迁移操作与核验结果保存在对应 provision-result.json。

周期后端及新增 4 个集合和索引已部署并核验，见 [周期存储](recurrence.md)、[迁移记录](recurrence-provision-result.json) 与 [真实云端验证](recurrence-verification-result.json)。[首版完整数据模型](../docs/business/DATA_MODEL.md) 描述业务字段。迁移脚本默认只展示计划，`--apply` 才变更；运行前核对环境与数据库。重复执行保留已有数据。

2026-09-15 性能优化及 3 个新增索引已部署，见 [性能落地记录](../docs/technical/API_PERFORMANCE_IMPLEMENTATION.md) 和 [索引迁移记录](performance-provision-result.json)。查询会话清理工具尚未执行。
