# 基础架构

## 技术基线

采用原生小程序 + TypeScript、npm workspaces、五层共享包、统一 action API、Vitest 和 esbuild。当前仅包含占位首页与 api 云函数，业务功能尚未实现。AGENTS.md 规定分层、安全与验证规则。

微信 API 类型使用[官方 miniprogram-api-typings](https://github.com/wechat-miniprogram/api-typings)，避免维护不完整的手写全局类型。

## 分层

```text
小程序 pages/components → services → 统一 api 云函数
                            ↓              ↓
                         contracts     application → domain
                                            ↓
                                           ports
                                            ↑
                                       infra-cloudbase
```

函数入口负责依赖装配，application 负责校验和用例，domain 保存纯规则，ports 描述外部能力，infra-cloudbase 实现端口。当前 infra 只有时钟及 UUID，没有数据库仓储。健康入口使用标准 CloudBase 事件处理器，无需服务端 SDK；后续接入数据库、可信身份时再添加 SDK，仅允许在入口或适配层使用。

客户端链路：`system-api → AppApiClient → CloudFunctionTransport → wx.cloud.callFunction`。接口错误保留 ApiResponse，网络或格式异常抛 ApiTransportError。

共享 contracts 运行时打包到 `miniprogram/shared/contracts.js`，小程序通过相对路径导入。`.d.ts` 引用源类型，避免维护副本。不能在原生小程序中直接运行工作区源码；新增客户端共享模块须显式加入 bundle，不能只配置 TS alias。

## 当前接口

唯一 action 为 `system.health`，payload 必须是空对象：

```json
{
  "apiVersion": 1,
  "action": "system.health",
  "requestId": "ac9b6a08-4357-4a19-98bb-f1bffef9c4d0",
  "payload": {}
}
```

成功响应为 `{ ok: true, requestId, data: { status: "ok", service: "api", apiVersion: 1, now } }`。now 为服务端 UTC RFC3339 毫秒时间，例如 `2026-09-11T00:00:00.000Z`。

失败响应为 `{ ok: false, requestId, error: { code, message, retryable } }`。

| 错误码 | 触发条件 | retryable |
| --- | --- | --- |
| VALIDATION_ERROR | envelope、版本、UUID、payload 非法 | false |
| NOT_FOUND | action 未注册 | false |
| INTERNAL_ERROR | 未预期内部异常 | true |

有效 requestId 在响应中原样返回，非法或缺失时返回 unknown。客户端检查 ID 一致性、成功 data 和错误结构，不接受只有 ok 字段的伪响应。

健康检查只验证入口和协议，不代表数据库、鉴权、持久化幂等或消息能力已经实现。

## 环境与构建

- 版本库使用 touristappid 和空云环境。首页没有启动请求，未配置时不调用云 API。
- setup 只在缺失时生成 local.ts，不覆盖已有环境。
- App 云状态为 unconfigured/ready/unavailable；ready 仅表示 SDK 初始化成功。
- 云函数当前没有环境依赖，无硬编码账号或环境；以后初始化 SDK 时选择函数所属环境。
- 小程序 TS/WXML/WXSS 由开发者工具编译；共享 contracts 用 esbuild 打包。
- 云函数将 workspace 代码打包为自包含 CommonJS，部署不再安装 workspace 依赖。
- `npm run check` 执行初始化、构建、独立类型检查和测试；CI 执行同一命令。
- 测试覆盖输入、路由、异常脱敏、响应校验、云初始化和构建产物独立执行；真实编译、真机和云部署另行联调。
