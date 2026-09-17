# 本地开发

## 初始化和命令

安装 Node.js（基线见 .nvmrc）、npm 和微信开发者工具：

```bash
nvm use
npm ci
npm run check
```

check/build 自动执行 setup，首次生成 `miniprogram/config/local.ts`，默认不启用云开发。排他复制保证不会覆盖已有本地配置。首次打开开发者工具前必须构建共享契约。

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 补齐缺失的本地配置 |
| `npm run dev` | 初始化配置，监听共享契约并重建 |
| `npm test` / `npm run test:watch` | 运行/监听测试，首次先 build |
| `npm run typecheck` | 分别检查服务端、小程序类型 |
| `npm run build` | 初始化、共享包构建、类型检查、函数打包 |
| `npm run check` | 完整构建及测试 |

### 测试维护

2026-09-16 精简审查：44 个测试文件，541 项减至 532 项（按 Vitest 展开的参数化用例统计）。删除或合并 9 项，业务代码未变：

- 分页测试集中到 `miniprogram/services/personal-lists.test.ts`：删除家庭服务中的重复权限过滤、周期服务中的重复游标过期重启与上下文失效测试；迁入空中间页续读场景，去掉重复的缺失游标断言。
- 云初始化的未配置/成功路径及客户端拒绝身份私密字段响应，由 `tests/build.test.ts` 中实际打包后的 App 启动、会话调用测试覆盖，删除重复的源码级用例；仍保留 SDK 缺失/初始化异常测试。
- 首页未知写结果的蒙层清理和重试入口断言，合入同文件已有的未知结果不触发读取测试。
- 删除真实成员与无账号成员组件仅验证布尔值取反的 2 项展开/收起测试；这类简单视觉交互通过开发者工具检查。保留日程锁定、事件转发与操作白名单测试。

继续保留契约校验、权限隔离、幂等并发、事务回滚、周期时间边界、异常恢复、架构及独立构建测试。是否精简以重复覆盖和回归价值判断，不设测试数量目标。本次 `npm run check` 通过构建、类型检查及全部 532 项测试；本地模拟测试不替代真实云端和真机验证。

## 微信开发者工具

1. 导入仓库根目录，配置已指向 miniprogram/ 和 cloudfunctions/。
2. 未接入真实小程序时使用测试/游客模式预览页面和未配置提示，具体可用模式以工具和账号为准。
3. 工具原生编译 TS/WXML/WXSS；终端运行 `npm run dev` 同步共享契约变化。
4. 如发生样式缓存异常，清除编译缓存后重新编译。

事项编辑的时刻列表在 `components/editor-schedule/index.wxss` 中维护局部样式：标题位于列表上方，行间距 8px，删除按钮使用浅色圆角背景并保留 44px 点击区域。样式调整后需在开发者工具检查一次性、每日和每周安排，尤其是 6 个时刻及窄屏显示。

编辑器使用项目安装的 TypeScript（`.vscode/settings.json` 指向 `node_modules/typescript/lib`）。打开 TS 文件后，点击状态栏的 TypeScript 版本并选择「使用工作区版本」。开发者工具 RC 2.02.2608031 内置的 4.1.2 无法识别本项目的现代配置，会连带报告模块找不到和隐式 any；2026-09-14 切换至工作区 5.9.3 后这些诊断消失。无需降级 tsconfig 或关闭校验。

「代码质量」检查要求单张图片和音频不超过 200 KB。设计原图保留在 `design/`，小程序仅放适合显示尺寸的资源；首页进度条将百分号放在 WXML 插值内，避免编辑器把插值后的 `%` 误判为 CSS 语法错误。

若模拟器提示「app.json: 在项目根目录未找到 app.json」，先确认 `project.config.json` 的 `miniprogramRoot` 为 `miniprogram/`，且 `miniprogram/app.json` 存在。配置正确但重新编译仍报错时，使用菜单「项目 → 重新打开此项目」让工具重新读取目录配置；无需把 app.json 复制到仓库根目录。2026-09-11 在开发者工具 RC 2.02.2608031 中通过重开项目恢复了首页启动。

