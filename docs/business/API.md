# 业务接口契约

状态：API 设计与实现进度。`system.health` 已发布；`identity.ensure` 已完成本地契约、handler、存储适配及行为测试，受发布开关保护，未部署。其余 action 仍待实现。正式实现每个 action 时同时添加运行时校验、handler 和行为测试，沿用统一 `api` 云函数。

## 协议与校验

### 云函数映射

首版只创建一个事件型云函数 `api`，入口 `index.main`。客户端通过 services 发出 `wx.cloud.callFunction({name:'api',data:request})`；下列 action 是函数内路由，不是各自独立的云函数名，也不配置 HTTP 路由或定时触发器。

| 云函数 | action 模块 | 本轮交付 |
| --- | --- | --- |
| api | system.health | 可运行健康入口，CLI 创建及真实调用结果见 [发布记录](../technical/CLOUD_DEPLOYMENT.md) |
| api | identity.ensure | 本地实现，身份/事务真实验证和集合接入待完成；见 [身份接入](../technical/IDENTITY.md) |
| api | identity.update、family、member、virtualMember、invitation | 接口设计；业务 handler 及集合待实现 |
| api | task、occurrence | 接口设计；持久化、周期、幂等及权限待实现 |
| api | reminder、progress | 接口设计；小程序内查询及用户状态待实现 |

未实现 action 当前返回 `NOT_FOUND`，不返回模拟业务成功。完整请求示例见 [接口调用示例](API_EXAMPLES.md)。

### 请求与响应

请求 `{apiVersion:1, action, requestId:UUID, payload}`。成功 `{ok:true,requestId,data}`，失败 `{ok:false,requestId,error:{code,message,retryable}}`。不增加第二套 REST 协议。

所有 payload 从 unknown 校验，拒绝未声明字段；不接受 actorId、openid、role 等身份声明。ID 使用 UUID；时间、字符串和数量限制见 [数据模型](DATA_MODEL.md)。optional 表示可省略；null 只用于明确支持清空的字段。输出也必须有校验器。领域实体与公开 DTO 分开，数据库字段不能透传。

下文 `WriteRef={id:UUID,expectedVersion:integer>=1}`；单次首次操作支持 version=0。所有分页 cursor 为服务端签名 opaque 字符串，最长 2048 字符，仅携带查询会话/检查点标识和有效期；服务端会话绑定 actor、筛选、各 scope 版本和 15 分钟有效期；参数变更/过期返回 CURSOR_EXPIRED，客户端回到第一页。不用客户端传来的上次权限名单恢复查询。

`Page<T>={items:T[],nextCursor:string|null,complete:boolean,asOf:Instant}`。complete=false 表示尚未扫描完所有数据，不仅是当前页没满。聚合扩展 `{scopes:ScopeResult[],summary:Summary|null}`；某家庭失败只返回其已获授权的 familyId 与稳定错误码，不返回敏感原文。完整统计需所有 scope 扫描完成且版本一致；否则 summary=null。

`ScopeResult={familyId:UUID|null,status:"ok"|"partial"|"failed",errorCode?:string}`；`Summary={completed:number,pending:number,skipped:number,denominator:number}`，统计范围为当前筛选的全部有权记录。默认 task.list 使用服务端上海今天，status 省略表示全部状态；dateFrom/dateTo 必须成对提供，unscheduled=true 时禁止日期范围。

所有分页的 limit 为整数 1–50，省略取 20；cursor 首次省略，后续传原样 nextCursor，不能传空字符串或 null。dateFrom/dateTo 是包含两端的 LocalDate，跨度最多31天。complete=true 时 nextCursor=null，complete=false 时必须返回非空 nextCursor；空 items 不等于扫描完成。分页继续使用相同筛选和 limit，但每次查询可用新 requestId；批量写续跑必须保留原 requestId。

