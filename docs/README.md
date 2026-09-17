# 项目文档

- [成本优化验收记录](technical/COST_OPTIMIZATION_ACCEPTANCE.md)：发布后的同负载测量口径、待采集指标与回退要求。
- [数据库与云函数成本优化计划](plans/cost-optimization.md)：成本基线、查询与执行复杂度优化、存储治理、分阶段实施及验收标准。

- [首版业务需求](REQUIREMENTS.md)：已确定的产品规则、四个使用场景和验收要求，个人与家庭一次性待办已实现，实际验收见发布记录，周期待开发。
- [界面设计稿与图标](../design/README.md)：可在浏览器中预览的交互设计稿、视觉规范和图标资源，使用本地示例数据。
- [开发交付与验收映射](business/DELIVERY.md)：开发顺序、模块验收与真实环境联调边界。
- [业务数据模型](business/DATA_MODEL.md)：字段、归属交接、周期投影、索引和事务方案。
- [业务接口契约](business/API.md)：首版 action 蓝图、DTO、权限、分页、错误和请求示例。
- [接口调用示例](business/API_EXAMPLES.md)：健康调用、初始化、分页、记录、邀请交接与重试。
- [云函数 CLI 发布记录](technical/CLOUD_DEPLOYMENT.md)：目标环境、单函数映射、创建命令与真实云验证状态。
- [页面流程与状态](business/INTERACTIONS.md)：完整编辑、家庭邀请和交接、记录与回收、冲突恢复。
- [当前范围](SCOPE.md)：架构验收与未实现内容。
- [首版技术方案](TECHNICAL_DESIGN.md)：仓库改造点、模块职责、身份入口、依赖和实施门槛。
- [一致性与数据访问](technical/CONSISTENCY.md)：事务预算、幂等、交接、批量续跑及分页会话。
- [日程与记录算法](technical/SCHEDULING.md)：时间边界、确定性单次身份、计划切分和生命周期。
- [小程序实现方案](technical/CLIENT.md)：会话、局部状态、请求重试、缓存清理与前台提醒。
- [开发指南](DEVELOPMENT.md)：初始化、预览和环境接入。
- [AGENTS.md](../AGENTS.md)：全仓库协作约定。

业务开发设计已补齐；正式实现时同步维护契约和技术文档，实现状态以当前范围为准。

- [个人待办实现](technical/PERSONAL.md)：当前 API、存储、页面和验证边界。

- [家庭协作实现](technical/FAMILY.md)：当前家庭、邀请、成员交接、权限与多家庭查询。
