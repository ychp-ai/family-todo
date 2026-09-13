# 首版技术方案

状态：身份、个人与家庭一次性待办已实现，服务端已部署；家庭协作实现与验收见 [家庭协作实现](technical/FAMILY.md) 和 [发布记录](technical/CLOUD_DEPLOYMENT.md)。下文保留首版完整设计；周期、批量及订阅提醒仍未实现。

## 方案入口

| 内容 | 文档 |
| --- | --- |
| 实体、字段、存储索引、容量 | [数据模型](business/DATA_MODEL.md) |
| action、输入输出、错误码 | [API 契约](business/API.md) |
| 写入、权限交接、幂等、分页 | [一致性与数据访问](technical/CONSISTENCY.md) |
| 单次身份、片段、换人、暂停恢复 | [日程与记录算法](technical/SCHEDULING.md) |
| 页面状态、请求重试、缓存、提醒刷新 | [小程序实现方案](technical/CLIENT.md) |
| 产品交互与路由 | [页面流程](business/INTERACTIONS.md) |
| 开发拆分、验证门槛 | [开发交付](business/DELIVERY.md) |

## 实施起点与改造方向（历史设计）

| 现有位置 | 现状 | 业务实现时的改造 |
| --- | --- | --- |
| `cloudfunctions/api/src/index.ts` | 模块级装配健康路由，导出 main | 保留健康分支；业务分支逐请求解析可信身份，再调用同一路由 |
| `packages/contracts/src/api.ts` | envelope、三个错误码、health 校验 | envelope 与各 action schema 分文件；请求/响应使用同一 ActionMap 推导 |
| `packages/application/src/router.ts` | context 只有 requestId | 增加服务端 Actor、Clock 时间与请求预算；不能从 payload 注入 |
| `packages/ports/src/platform.ts` | Clock、UuidGenerator | 加仓储、事务、身份映射、口令与游标端口 |
| `packages/domain/src/time.ts` | 仅 UTC 序列化 | 增加本地日期、日程投影、生命周期、纯权限规则 |
| `packages/infra-cloudbase/src/platform.ts` | 系统时钟、UUID | 增加服务端数据库适配与密码学实现 |
| `miniprogram/services` | 云 transport 和 health | 添加按功能 API、请求管理、初始化、提醒刷新；页面仍不直接用云 SDK |
| `tests/architecture.test.ts` / `build.test.ts` | 依赖方向和独立 bundle 校验 | 扩展业务模块边界；保留无 SDK 环境健康调用、客户端无 Node 依赖验证 |

现有 `system.health` 的输入 `{}`、输出 `apiVersion/service/status/now` 保持兼容，无需业务身份或数据库。它只说明入口和协议可用，不表示业务存储已就绪。

上述为接入业务前的起点。当前已实现身份、个人和家庭协作分层，实际文件与验证见 [家庭协作实现](technical/FAMILY.md)。

## 总体结构与依赖

```mermaid
flowchart TD
  P[小程序页面与组件] --> S[services API 与请求状态]
  S --> C[统一 api 云函数入口]
  C --> I[每次调用的可信身份解析]
  I --> A[application 用例与 DTO 装配]
  A --> D[domain 权限及日程规则]
  A --> R[ports 仓储与事务]
  R --> B[infra-cloudbase 适配器]
  B --> DB[(CloudBase 文档数据库)]
  K[contracts 输入输出校验] -.-> S
  K -.-> A
```

图中的运行时调用经 ports 指向实现；源码依赖仍是 application → ports、infra → ports。domain/contracts 不相互依赖，ports 只引用 domain，不能引用公开 API DTO。application 负责将已校验 DTO 转换成 domain 值对象，再把领域结果转换为公开 DTO。

| 包 | 拟新增功能目录 / 文件 | 职责 |
| --- | --- | --- |
| contracts | `identity/ family/ task/ occurrence/ reminder/ progress/`，`action-map.ts` | 输入、输出、错误码、运行时校验；无 Node、平台 SDK、环境配置 |
| domain | `family/ task/ schedule/ policy/ reminder/` | 实体、不变量、状态转换、日期计算；函数显式接收 now |
| ports | `identity.ts`、`repositories.ts`、`unit-of-work.ts`、`query.ts`、`secrets.ts` | 按用例需要定义接口；不暴露 collection、where、SDK transaction |
| application | 同名功能目录、`command-runner.ts`、`query-runner.ts` | 鉴权、幂等、事务编排、DTO、稳定错误映射 |
| infra-cloudbase | `repositories/ mappers/ transaction/ identity/ crypto/` | 存储映射、事务、身份、UUIDv5、签名、认证加密 |
| api function | `index.ts`、`composition.ts`、`invocation-context.ts` | SDK 初始化、依赖装配、逐请求上下文；不放业务规则 |
| miniprogram | `services/`、`pages/`、`components/` | 原生页面与 API 适配，采用已有 tokens；全局仅保留必要会话状态 |

按功能逐个增加目录，不提前生成无内容的脚手架。领域返回判别联合的成功/拒绝结果，由 application 转换成 ApplicationError；基础设施异常在适配边界分类，错误不带 SDK 原文或身份信息。

## 契约与端口形状

继续手写窄范围运行时校验，不新增大型 schema 依赖。每个 action 有 input/output guard；仅编译期 ActionMap 不等于已经做运行时校验。envelope 拒绝未知顶层字段，action payload 拒绝未声明字段；字符串先按需求规范化，再计算幂等摘要。

建议的端口形状如下，是设计示例，不是已创建源码：