task.list 增加 `overdue?:boolean`：true 时查询上海今天之前仍 pending 的有日期记录，忽略时刻是否已到；禁止同时传日期范围、unscheduled=true 或非 pending 的 status，省略 status 时按 pending 处理。今天已到时的事项通过 reminder.list 获取。未安排和过去未完成均保留原计划，不自动移动到今天；跨家庭的积压查询仍返回聚合扩展及 continuation。

### 版本与幂等

| 字段 / action | 版本来源 |
| --- | --- |
| identity.update.expectedVersion | UserDTO.version |
| family.update / transferOwnership / exit | FamilyDTO.version；后两者还须完成预览 |
| invitation.create / virtualMember.create.expectedFamilyVersion | FamilyDTO.version |
| member.rename / virtualMember.update / deactivate | 对应 MemberDTO / VirtualDTO.version |
| invitation.revoke.expectedVersion | InvitationSummary.version |
| task 写入、批量单项 expectedVersion | TaskDTO.version |
| occurrence.record / undo.expectedVersion | OccurrenceDTO.version；未落库投影为0 |
| reminder.setMine.expectedVersion | 当前用户 ReminderPreferenceDTO.version；无存储偏好为0 |

实体已有版本为正整数，0 只用于明确允许的单次和偏好。新建、邀请接受、markRead、dismiss 无 expectedVersion，分别依靠唯一成员关系、持久化回执或单调状态处理。所有业务写均以可信 actor + requestId 幂等，action 或规范化 payload 改变则 IDEMPOTENCY_CONFLICT；读取和预览不具有业务写幂等语义。首次 identity.ensure 按可信身份唯一键建用户。成功重放仍须执行当前权限检查，退出/转交只重放最小确认的例外沿用下文规则。

当前已实现的 system.health 请求 payload 必须是 `{}`，返回 `{status:'ok',service:'api',apiVersion:1,now:Instant}`；不访问身份和数据库。非法 envelope 返回 VALIDATION_ERROR；合法 UUID 原样回传，非法或缺失 UUID 的错误响应 requestId 为固定字符串 `unknown`。所有顶层未知字段（包括 userId、role）均拒绝。

排序：指定日期范围的日程按 localDate、time（无时刻置后）、taskId、occurrenceId 升序；提醒及过去积压从今天向前按31天窗口读取，最近窗口优先、窗口内使用上述升序；未安排按 createdAt 降序、id 升序；历史事件按 recordedAt 降序、id 升序。查询开始固定 asOf，跨页修改导致版本失效则重查，不伪称强一致无限快照。

## 公共类型

下面是契约蓝图（TypeScript 表达），正式开发迁入 contracts 并配套校验器。UUID、LocalDate、LocalTime、Instant 均是通过运行时校验的 string，不能仅凭类型别名跳过验证。

