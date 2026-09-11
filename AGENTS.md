# AGENTS.md

适用于整个仓库，供编码代理和维护者共同遵循。

## 项目与当前范围

- 家庭待办提醒（`family-todo`），原生微信小程序。
- 当前已有基础架构和 identity.ensure 本地实现；原生首页仍为占位页，云端仅发布健康检查。
- 首版业务规则已整理于 [业务需求](docs/REQUIREMENTS.md)，涵盖多家庭、虚拟人、待办协作及小程序内提醒；身份接入待真实验证，其余业务功能尚未实现。
- 默认时区 `Asia/Shanghai`，瞬时时间使用 UTC RFC3339 毫秒字符串。

## 阅读顺序

1. 当前用户要求和工作区已有改动。
2. [README.md](README.md)、[当前范围](docs/SCOPE.md)、[首版业务需求](docs/REQUIREMENTS.md)。
3. [技术方案](docs/TECHNICAL_DESIGN.md)、[开发指南](docs/DEVELOPMENT.md)。
4. 本文件中的工程约定。

冲突时优先遵循用户明确要求，采用最小且可逆的处理，并同步相关文档。未确定的业务规则不得自行补成既定需求。

## 技术基线

- 原生 WXML/WXSS + TypeScript，npm workspaces，CloudBase。
- 严格 TypeScript，官方 `miniprogram-api-typings`，Vitest，esbuild。
- V1 使用单一 `api` 云函数；本地支持 `system.health` 和受发布开关保护的 `identity.ensure`。
- 运行时以 `.nvmrc`、package.json 和云配置为准；调整前核对官方文档。
- 不默认引入跨端框架、大型状态库、微服务或额外付费资源。
- 暂不添加定时函数、回调函数、业务集合或业务 tabBar。

## 目录与依赖方向

```text
miniprogram/                 小程序
  pages/ components/         页面、局部状态和通用组件
  services/ stores/           API 适配、跨页面状态（store 当前仅预留）
  config/ styles/ types/      环境、样式变量和类型
  shared/                    生成的共享契约运行时代码
cloudfunctions/api/          事件入口与应用装配
packages/contracts/         请求、响应、DTO、错误码及运行时校验
packages/domain/            纯领域规则与值对象
packages/ports/             外部能力接口
packages/application/       action 路由与用例
packages/infra-cloudbase/   端口实现
tests/                      跨层集成和架构边界测试
tools/ database/ docs/      工程工具、数据约定和持续维护文档
```

- contracts/domain 不依赖其他内部包；ports 可依赖 domain。
- application 只依赖 contracts/domain/ports。
- infra-cloudbase 实现 ports，可依赖 contracts/domain/ports。
- 微信服务端 SDK 只能出现在函数入口或 infra-cloudbase，不能进入核心层。
- 页面不得直接调用 `wx.cloud`、数据库或服务端包；通过 services 使用统一 API。
- 小程序共享包类型用 `import type`；运行时代码只能使用小程序目录内的相对路径。
- 共享契约通过 `miniprogram/shared/contracts.js` 构建产物访问，禁止直接运行工作区源码或只配置 tsconfig alias。
- 不手工修改生成文件，修改共享包后重新构建。

## API 和安全

- 请求：`{ apiVersion: 1, action, requestId, payload }`；action 采用 `domain.verb`。
- 成功：`{ ok: true, requestId, data }`。
- 失败：`{ ok: false, requestId, error: { code, message, retryable } }`。
- requestId 使用 UUID，调用方重试时保留原 ID；当前尚无持久化幂等。
- 输入以 unknown 接收，经过运行时校验；不以类型断言替代校验。
- 新增 action 同步修改 contracts、handler、测试和技术文档。
- 内部异常映射稳定错误码，不返回 SDK 原文、堆栈、密钥、OpenID 或环境细节。
- 后续业务身份必须来自可信服务端上下文，不能信任客户端的 userId 或角色声明。
- OpenID 不作为业务实体 ID，实体使用应用 UUID。
- 公开 DTO 不携带 `_openid`、`fileID` 或数据库专有类型。
- 所有客户端配置均视为公开信息，密钥只放服务端。

## 后续业务扩展

以下是扩展约束，不是当前已实现的能力：

- 依据已确认的首版需求设计业务模型、角色权限、页面导航与提醒规则；新增未明确的业务需求先澄清再实现。
- 按契约、领域规则、应用用例、适配器、页面顺序实现。
- 写接口设计持久化幂等和并发版本策略，跨实体操作检查资源所属范围。
- 不在数据库事务内调用外部服务，不依赖进程锁保证多实例正确性。
- 定时任务须可重跑；一次订阅授权不等于永久授权，启动时不自动弹订阅窗口。
- 变更数据库时同步索引和迁移说明，保持领域字段与存储结构可映射。
- 时间计算集中在 domain，通过 Clock 注入当前时间。

## 代码与 UI

- 原生页面严格对照 `design/` 已有设计稿实现，不自行调整布局、样式、文案及交互；样稿未覆盖的业务边界仍以确认需求为准。
- 使用严格类型、类型导入、具名导出，避免 any、非空断言及无说明的错误压制。
- 相近模块用相对导入；服务端跨包通过 `@family-todo/*` 引用。
- 文件与文档按功能组织，不按迭代编号命名，不做无关重构。
- 样式复用 tokens；页面状态支持 loading/empty/error/ready 和重试。
- 交互热区至少 44 × 44 CSS px，状态不能仅靠颜色表达。
- 页面局部状态不提前抽成全局 store；异步请求考虑页面卸载与上下文切换。

## 验证和交付

1. 修改前检查 git status，保留用户和其他代理的无关改动。
2. 逻辑变更补充行为测试；纯文档、简单样式不机械添加测试。
3. 基础架构、契约、构建变更执行 `npm run check`。
4. 小程序使用独立 tsconfig，防止 Node/DOM 全局污染。
5. 函数 bundle 应能独立加载；客户端产物不能依赖仓库根目录的 node_modules。
6. 同步受影响文档；通过 npm 更新锁文件，禁止手工修改锁文件。
7. 报告修改和验证结果，区分本地模拟验证与真实云环境、真机验证。
8. 用户当前会话授权优先；提交、推送、PR 合并及部署均以当前会话授权为准。
9. 未获当前授权时，不提交、推送、合并、部署、购买或销毁资源。

云函数创建使用 CloudBase CLI（首次 `tcb fn deploy` 创建），先核对目标环境和同名函数，创建后通过 CLI 查询详情并调用验证。保留实际命令与结果，不以仅生成本地目录代替平台创建。

不使用 reset --hard、强制 checkout 或批量覆盖消除用户改动，不绕过失败检查。