首页通过会话读取身份和业务数据，没有启动订阅弹窗；底部提供「首页 / 家庭」原生导航。page-state 支持 loading/empty/error/ready；错误态按钮发出 retry 事件，ready 展示 slot。

App 中已装配 `globalData.session`，仅创建协调器，不在启动时调用身份接口。首页通过会话加载真实身份与事项；家庭配置和实际部署状态见 [家庭协作实现](technical/FAMILY.md) 与发布记录。

上传规则排除测试、类型声明、文档和配置示例。local.ts 会编译进客户端，只能包含公开配置。

## WeUI 组件适配

家庭列表、家庭管理入口和详情安排信息行使用官方 `mp-cells` / `mp-cell`；首页（快速新增、批量可见人、提醒）、家庭页和详情页（设置、补记）的半屏容器使用 `mp-half-screen-dialog`。通过 `app.json` 的 `useExtendedLib.weui: true` 加载平台提供的扩展库，无需安装 npm 包或构建 npm。npm 包版本不等于平台支持的扩展库版本；本次指定 `1.5.6` 时开发者工具无法加载组件，改用平台内置版本并重新打开项目后恢复。

`styles/weui-adapters.wxss` 通过带前缀的 `ext-class` 统一信息行和三页半屏弹窗的边距、背景、边框及容器尺寸；家庭卡片特有样式仍放在 `pages/families/index.wxss`，继续复用现有 tokens、图标与表单样式。修改适配层或升级基础库后，需对照现有设计复查卡片、短/长弹窗、滚动和安全区。

保留原生 input、textarea、picker、checkbox、分享/头像按钮和 tabBar，以及待办卡片、权限矩阵、周期配置和进度环等业务组件。本轮未引入 WeUI Form：现有校验和权限状态已由页面及服务层管理，仅增加表单包装没有足够复用收益。

弹窗标题和内容分别使用 `title` / `desc` 插槽。关闭按钮与遮罩由页面统一调用 `closeSheet`，禁用 WeUI 内置遮罩：避免组件内部先隐藏，再触发关闭事件而绕过保存中、未决写入及交接预览中的关闭保护。首页仍在用户选择保留/放弃草稿且本地操作成功后才关闭，列表刷新期间允许关闭未修改的快速新增。