```ts
type Subject =
  | { kind: 'self' }
  | { kind: 'member'; membershipId: UUID }
  | { kind: 'virtual'; virtualMemberId: UUID };

type ResolvedSubject =
  | { kind: 'user'; userId: UUID }
  | { kind: 'member'; membershipId: UUID }
  | { kind: 'virtual'; virtualMemberId: UUID };

type Schedule =
  | { kind: 'once'; date: LocalDate | null; time: LocalTime | null }
  | { kind: 'daily'; startDate: LocalDate; endDate: LocalDate | null;
      times: LocalTime[] }
  | { kind: 'weekly'; startDate: LocalDate; endDate: LocalDate | null;
      weekdays: number[]; times: LocalTime[] };

type AccessInput = {
  viewerMembershipIds: UUID[];
  helperMembershipIds: UUID[];
  reminderMembershipIds: UUID[];
  remindMe: boolean; // 新建默认 true；编辑必须回传自己的实际设置
};
type TaskDraft = {
  title: string; note: string; familyId: UUID | null;
  subject: Subject; schedule: Schedule; access: AccessInput;
};
type Capabilities = {
  canEdit: boolean; canRecord: boolean; canShare: boolean;
  canDelete: boolean; canRestore: boolean; canResume: boolean;
};
type TaskDTO = {
  id: UUID; version: number; title: string; note: string;
  familyId: UUID | null; familyName: string | null;
  ownerUserId: UUID; ownerName: string; createdByUserId: UUID;
  subject: ResolvedSubject; subjectName: string; schedule: Schedule;
  lifecycle: 'active' | 'paused' | 'stopped' | 'deleted';
  participants: ParticipantDTO[]; myReminder: ReminderPreferenceDTO;
  capabilities: Capabilities; createdAt: Instant; updatedAt: Instant;
};
type ParticipantDTO = {
  membershipId: UUID; name: string; canView: boolean;
  canHelp: boolean; receivesReminder?: boolean; reminderSelfDisabled?: boolean;
  requiredViewer: boolean;
};
type ReminderPreferenceDTO = { enabled: boolean; selfDisabled: boolean; version: number };
type OccurrenceRef = {
  id: UUID; taskId: UUID; segmentId: UUID;
  localDate: LocalDate | null; slot: LocalTime | 'date-only' | 'unscheduled';
};
type OccurrenceDTO = OccurrenceRef & {
  subject: ResolvedSubject; subjectName: string; // 该次片段的执行对象，不能取当前 Task.subject
  version: number; time: LocalTime | null;
  scheduledAt: Instant | null; status: 'pending' | 'completed' | 'skipped';
  actualCompletedAt: Instant | null; recordedAt: Instant | null;
  operatorName: string | null; canRecord: boolean;
};
type TaskListItem = { task: TaskDTO; occurrence: OccurrenceDTO };
```

self 仅为输入简写：个人事项保存为提交者的 userId，家庭事项保存为提交者在该家庭的 membershipId。输出及进度使用 ResolvedSubject，不能随读取者改变“自己”的含义。编辑家庭事项回传实际 member/virtual ID，不把读取结果改写为当前编辑者的 self。

个人 draft 只能 subject=self，所有 membership 数组为空；新建或变更执行人时，家庭 member/virtual 必须属于该家庭且有效。既有已失效执行对象在只改标题/备注且原 ID 未变时可保留历史安排，不能重新选用、授予权限或开启其提醒。helper/reminder 是有效可见真实成员子集（含必要可见人）；虚拟人不能成为提醒接收人。remindMe 与 reminderMembershipIds 中重复出现的自己合并。已归属家庭的事项 update 不能换家庭；个人归属家庭时必须完整重新校验。

给真实成员安排无需接受步骤；保存前明确展示必要可见与本人记录权限，提醒另设。task.update 对已完成 once 禁止 schedule/subject 变更；已跳过需先撤销；有应做或操作历史的周期不能转 once。周期换人沿用未来片段切分，历史记录与进度按 OccurrenceDTO.subject 展示。以上均由服务端校验，违反返回 INVALID_STATE。

TaskDTO 的 participants 对管理者返回完整权限矩阵；普通可见者只返回可见成员的必要展示信息，receivesReminder 和 reminderSelfDisabled 仅本人或管理者可见（普通可见者省略他人的这两个字段）。客户端不能用 capabilities 代替服务端鉴权。个人不返回任何其他家庭成员信息。

AccessInput.reminderMembershipIds 表达有效提醒开启名单；若包含他人 selfDisabled=true 的成员，整次写入返回 INVALID_STATE，不能清除本人关闭标记。remindMe 的明确改变视为当前用户自己的选择：false 置 selfDisabled，true 清除；未改变时保留既有标记。管理者看到锁定项及“已自行关闭，需本人开启”，不默认重勾。reminder.setMine 是本人开启/关闭入口；本人关闭选择跨撤权、重新加入及恢复保留。

