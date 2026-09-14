# 家庭协作实施计划

依据：docs/REQUIREMENTS.md、docs/business/DELIVERY.md 第 3 步，以及 API / DATA_MODEL / CONSISTENCY / INTERACTIONS。个人一次性能力已上线，当前实现本步骤全部协作闭环；周期与批量仍属后续阶段。

## Global Constraints

- 原生页面严格对照 `design/` 已有设计稿实现，不自行调整布局、样式、文案及交互；样稿未覆盖的业务边界仍以确认需求为准。
- 不修改此前未提交改动来消除差异；不提交、推送、合并。用户当前会话已授权 API 更新后自动部署既有环境。
- 核心分层及 unknown 运行时校验不变，所有业务鉴权来自本次可信上下文。业务 ID 为 UUID，时间为 UTC RFC3339 毫秒；时区 Asia/Shanghai。
- 完整包含邀请撤销、退出、转交、交接与撤权；家庭拥有人不能读取普通私密事项，角色称呼不授予权限。不得以仅加入的半套模型上线。
- 10 家庭、20 真实+20 有效虚拟成员、每家 500 活跃事项；事务不扫描集合且最多 80 文档操作。退出通过成员 successor 链原子生效，不逐条搬运事项。
- 邀请 7 天，16 随机字节/22 base64url 字符，散列存储；幂等回执中的口令认证加密。仅原拥有人仍有权且邀请有效时重放口令。
- 本人关闭提醒优先，按 taskId/userId 持久化；撤权、重新加入、恢复不重置。可见、可代记、提醒独立。
- 既有个人事项与回执保持兼容。家庭动作与事项写回执共享 actor/requestId 唯一命名空间，退出转交只重放最小确认。
- 读扫描有界分页、签名游标绑定 actor/条件/scope version；失权拒绝，不返回伪完整统计。

## Task 1: 家庭与协作契约

仅修改 packages/contracts/src/family.ts、personal.ts、action-map.ts、api.ts、index.ts 及对应 contracts 测试。阅读 API 文档身份与家庭表，实现 family.list/create/get/update、member.list/rename、invitation.create/list/preview/accept/revoke、virtualMember.list/create/update/deactivate、family.previewExit/exit/previewTransfer/transferOwnership 共 19 个 action。identity.update 暂不属于本任务；若实际数目不同以逐项 action 清单为准。

导出 FamilyActionMap/FamilyAction/FAMILY_ACTIONS/isFamilyPayload/isFamilyData，所有公开 DTO 按 API 文档定义（FamilySummary/FamilyDTO/MemberDTO/VirtualDTO/InvitationSummary/ExitPreview/TransferPreview）。严格拒绝未知字段、非法 ID、版本、token、日期、长度。避免 unchecked 类型断言、any。限制名称 Unicode code points，分页默认/上限按现有约定。复用 personal.ts 的通用验证 helper。

扩展既有一次性事项契约：PersonalDraft 保留名称作为兼容别名，另导出 TaskDraft、AccessInput、Subject、ResolvedSubject、ParticipantDTO；familyId 可 UUID/null，家庭 subject 可 self/member/virtual，个人仍仅 self 和空名单。TaskDTO/OccurrenceDTO/ReminderDTO/AggregatePage 扩展家庭字段与权限；禁止周期。给 PersonalActionMap 与 PERSONAL_ACTIONS 添加 task.setAccess。isPersonalPayload/isPersonalData 保留原函数名但覆盖家庭一次性需求。ActionMap 合并 FamilyActionMap，新错误码如 INVITATION_UNAVAILABLE/PREVIEW_EXPIRED 同步 api 错误码 guards。

行为测试覆盖每类合法请求响应、未知身份字段、跨类型组合、分页、提醒名单子集（需运行时成员判断交给用例）、32/22 字符邀请 token、invalid DTO、权限字段隐私形状和个人兼容。不要实现 domain/application/infra/pages；不要调整其他现有业务测试以掩盖暂时集成失败。无提交、无部署、不要创建子代理。返回改动与测试证据、依赖接口说明。

## Task 2: 家庭领域、用例与存储

依据正式契约实现家庭生命周期、邀请、虚拟人、权限矩阵、successor 归属解析、预览/最小回执、家庭写栅栏与容量。实现 CloudBase 适配器、迁移和索引，以及单项事务回滚/并发/隔离测试。邀请加密、实时失权、幂等共享唯一键必须可验证。

## Task 3: 一次性事项协作与多家庭查询

扩展现有事项写读为家庭和个人统一入口，保留已有个人存储及回执兼容；不继续让原个人按 ownerUserId 读家庭数据。权限变更、真实/虚拟执行人、提醒设置、交接、恢复实时鉴权。多家庭列表及提醒有界合并，退出/转交预览完整扫描计数后签名，历史不变。

## Task 4: 原生家庭页面及现有页面接入

按设计中的家庭管理、邀请接受、虚拟成员、退出转交及共享设置实现；首页筛选、详情能力、编辑归属/执行人/权限与回收站接入真实 API。保持设计布局，延续错误/加载/空/重试及未决原请求语义，失权清除缓存。家庭进度周期统计属下一阶段，不能制造数据。

## Task 5: 验收、部署与文档

任务级评审和整体评审，npm run check、设计原生验证、迁移可重跑及仅管理员 ACL、CLI 详情和健康验证、真实业务调用。未能验证的多账号/真机明确记录，不以 fake 代替。同步 README/SCOPE/AGENTS 与技术、数据库、部署记录。不触碰上一阶段被拒绝删除的验收事项，除非用户明确授权。


## 交付状态（2026-09-13）

Task 1–5 的实现、独立评审、本地验证、迁移及既有 API 部署已完成。最终 `npm run check` 为24个文件、271项测试通过，客户端独立复核33项测试通过。真实单账号16组家庭业务与最终权限字段回读通过，详见 [发布记录](../technical/CLOUD_DEPLOYMENT.md)。双真实账号、真机、分享、弱网及部分页面操作和样式复验明确保留为未验收范围；未提交、推送或上传小程序体验版。