2026-09-15 完整构建、类型检查及 514 项测试通过；开发者工具验证家庭列表点击、创建家庭和添加无账号成员弹窗的显示与关闭。未提交家庭数据，未上传或发布，iOS/Android 真机和键盘、安全区适配仍需验证。接入方式参见 [WeUI 官方快速上手](https://wechat-miniprogram.github.io/weui/docs/quickstart.html)。

## 接入自己的云环境

当前工作区的 `miniprogram/config/local.ts` 和 `cloudbaserc.json` 已配置环境 `family-todo-d3g28fx1c314f8638`，小程序调用目标为 `api` 云函数；云配置还包含独立维护函数 `cleanup-query-sessions`，部署与权限要求见 [定时清理](technical/QUERY_SESSION_CLEANUP.md)。这两个本地文件不提交到 Git，新检出仓库仍需按下方步骤配置。2026-09-11 已通过 CLI 创建 api 并验证真实云端健康调用；AppID 与环境关联及开发者工具真实云调用已验证，小程序真机调用尚未验证。

新环境接入或后续联调步骤（部署须获当前会话授权）：

1. 在开发者工具配置本项目真实 AppID。如果工具将其写入 project.config.json，保持该改动仅在本地，提交前检查 diff；不假设私有配置可覆盖 AppID。
2. 在已忽略的 `miniprogram/config/local.ts` 填写本小程序关联的 cloudbaseEnvId。
3. 复制 cloudbaserc.example.json 为 cloudbaserc.json，填入相同环境 ID。
4. 执行 `npm run build`。cloudfunctions/api/index.js 已包含全部运行代码和懒加载身份 SDK，不需云端安装依赖。新环境默认关闭身份写入，当前环境已完成接入并开启；配置及验证见 [身份接入](technical/IDENTITY.md)。
5. 在开发者工具选择上传本地文件，或通过 CloudBase CLI 使用本地配置部署 api。示例的 installDependency: false 与自包含构建一致。
6. 在云函数控制台执行下方健康请求，再从小程序调用 `checkSystemHealth(requestId)` 验证链路。

云配置固定 Nodejs20.19。2026-09-11 核对的[CloudBase 官方配置文档](https://docs.cloudbase.net/cli-v1/functions/configs)仍列其为推荐运行时；本次远端详情和健康调用已验证该运行时，后续发布前仍应核对配置。

SDK 初始化成功不保证函数存在或网络可用。邀请密钥环与游标签名密钥只配置在服务端，禁止写入客户端。

本次按用户要求使用 CLI 创建 `api`，固定 CLI 版本、可复现命令及实际部署状态见 [云函数 CLI 发布记录](technical/CLOUD_DEPLOYMENT.md)。业务 action 的设计与健康函数部署分开验收；不要因健康成功将业务接口标成已实现。

## 生成文件

提交源码、package-lock.json、配置模板和 project.config.json 的公共默认值。

不提交 node_modules、云函数 index.js/map、共享 contracts.js、local.ts、cloudbaserc.json 和开发者工具私有配置。不需要额外执行小程序“构建 npm”，客户端共享契约由 bundle 提供，WeUI 组件由平台扩展库提供。

`miniprogram/shared/package.json` 是须提交的 CommonJS 格式声明，不是依赖安装清单；共享目录内不需要 node_modules。它防止根目录的 `type: module` 将生成的 contracts.js 误识别为 ES Module。

## 健康请求与业务接入顺序

控制台健康测试事件（无需业务身份或数据库）：

```json
{
  "apiVersion": 1,
  "action": "system.health",
  "requestId": "6cb53431-c95a-49eb-8c31-3ce8b609b38d",
  "payload": {}
}
```

健康成功只证明入口与协议可用。业务设计从 [技术方案](TECHNICAL_DESIGN.md) 进入，按 [开发交付](business/DELIVERY.md) 完成平台接入验证后逐模块接入。当前已安装 SDK，身份与个人业务已通过云端验证，家庭集合与索引已建立；真实业务集成必须从小程序获取可信身份，不能通过控制台填写身份字段替代验证。

家庭服务还要求服务端环境变量 `FAMILY_TODO_INVITATION_KEYRING`，配置与密钥轮换说明见 [家庭协作实现](technical/FAMILY.md)。先执行家庭迁移并验证索引和 ADMINONLY，再部署包含家庭 action 的 api。不要将密钥放入 cloudbaserc.example.json。

### WeUI 后续迁移验证（2026-09-15）

完整构建、类型检查及 529 项测试通过，新增 8 项首页/详情关闭保护与异步草稿确认测试。开发者工具重开项目后检查快速新增弹窗显示、遮罩关闭及详情五项安排信息行，未提交业务数据。家庭管理入口跳转、批量有数据状态、弹窗长内容滚动、键盘弹起和 iOS/Android 真机仍需验证；未上传或发布。

详情页复查修正了备注文本未按块级卡片显示、设置按钮间距被原生按钮重置覆盖、补记弹窗次按钮被通用卡片上边距推低的问题，并给关闭按钮补充无障碍名称。开发者工具已复核备注卡片、设置按钮间距、补记按钮对齐、弹窗关闭按钮及遮罩关闭、正文滚动至历史与周期区域；未操作保存、跳过、提醒切换或删除。此次定向回归通过 3 个测试文件共 58 项测试（页面模拟验证），真机键盘和安全区尚未验证。

按截图进一步收紧记录区域间距：本次记录尾部留白从 21px 减至 4px，历史次数标题上下间距改为 12px / 4px，次数行使用独立样式，去除时间线条目的额外底部留白。每行仍保留至少 44px 点击高度。已在开发者工具滚动至该区域复核，颜色与文案保持一致。

操作可识别性调整：新增共享 `styles/actions.wxss`，文字操作统一使用浅紫底、边框和按下反馈；日期切换与家庭筛选增加边界，事项卡片和历史次数添加进入箭头，昵称入口添加编辑图标。保留原事件、业务权限及至少 44px 点击高度，禁用按钮使用弱化样式。完整构建、类型检查及 529 项测试通过，开发者工具已检查首页操作入口及详情页补记、日期选择和历史次数按钮；本次未写入业务数据。