单次投影尚未落库时，UUID 本身不可反解。所有针对单次的读取/写入传 `OccurrenceRef`；服务端按 taskId 加载并鉴权，校验 segment 属于事项、日期/slot 符合片段和控制区间、重新计算 UUID 一致后才读写。不能信任客户端凭空构造的次数。无日期一次性用 localDate=null、slot=unscheduled；date-only 不等同于午夜。日程预览尚无 task/segment ID，返回 `SchedulePreviewSlot[]={localDate,time,scheduledAt}`，不使用 OccurrenceDTO；表中 previewSchedule 的 nextOccurrences 指该预览类型。

## 身份与家庭

| action | payload | data | 权限 / 行为 |
| --- | --- | --- | --- |
| identity.ensure | `{}` | `{user:{id,displayName,version}}` | 可信上下文解析/首次幂等建用户；不索取头像昵称即可开始个人记事 |
| identity.update | `{displayName,expectedVersion}` | `{user}` | 本人；不改家庭内称呼 |
| family.list | `{limit?,cursor?}` | `Page<FamilySummary>` | 当前有效家庭，summary 含 id/name/ownerName/myMembershipId/myRole/version |
| family.create | `{name,myName}` | `{family:FamilyDTO}` | 创建者成为唯一拥有人；原子创建 member/slot/guard |
| family.get | `{id}` | `{family:FamilyDTO,members:MemberDTO[],virtualMembers:VirtualDTO[]}` | 有效成员；家庭最多 20+20 有效成员，历史成员另页读取 |
| member.list | `{familyId,status?:'active'|'left'|'removed',limit?,cursor?}` | `Page<MemberDTO>` | 有效家庭成员；默认 active；历史称呼只用于展示，不恢复访问或操作权 |
| virtualMember.list | `{familyId,status?:'active'|'inactive',limit?,cursor?}` | `Page<VirtualDTO>` | 有效家庭成员；默认 active；inactive 不可用作新安排 |
| family.update | `{id,expectedVersion,name}` | `{family}` | 当前拥有人 |
| member.rename | `{id,expectedVersion,name}` | `{member}` | 本人或该家庭拥有人 |
| invitation.create | `{familyId,expectedFamilyVersion}` | `{id,token,expiresAt,version}` | 拥有人；token 仅此次响应和用户主动复制/分享时使用，不写日志 |
| invitation.list | `{familyId,limit?,cursor?}` | `Page<InvitationSummary>` | 拥有人；不返回 token/tokenHash；遗失分享口令则重新生成邀请 |
| invitation.preview | `{token}` | `{familyName,inviterName,expiresAt,alreadyJoined}` | 已有可信身份；仅邀请摘要；无效统一 INVITATION_UNAVAILABLE |
| invitation.accept | `{token,myName}` | `{familyId,membershipId,alreadyJoined}` | 持有有效邀请即可确认加入，无额外审批，允许转发及多人使用；过期/撤销再校验；重复加入返回已存在成员 |
| invitation.revoke | `{id,expectedVersion}` | `{id,version,revoked:true}` | 拥有人；已加入成员不因此退出 |
| virtualMember.create | `{familyId,expectedFamilyVersion,name}` | `{member:VirtualDTO}` | 拥有人；不创建 User |
| virtualMember.update | `{id,expectedVersion,name}` | `{member}` | 拥有人，保留事件历史称呼快照 |
| virtualMember.deactivate | `{id,expectedVersion}` | `{member}` | 拥有人；不删除历史/重置未完成，创建时不可再选 |
| family.previewExit | `{familyId,targetMembershipId,mode:'leave'|'remove',cursor?}` | `{preview:ExitPreview|null,complete,nextCursor}` | 本人退出或拥有人移除他人；目标不能是未转交的拥有人 |
| family.exit | `{familyId,targetMembershipId,mode,previewToken,expectedFamilyVersion}` | `{familyId,exitedMembershipId,completed:true}` | 重新验证预览版本与承接人；一个事务改变归属解析和访问权限 |
| family.previewTransfer | `{familyId,toMembershipId,cursor?}` | `{preview:TransferPreview|null,complete,nextCursor}` | 拥有人；承接人 active 真实且非自己 |
| family.transferOwnership | `{familyId,toMembershipId,previewToken,expectedFamilyVersion}` | `{id,version,transferred:true}` | 原子更改拥有人；不会自动让原拥有人退出 |