```ts
interface UnitOfWork {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
interface TransactionContext {
  families: FamilyRepository;
  tasks: TaskRepository;
  occurrences: OccurrenceRepository;
  preferences: ReminderPreferenceRepository;
  commands: CommandReceiptRepository;
  // 其余受本次事务约束的仓储同样从 tx 取得
}
interface TaskRepository {
  get(id: TaskId): Promise<Task | null>;
  insert(task: Task): Promise<void>;
  replace(task: Task, expectedVersion: number): Promise<void>;
}
```

事务回调只可用 tx 绑定的仓储；候选检索由单独 QueryReader 在事务外完成，再通过 scope revision 证明读到的候选在提交时仍有效。`replace` 不实现成“先查后写”的非事务版本检查。时钟、ID、SDK client 可复用；Actor、权限结果、事务及请求预算逐请求创建，不放模块全局。

## 身份与入口

1. 校验 envelope，提取合法 requestId；未知 action 仍返回 NOT_FOUND。
2. health 不初始化业务存储；其他 action 仅接受可信的小程序调用上下文，缺失或不符合调用来源要求则 UNAUTHENTICATED。
3. 每次调用读取受信任的 APPID/OPENID，验证 APPID 对应配置；客户端声称的 actorId/userId/role 一律无效。
4. identity.ensure 在事务中以 `(provider, appId, subject)` 的散列键取得或首次建立 Identity → User；首次名称为“我”，之后用户可以修改，不索取昵称头像才能使用。
5. 其他业务 action 必须已有应用身份。application 只拿应用 userId；OpenID 留在身份适配器内部。
6. 单元测试直接注入 Actor；真实业务验证必须从小程序发起，不能在控制台 event 中填写 OpenID 假装验证成功。

首版只开放小程序调用业务入口，不配置 HTTP、Web、定时触发或转发代理。官方文档提醒混合调用可能受实例环境残留影响，因此“getWXContext 非空”不能单独作为来源校验。平台接入验证须证明非小程序调用不会继承前一请求的身份；不能证明时阻止业务发布并修正入口适配，不能退回信任 event。依据：[小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)、[实例复用](https://docs.cloudbase.net/cloud-function/instance)。

## 技术决策

| 选择 | 原因及代价 |
| --- | --- |
| 一个 api，按 action 分发 | 延续现有基线，统一鉴权/错误/幂等；需要限制聚合和事务预算 |
| 文档存储与领域分离 | 现有 CloudBase 方向不变；实体不携带 SDK 类型 |
| 日程按需投影、记录稀疏持久化 | 无需定时任务，长期未打开也能回看；查询必须分窗口，不一次展开无限周期 |
| 当前事项 + 历史计划片段 | 改时间/换人不改历史；查询必须按片段而非当前事项计算 |
| 成员关系继承链交接 | 大量事项无需逐条原子转移；需要反向检索和版本栅栏，不能只按当前 owner 查 |
| 本人关闭提醒单独保存 | 避免管理者和重新共享绕过本人选择；权限和提醒意愿分别判断 |
| 写事务保存业务结果和幂等回执 | 丢响应后可确定重试结果；回执占存储，首版不自动清理 |
| 家庭单 scope 串行写 | 保证权限竞争正确；高频家庭可能冲突，记录证据后再细分锁粒度 |
| 分页会话保存扫描位置 | 无界历史不能塞进 2048 字符游标；增加内部短期数据及过期清理工作 |
| 页面局部状态、无离线写队列 | 简化上下文与并发；断网保留未决请求，恢复后确认结果 |

## 运行时、构建与依赖

当前 `.nvmrc=20.19.0`、云配置 `Nodejs20.19`、函数 10 秒/256 MB；本次保留。官方配置仍列该运行时为推荐：[云函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)。本地开发与发布检查使用 `.nvmrc`，根 engines 的较宽范围不表示已在全部版本验证。

平台实现使用 `wx-server-sdk` 作为微信云调用与数据库入口，不同时引入另一套独立 CloudBase 登录。已通过 npm 锁定 4.0.2，检查内置类型和事务实现；SDK 类型缺口在窄适配接口收敛，数据读取仍以 unknown 校验。已验证真实单账号事务、幂等和业务流程；间接依赖告警与多账号验证边界见发布记录。

保留 esbuild 自包含函数 bundle、`installDependency:false`。SDK 仅从云端装配路径引入；懒初始化业务依赖使 health 可在无云凭据/数据库下执行。已新增身份 SDK 独立加载测试；当前函数 bundle 约 2.6 MB，共享契约约 27.5 KB。npm 已同步锁文件，真实云内 SDK 初始化和单账号业务写入已通过，详见发布记录。

小程序运行时代码仍从 `miniprogram/shared/contracts.js` 引用，不从 workspace 源码运行。随着 schema 增长，记录共享 bundle 体积；若确需拆分，构建产物仍全部位于小程序目录，类型检查与构建测试同步修改。

## 验证与发布边界

先完成平台接入验证：逐请求身份隔离、选定 SDK 的文档事务和冲突、打包独立加载、数据库仅服务端读写。官方事务文档给出单事务最多100操作、30秒、仅 doc 操作；项目使用更小的操作/时间预算，见 [一致性设计](technical/CONSISTENCY.md)。依据：[事务文档](https://docs.cloudbase.net/database/transaction)。

每个业务模块按契约 → 领域 → 用例 → 适配器 → 页面交付。正式契约/构建/业务代码变更运行 `npm run check`，另补真实 CloudBase 与多账号真机验收。单元 fake 不能替代事务/来源校验；已落地的36个 action 与真实验证边界见 API 和发布记录，尚未执行的技术目标不标记为已通过。

迁移在独立工具中执行；集合、索引与规则先验证，再上线相关 action。单个开发步骤不代表可以将缺少退出或撤权的家庭模型对外上线。生产提交、推送、部署与资源操作按当前会话另行授权。
