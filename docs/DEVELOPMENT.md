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

## 微信开发者工具

1. 导入仓库根目录，配置已指向 miniprogram/ 和 cloudfunctions/。
2. 未接入真实小程序时使用测试/游客模式预览占位首页，具体可用模式以工具和账号为准。
3. 工具原生编译 TS/WXML/WXSS；终端运行 `npm run dev` 同步共享契约变化。
4. 如发生样式缓存异常，清除编译缓存后重新编译。

首页没有登录、业务请求、订阅弹窗或底部导航。page-state 支持 loading/empty/error/ready；错误态按钮发出 retry 事件，ready 展示 slot。

上传规则排除测试、类型声明、文档和配置示例。local.ts 会编译进客户端，只能包含公开配置。

## 接入自己的云环境

本步骤供后续联调，本次初始化不自动部署：

1. 在开发者工具配置本项目真实 AppID。如果工具将其写入 project.config.json，保持该改动仅在本地，提交前检查 diff；不假设私有配置可覆盖 AppID。
2. 在已忽略的 `miniprogram/config/local.ts` 填写本小程序关联的 cloudbaseEnvId。
3. 复制 cloudbaserc.example.json 为 cloudbaserc.json，填入相同环境 ID。
4. 执行 `npm run build`。cloudfunctions/api/index.js 已包含全部运行代码，不需云端安装依赖；当前不使用服务端 SDK。
5. 在开发者工具选择上传本地文件，或通过 CloudBase CLI 使用本地配置部署 api。示例的 installDependency: false 与自包含构建一致。
6. 在云函数控制台执行技术方案中的健康请求，再从小程序调用 `checkSystemHealth(requestId)` 验证链路。

云配置固定 Nodejs20.19。2026-09-11 核对的[CloudBase 官方配置文档](https://docs.cloudbase.net/cli-v1/functions/configs)仍列其为推荐运行时；发布前重新确认控制台支持情况。该选择不代表已部署验证。

SDK 初始化成功不保证函数存在或网络可用。未来密钥只配置在服务端，禁止写入客户端。

## 生成文件

提交源码、package-lock.json、配置模板和 project.config.json 的公共默认值。

不提交 node_modules、云函数 index.js/map、共享 contracts.js、local.ts、cloudbaserc.json 和开发者工具私有配置。不需要额外执行小程序“构建 npm”，客户端依赖由共享 bundle 提供。