FamilyDTO：`id,name,version,myMembershipId,ownerMembershipId,authEpoch`。MemberDTO：`id,familyId,name,status,role,version,isMe`；普通成员不返回其他人的 User 身份映射。VirtualDTO：`id,familyId,name,status,version`。

上述 ID 均为 UUID，名称为经过字段长度校验的 string，version/authEpoch 为正整数，isMe 为 boolean。MemberDTO.status 为 active/left/removed；role 为 owner/member，退出者统一 member，不保留过去 owner 作为当前权限。VirtualDTO.status 为 active/inactive。family.get 只内嵌 active 成员；完整历史用两个 list action 分页，不静默截断。成员列表按 createdAt、id 升序，family.list 按家庭 createdAt、id 升序，invitation.list 按 createdAt 降序、id 升序。

`UserDTO={id:UUID,displayName:string,version:number}`；`FamilySummary={id:UUID,name:string,ownerName:string,myMembershipId:UUID,myRole:'owner'|'member',version:number}`；`InvitationSummary={id:UUID,familyId:UUID,version:number,createdAt:Instant,expiresAt:Instant,revokedAt:Instant|null}`。邀请 token 固定为16随机字节编码后的22字符无填充 base64url 字符串，不作为 UUID 处理；preview/accept 校验形状后统一判断有效性。预览令牌同游标使用 opaque 字符串、最长2048字符，服务端签名，客户端不解析。

ExitPreview：`previewToken,expiresAt,familyVersion,targetName,successorName,ownedTaskCount,privateTaskCount,createdManagementCount,virtualTaskCount,otherScopesUnaffected:true`。TransferPreview：`previewToken,expiresAt,familyVersion,toName,virtualTaskCount`。预览未完成扫描时 preview=null、complete=false 并返回 nextCursor；只能完成后签发令牌和展示最终计数，客户端沿用筛选继续扫描。预览令牌 5 分钟绑定操作人与完整参数、familyVersion；只展示计数和职责摘要，不把退出者原私密事项的标题提前泄露给拥有人。family 写版本变化则返回 PREVIEW_EXPIRED，请重新预览。真实变更以提交事务内的权限和版本为准。退出/转交返回最小操作确认；原 actor、requestId 与 payloadHash 一致时，即使已失去原管理权仍能重放该确认，不返回旧家庭 DTO。其他业务结果重放仍检查当前权限。

## 事项与周期

