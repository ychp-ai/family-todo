# 云函数 CLI 发布记录

目标环境：`family-todo-d3g28fx1c314f8638`。仅部署事件型 `api`，所有业务 action 共用该入口。当前业务接口仍为设计，实际运行只支持 `system.health`。

## 发布参数

| 参数 | 值 |
| --- | --- |
| 函数名 / 入口 | api / index.main |
| 运行时 | Nodejs20.19 |
| 超时 / 内存 | 10秒 / 256 MB |
| 依赖 | esbuild 自包含，installDependency=false |
| 配置 | 本地忽略文件 cloudbaserc.json；公开模板 cloudbaserc.example.json |
| CLI | @cloudbase/cli 3.8.1 |

不需要为每个 action 单独创建云函数。部署命令首次创建函数；已有同名函数时先核对远端详情，不能直接 force 覆盖未知服务。CLI 用法依据 [CloudBase 官方部署文档](https://docs.cloudbase.net/cli-v1/functions/deploy)，运行时依据 [配置文档](https://docs.cloudbase.net/cli-v1/functions/configs)。

## 可复现步骤

在仓库根目录、Node 20.19.0 下运行。CLI 可通过已安装的 `tcb` 执行；以下 npx 写法固定工具版本，不将 CLI 加入业务依赖。

```sh
npm run check
npx --yes --package=@cloudbase/cli@3.8.1 tcb login
npx --yes --package=@cloudbase/cli@3.8.1 tcb env list
npx --yes --package=@cloudbase/cli@3.8.1 tcb fn list -e family-todo-d3g28fx1c314f8638
npx --yes --package=@cloudbase/cli@3.8.1 tcb fn deploy api -e family-todo-d3g28fx1c314f8638 --json
npx --yes --package=@cloudbase/cli@3.8.1 tcb fn detail api -e family-todo-d3g28fx1c314f8638 --json
npx --yes --package=@cloudbase/cli@3.8.1 tcb fn invoke api -e family-todo-d3g28fx1c314f8638 -d @docs/examples/system-health.json --json
```

命令中的 `npx --yes` 只跳过 npm 工具下载确认；实际3.8.1 CLI 的 fn deploy 使用 `--json`，未使用文档较新版本中的部署 `--yes` 参数。不得加入 HTTP 网关、定时触发、数据库迁移或付费套餐变更。云端安装依赖关闭，上传前必须重新构建。

## 验证记录（2026-09-11）

用户完成 CLI 设备登录授权后，env list 确认上海目标环境 Normal，fn list 返回空列表。随后通过 `tcb fn deploy api -e family-todo-d3g28fx1c314f8638 --json` 首次创建成功（COS 上传），未覆盖任何既有函数。

| 云端验证 | 实际结果 |
| --- | --- |
| 创建时间（Asia/Shanghai） | 2026-09-11 17:20:36 |
| 函数 ID | lam-d4wj80fb |
| 类型 / 状态 | Event / Active / Available |
| 运行时 / 入口 | Nodejs20.19 / index.main |
| 超时 / 内存 / 云端安装依赖 | 10秒 / 256 MB / FALSE |
| 触发器 | 空列表 |
| system.health | ok=true，status=ok，now=2026-09-11T09:20:55.080Z |
| health 云调用 RequestId | d3a3bd2a-424f-4fd2-893e-8104f5907ffb |
| 携带额外 role 的请求 | VALIDATION_ERROR，retryable=false，保留合法 requestId |
| 未实现 task.list | NOT_FOUND，retryable=false，无模拟业务数据 |

本次上传的本地 `cloudfunctions/api/index.js` SHA-256：`720719021ccf598df4f6333f90717cd2bedb2a51d6d5f3789672d4a347af8c96`。它用于关联构建产物，不作为未来云端版本仍未变化的证明。

本地已完成：Node 20.19.0 下 `npm run check` 通过（6个测试文件、46项测试），含独立函数 bundle 调用、客户端构建与未知请求字段拒绝。`git diff --check` 通过。CLI 实际复用了本机 npm 缓存中的3.8.1安装，不向仓库增加 CLI 依赖。

健康检查仅证明真实云端入口和协议可用。微信 AppID 绑定、可信业务身份、多账号隔离、数据库事务及真机调用仍须在业务实现阶段验证。
