# 身份初始化实现与验证

`identity.ensure` 已完成本地源码实现，尚未部署。页面保持现有设计和占位状态，新增服务函数不会自动触发请求或昵称头像授权。后续页面开发须严格对照 `design/`，不自行调整。

客户端会话已装配到 App：`globalData.session.ensure()` 用于初始化，`refresh()` 重新核验，`invalidate()` 清除身份并隔离旧响应。并发初始化只发一次请求；失败/超时后手动重试沿用 requestId，成功后新一轮刷新生成新 ID。只在内存保存不可变公开 UserDTO，不缓存 OpenID、凭据或家庭业务数据。首页的自动加载与界面状态在个人待办阶段接入。

实现路径：contracts 输入/输出校验 → domain 默认 User → application handler → ports.IdentityStore → CloudBase 事务适配 → miniprogram/services/identity-api.ts。请求 payload 仅 `{}`，返回 `{user:{id,displayName,version}}`，首次称呼为“我”。身份来自每次云调用，不接受客户端 userId、role、OpenID。

函数每次构建路由并绑定本次 context；只复用时钟和 UUID 生成器。当前仅支持平台第二参数 `context.environment` 的 JSON 格式，要求其中 TCB_SOURCE 为 wx_client/wx_devtools、WX_APPID 匹配服务端配置、WX_OPENID 非空。不读取 event 中身份，也不回退到 process.env、getWXContext 或上次调用缓存。旧 environ 字符串和未知来源拒绝，真实平台如果不提供此形状，必须在验收时调整适配，不能打开环境变量回退。

这项限制依据官方 [实例复用说明](https://docs.cloudbase.net/cloud-function/instance) 和安装版本 node-sdk 的 context 解析实现。环境形状测试是本地假设验证，尚未证明真实平台来源隔离。

服务端配置：

| 配置 | 用途 |
| --- | --- |
| FAMILY_TODO_APP_ID | 实际小程序 AppID，必须与当前调用一致；未配置则 UNAUTHENTICATED |
| FAMILY_TODO_IDENTITY_ENABLED | 默认关闭；仅在平台验收后显式配置 true |
| SCF_NAMESPACE | 平台注入的当前环境，SDK 数据库显式绑定该值 |

配置均只从服务端取得。缺少可信身份返回 UNAUTHENTICATED；合法身份但开关未开返回稳定 INTERNAL_ERROR；畸形参数在身份解析前返回 VALIDATION_ERROR。health 不依赖以上配置、SDK 初始化或存储，未实现的其他 action 继续 NOT_FOUND。

已锁定 wx-server-sdk@4.0.2（内含 @cloudbase/node-sdk@3.17.2），以 esbuild 打进单文件。SDK 事务声明缺失类型，适配器只定义实际使用的 collection/doc/get/set/runTransaction，所有返回数据从 unknown 校验；运行时代码确认 runTransaction 返回回调值、get 在 throwOnNotFound=false 时返回 data:null。SDK 的 init 对 DYNAMIC_CURRENT_ENV 类型声明不兼容，因此使用平台 SCF_NAMESPACE 字符串。真实数据库行为仍需验证。

本地验证覆盖：空参数/字段限制/隐私输出校验、首次创建、重进与新 requestId 去重、两个模拟实例并发首次创建、三个写入点失败原子回滚、丢失映射目标明确失败、保持已有称呼版本、不同用户隔离、进程残留身份拒绝、健康和 SDK bundle 独立加载。测试假数据库仅位于 tests/support，不装配到云入口。

2026-09-11：在 Node 20.19.0 下执行 `npm run check`，严格类型检查、客户端/函数构建及 10 个测试文件中的 100 项测试全部通过；`git diff --check` 通过。页面、组件、样式和 design 文件无改动。此前 Node 25.8.2 的初次检查也通过，最终结果以上述项目基线运行时为准。

同日身份阶段补充验证：Node 20.19.0 下 `npm run check` 通过 12 个测试文件、117 项测试。新增客户端并发去重、同 ID 重试、拒绝身份错误、刷新失效、旧请求成功/失败乱序、UUID 阶段失效、超时与迟到响应、随机能力缺失和 UUID 位规则验证。App 的独立 bundle 在空配置且没有 wx 时可启动；模拟配置云环境时，通过 App 会话、微信传输和实际生成契约完成身份调用，并拒绝包含隐私字段的响应。修复独立构建暴露的共享 CommonJS 格式识别问题。以上均为本地模拟，未代替真机和平台来源隔离测试。

只读远端核对命令：`tcb fn list -e family-todo-d3g28fx1c314f8638 --json`（CLI 3.8.1）。返回唯一函数 api / lam-d4wj80fb / Nodejs20.19 / Deployment completed，修改时间仍为 2026-09-11 17:20:36，未部署身份版本。重新执行 `npm audit --json` 仍为 6 项告警（1 moderate、5 high）；未修改或降级 SDK。

## 真实环境验收准备

待授权的具体变更：在已有环境 `family-todo-d3g28fx1c314f8638` 更新现有 `api` 代码，配置服务端 AppID `wxee0f068c2e7cc49c`；创建或复用 `identities`、`users`、`user_scopes` 三个集合，按 [身份存储](../../database/identity.md) 校验客户端禁止读写。保持原运行时、资源规格与无触发器配置。身份默认关闭，先确认本次调用上下文形状与来源隔离，再在受控验收中开启；SDK 依赖风险处理仍是正式发布前的未完成项。

完成环境接入后，在真实小程序上下文的开发者工具控制台运行下列调用；本地/控制台伪造身份字段不能替代此步骤：

```js
const session = getApp().globalData.session;
const first = await Promise.all([session.ensure(), session.ensure()]);
// 两次结果应相同；开发者工具请求记录中仅一次 identity.ensure。
const again = await session.refresh();
// again.id 应等于 first[0].id，版本与称呼保持不变。
session.invalidate();
```

随后重新打开小程序确认同一 UUID，并由第二个真实微信账号执行同样流程，确认返回不同 UUID。非小程序调用 identity.ensure 应得到 UNAUTHENTICATED；两账号连续与并发调用不得串用身份。数据库验证应只记录计数、映射一致性和权限结果，不输出 OpenID。真实数据库事务回滚及客户端直接读写拒绝必须单独记录，不能仅以接口成功替代。

发布前仍需：

- 从真实小程序取得平台调用形状；两账号连续/并发调用及非小程序调用不能继承身份。
- 按 [身份存储说明](../../database/identity.md) 完成集合、权限和迁移；验证真实事务冲突、回滚与持久化。
- 处理 npm audit 的 6 项 SDK 依赖告警（1 moderate、5 high；涉及 axios、lodash.set、lodash.unset 及上层依赖）。本次没有强制降级 SDK 或未经兼容验证覆盖间接版本；告警未消除，不能宣称依赖安全验收通过。
- 真实云 SDK 初始化、数据库读写、AppID 与环境关联、真机重新进入验证。

当前会话未提交、推送、部署或创建云资源。远端 api 仍是此前健康版本。其他业务写入的持久化 requestId 幂等、版本冲突、待办及家庭业务尚未实现。