| action | payload | data | 语义 |
| --- | --- | --- | --- |
| task.create | `{draft:TaskDraft}` | `{task:TaskDTO,nextOccurrences:OccurrenceDTO[]}` | 默认仅自己提醒；下一次数预览最多 3 个 |
| task.get | `{id,occurrence?:OccurrenceRef}` | `{task,occurrence:OccurrenceDTO|null}` | 校验次记录属于该 Task；失权统一 NOT_FOUND |
| task.list | `{familyId?:UUID|null,dateFrom?,dateTo?,unscheduled?,overdue?,status?:pending|completed|skipped,limit?,cursor?}` | `Page<TaskListItem> + 聚合扩展` | familyId 省略=全部；null=个人；未安排、过去未完成与日期条件互斥 |
| task.update | `{id,expectedVersion,draft:TaskDraft}` | `{task,nextOccurrences}` | 完整提交字段；保留草稿处理冲突；周期日程/执行人更新仅影响未来；校验一次性状态及周期转一次性的限制 |
| task.previewSchedule | `{schedule,taskId?}` | `{now,nextOccurrences,excludedPastSlots,explanation}` | 纯预览不创建记录；已有任务先鉴权；保存时再次计算 |
| task.setAccess | `{id,expectedVersion,access:AccessInput}` | `{task}` | 单项原子调整名单；必要可见人不能取消；移除可见立即撤销对应代记/提醒 |
| task.pause | `WriteRef` | `{task}` | active 周期 → paused |
| task.resume | `WriteRef` | `{task,nextOccurrences}` | paused 非 stopped-history 周期 → active；不补暂停期 |
| task.stop | `WriteRef` | `{task}` | active/paused 周期 → stopped；终止未来、保留此前次数 |
| task.delete | `WriteRef` | `{id,version,deleted:true}` | 整个事项/系列软删除，前端需展示影响确认 |
| task.recycleList | `{familyId?,limit?,cursor?}` | `Page<TaskDTO>` | 仅当前有管理权的已删除事项 |
| task.restore | `WriteRef` | `{task,removedParticipantCount}` | 校验当前额度和成员；一次性原状、周期 paused；失效成员不恢复 |
| occurrence.list | `{taskId,dateFrom,dateTo,limit?,cursor?}` | `Page<OccurrenceDTO>` | 最多 31 天窗口；已删除不通过正常入口返回 |
| occurrence.record | `{occurrence:OccurrenceRef,expectedVersion,status:'completed'|'skipped',actualCompletedAt?:Instant,note?:string}` | `{occurrence,taskVersion}` | completed 可补记时间；skipped 不得带完成时间；记录人来自 Actor |
| occurrence.undo | `{occurrence:OccurrenceRef,expectedVersion}` | `{occurrence,taskVersion}` | completed/skipped → pending；追加撤销事件 |
| task.history | `{taskId,limit?,cursor?}` | `Page<TaskEventDTO>` | 当前有查看权；含操作、真实记录人称呼、记录时间与实际完成时间 |
| task.batchAddViewers | `{items:{taskId,expectedVersion,targetFamilyId?:UUID,viewerMembershipIds:UUID[]}[]}` | `{complete:boolean,results:BatchItemResult[]}` | targetFamilyId 仅用于原个人事项；逐项事务；不授予代记或提醒 |

TaskEventDTO：`id,taskId,occurrenceId|null,kind,actorName,recordedAt,actualCompletedAt|null,note`。批量结果每项为 `{taskId,status:"succeeded",version}`、`{taskId,status:"failed",error:{code,message,retryable}}` 或 `{taskId,status:"pending"}`；结果顺序与输入一致，taskId 不得重复。complete=false 时用原 requestId 和原完整 payload 继续，不能把 pending 当失败用新 ID 提交。complete=true 仅表示全部有明确结果，用户可对失败项使用新 ID 和最新版本重试。整体 envelope 成功不表示所有事项成功。外层格式错误则整批 VALIDATION_ERROR，未知/失权 item 在单项返回 NOT_FOUND；已成功项重放时失权也不能泄露旧 DTO，返回对应稳定错误。

TaskEventDTO.kind 为 `task.created/updated/accessChanged/paused/resumed/stopped/deleted/restored`、`occurrence.completed/skipped/undone`；note 为 string，未填写取空字符串。ID、时间字段沿用公共类型；不存在的 occurrenceId/actualCompletedAt 明确为 null。预览返回 `now:Instant,nextOccurrences:SchedulePreviewSlot[],excludedPastSlots:boolean,explanation:string`；excludedPastSlots 只表示本次规则存在已被排除的过去计划，不暗示已创建这些次数。新建、更新、恢复周期和纯预览的 nextOccurrences 最多3项，无后续计划则为空，不制造占位次数。

## 提醒与家人进度

| action | payload | data | 语义 |
| --- | --- | --- | --- |
| reminder.list | `{includeDismissed?:boolean,limit?,cursor?}` | `Page<ReminderDTO> + 聚合扩展` | 总是全部有效家庭和个人，不接收列表的 familyId 筛选 |
| reminder.setMine | `{taskId,enabled,expectedVersion}` | `{preference:ReminderPreferenceDTO}` | 任一当前可见真实用户仅修改本人；默认创建者 true，其余 false；本人关闭设置 selfDisabled，仅本人开启可清除；expectedVersion 为本人偏好版本，写入同时递增 task.version |
| reminder.markRead | `{occurrence:OccurrenceRef}` | `{occurrenceId,read:true}` | 当前接收人；幂等，不影响别人 |
| reminder.dismiss | `{occurrence:OccurrenceRef}` | `{occurrenceId,dismissed:true}` | 当前接收人；待办保留，历史提醒可查 |
| progress.get | `{familyId,date,subject?:ResolvedSubject,cursor?}` | `{members:MemberProgress[]|null,complete,nextCursor,asOf}` | 必须当前家庭成员；仅统计自己可见的应做，不返回他人私密总量 |

ReminderDTO：`occurrence:OccurrenceRef,title,familyId,familyName,subjectName,scheduledAt,readAt|null,dismissedAt|null`。MemberProgress：`subject:ResolvedSubject,name,completed,pending,skipped,denominator`；未完整扫描时 members=null，按 nextCursor 继续，不把局部计数显示成最终进度。denominator=completed+pending，skipped 单列，无记录文字为“暂无共享给你的安排”。部分查询失败时该 scope 不给出计数。

前端 onShow 立即刷新（2 秒内重复触发去重），可见期间每 30 秒刷新，onHide/onUnload 停止；列表筛选不传给 reminder.list。失败退避 5/15/30 秒，最多三次自动重试，保留手动重试。请求 10 秒超时；写请求超时保留 requestId，不乐观宣告失败后重复创建。时间判断用服务端 now，不能信任手机快慢。

## 错误与界面反馈

| code | retryable | 用户可采取的动作 |
| --- | --- | --- |
| VALIDATION_ERROR | false | 显示具体字段规则并保留输入；不返回内部 schema 路径 |
| UNAUTHENTICATED | false | 提示重新进入并重试初始化，不弹订阅授权 |
| NOT_FOUND | false | “事项不存在或你已无权查看”，移除本地缓存 |
| FORBIDDEN | false | 展示只读/无操作权限，刷新能力 |
| VERSION_CONFLICT | false | “家人刚刚更新了这件事”，保留草稿、加载最新再提交 |
| IDEMPOTENCY_CONFLICT | false | 客户端修复 ID 复用错误，不循环重试 |
| INVALID_STATE | false | 刷新状态；未来周期不能提前完成，已停止不能直接继续 |
| LIMIT_EXCEEDED | false | 展示容量/数量限制与可执行的整理入口 |
| INVITATION_UNAVAILABLE | false | 让邀请人重新发出邀请；不区分不存在/被撤销的口令 |
| PREVIEW_EXPIRED | false | 重新检查交接范围再确认 |
| CURSOR_EXPIRED | false | 保留筛选，重查第一页 |
| TEMPORARILY_UNAVAILABLE | true | 手动/退避重试，保留表单及 requestId |
| INTERNAL_ERROR | true | 稳定文案，不返回 SDK 内容；服务端记录脱敏 requestId |

这些新增错误码仍需正式加入 contracts；不得只修改页面字符串。

## 可复用请求示例

```json
{
  "apiVersion": 1,
  "action": "task.create",
  "requestId": "6cb53431-c95a-49eb-8c31-3ce8b609b38d",
  "payload": {
    "draft": {
      "title": "买牛奶和鸡蛋", "note": "", "familyId": null,
      "subject": {"kind": "self"},
      "schedule": {"kind": "once", "date": "2026-09-12", "time": null},
      "access": {"viewerMembershipIds": [], "helperMembershipIds": [], "reminderMembershipIds": [], "remindMe": true}
    }
  }
}
```

响应 task.myReminder.enabled=true，而 occurrence.scheduledAt=null；不会产生午夜到时提示。使用原 requestId 和相同 payload 重试应返回同一 task.id；改标题重用该 requestId 应返回 IDEMPOTENCY_CONFLICT。
