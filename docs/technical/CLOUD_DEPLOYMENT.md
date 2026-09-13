# 云函数 CLI 发布记录

目标环境：`family-todo-d3g28fx1c314f8638`。仅部署事件型 `api`，所有业务 action 共用该入口。当前支持健康、身份、个人和家庭一次性协作，共 36 个 action，详见 [个人待办实现](PERSONAL.md) 和 [家庭协作实现](FAMILY.md)。下文保留历史记录，当前版本以末尾家庭协作更新记录为准。

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

命令中的 `npx --yes` 只跳过 npm 工具下载确认；实际3.8.1 CLI 的 fn deploy 使用 `--json`，未使用文档较新版本中的部署 `--yes` 参数。发布流程不自动加入 HTTP 网关、定时触发、数据库迁移或付费套餐变更。本次业务集合单独按 [数据库迁移记录](../../database/personal.md) 创建。云端安装依赖关闭，上传前必须重新构建。

## 首次创建记录（2026-09-11 17:20）

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

当时的健康检查仅证明真实云端入口和协议可用，其后业务验证如下。

## 个人业务更新（2026-09-11 18:19）

当前会话已授权 API 更新后自动部署至既有环境。已核对同名 api 与原函数 ID 一致，保持 Nodejs20.19、10 秒、256 MB、自包含 bundle、无触发器；未新增函数、付费资源或小程序发布。

实际使用本机已安装的 CloudBase CLI 3.8.1：

```sh
node /Users/yingchengpeng/.npm/_npx/8babb09a270560aa/node_modules/@cloudbase/cli/dist/standalone/cli.js fn deploy api -e family-todo-d3g28fx1c314f8638 --force --json
node /Users/yingchengpeng/.npm/_npx/8babb09a270560aa/node_modules/@cloudbase/cli/dist/standalone/cli.js fn detail api -e family-todo-d3g28fx1c314f8638 --json
node /Users/yingchengpeng/.npm/_npx/8babb09a270560aa/node_modules/@cloudbase/cli/dist/standalone/cli.js fn invoke api -e family-todo-d3g28fx1c314f8638 -d @docs/examples/system-health.json --json
```

| 验证 | 实际结果 |
| --- | --- |
| 函数 ID / 更新时间（上海） | lam-d4wj80fb / 2026-09-11 18:19:47 |
| 状态 / 类型 / 代码包大小 | Active、Available / Event / 1,542,177 字节 |
| 详情查询 RequestId | 07dea474-05b8-438b-bd8b-0bf6ac2b65bf |
| 最终健康检查 | ok=true，now=2026-09-11T10:25:31.144Z |
| 最终 health 云调用 RequestId | f585166c-6853-4a6d-afce-b4df81d629d9 |
| 微信开发者工具身份 | 同一账号并发初始化返回同一应用 UUID |
| CLI 伪造 userInfo / tcbContext | UNAUTHENTICATED；身份不取客户端字段 |
| 7 个集合客户端直接读写 | 均被权限规则拒绝 |
| 真实云端 API 验收 | 幂等、指纹冲突、分页、提醒、版本冲突、完成/跳过/撤销、删除/恢复、历史均通过 |
| 原生页面验收 | 快速新增、详情完成/撤销、编辑保存返回详情通过 |

本次 `cloudfunctions/api/index.js` SHA-256 为 `3fbd11e1ce3eb61fb26006112c3ae547ea2570d39781cb5496585c4412897c3c`。SDK 事务冲突被包装为 Error.message 导致并发重放失败的问题已修复，新增限定冲突识别和有限退避；修复后在真实云环境重跑通过。[实际 API 验收步骤与时间](personal-cloud-verification.json)已保存，不含账号身份数据。7 集合、索引、ACL 的实际创建请求见 [数据库记录](../../database/personal-provision-result.json)。

最终在 Node 20.19.0 执行 `npm run check`，15 个文件、142 项测试通过；独立 TypeScript 检查、客户端共享产物和云函数 bundle 构建通过。`git diff --check` 通过。

验证边界：尚未完成第二个真实账号隔离、iOS/Android 真机和真实云端强制失败回滚（后者本地覆盖四个事务写点）。页面删除确认被自动审批阻止，回收站页面恢复流程未继续；仅该接口的真实云端流程已通过。待清理的本次页面验收事项为“页面验收：整理完成后再做”，ID `e748554e-7eab-4b72-8e1b-5327f8c1b7e5`。电脑随后锁屏，最后的按钮宽度与文字居中修复完成编译但未重新截图核验。跨进程未决写恢复和 SDK 依赖告警仍见 [实现边界](PERSONAL.md)。


## 家庭协作更新（2026-09-12 00:20）

沿用当前会话授权，先核对远端仍为 `lam-d4wj80fb`，迁移并复核新增8个服务端集合及12个受影响集合的全部索引/ACL，再更新既有 api。命令与上一节相同（`fn deploy api … --force --json`、`fn detail`、`fn invoke`）。数据库迁移第二次执行未重复创建资源，校验结果见 [家庭迁移记录](../../database/family-provision-result.json)。

| 验证 | 实际结果 |
| --- | --- |
| 函数 ID / 更新时间（上海） | lam-d4wj80fb / 2026-09-12 00:20:00 |
| 状态 / 类型 / 代码包大小 | Active / Event / 1,625,385 字节 |
| 运行时 / 超时 / 内存 | Nodejs20.19 / 10秒 / 256 MB |
| 云端安装依赖 | FALSE |
| 详情查询 RequestId | 487bab1a-6129-41eb-9cf5-88147e052df2 |
| CLI system.health | ok=true，now=2026-09-11T16:21:13.166Z |
| health 云调用 RequestId | 4b6c0d0a-1cd6-4520-b525-143a3640b410 |
| 真实云端单账号验证 | 家庭创建及幂等、版本冲突、邀请密文回执重放/重复加入/撤销、无账号成员创建修改停用、家庭事项/索引查询、代记/撤销、本人关闭提醒、协作设置、回收站/恢复/历史通过；个人已完成事项归入家庭后原单次/历史/提醒回执与新增重试保持一致 |
| 新增8集合客户端直读 | 全部拒绝 |

本次本地 `cloudfunctions/api/index.js` SHA-256 为 `a4833b7678bfeb8be4a629d536b18395f3ea10c55a439c948cdc79e6a221c535`。上传前 Node 20.19.0 执行 `npm run check` 通过：21个测试文件、242项测试，严格类型检查、客户端共享产物与独立云函数 bundle 构建通过。

CLI 3.8.1 会将 JSON 形式的环境变量字符串解析为对象，前两次部署因此被平台拒绝，未替换旧版。邀请密钥环改为 `base64url:` 前缀的 UTF-8 JSON 编码后部署成功，服务端仍兼容原 JSON 格式；格式验证测试和独立评审通过。配置只保存在忽略的本地文件及云函数环境变量中，文档不包含密钥。

[真实 API 验收步骤与时间](family-cloud-verification.json)保留16组验证记录。仅创建本次“协作验收家庭”和验收数据，邀请已撤销，未向他人发送；API 验收事项已移入回收站，API 验收无账号成员已停用，家庭保留供页面核验。未触碰上一阶段待清理的页面验收事项。

验证边界：真实环境目前只有一个微信账号，无法证明跨真实账号的加入/隔离/退出/转交；这些场景已由本地多身份事务测试和独立评审覆盖，仍需双账号及 iOS/Android 真机验收。未上传微信体验版或发布小程序。原生页面已接入家庭服务；微信开发者工具取得家庭列表、成员详情、唯一拥有人无承接人提示和已撤销邀请列表的真实截图。后续原生新增无账号成员“页面验收孩子”操作因电脑锁屏和 automator 超时未取得成功结果，当时不能计入通过；2026-09-13 完整回读已确认未创建该成员。停用成员展示与按钮折行修复已编译，尚未重新截图；双账号邀请/代记/移除/转交、微信分享及弱网交接仍待实测。

客户端接入后，Node 20.19.0 的最终 `npm run check` 通过：24个测试文件、257项测试。独立小程序和服务端类型检查、共享契约与函数 bundle 构建通过，函数产物 SHA-256 与上述已部署版本一致，无需重复部署。`git diff --check` 通过。


## 家庭协作评审补丁（2026-09-13 12:33）

完成独立评审反馈：家庭事项按实际执行人归组；家庭预览、写入和回收站恢复失权时清理旧内容；编辑必要查看人随执行对象重算。服务端新增 `ParticipantDTO.isCreatorManager` 标记，明确创建管理者及交接后的管理者；旧幂等回执允许缺少该字段，客户端此时先刷新再允许更换执行对象。

沿用会话部署授权，执行上一节完整 CLI deploy/detail/invoke 命令，更新同一既有函数。部署命令退出码为 0，返回成功。

| 验证 | 实际结果 |
| --- | --- |
| 函数 ID / 更新时间（上海） | lam-d4wj80fb / 2026-09-13 12:33:07 |
| 状态 / 运行时 / 代码包大小 | Active / Nodejs20.19 / 1,625,528 字节 |
| 超时 / 内存 | 10秒 / 256 MB |
| 详情查询 RequestId | 511811f8-52f0-4dc0-9f9b-d3ac9046f999 |
| CLI system.health | ok=true，now=2026-09-13T04:33:39.503Z |
| health 云调用 RequestId | cbfa322e-133d-42f8-8905-75c706a00e06 |
| 微信开发者工具真实 API 回读 | 回收站2条事项参与人的创建管理者标记均为布尔值；无账号成员完整列表确认“页面验收孩子”未创建 |

本次本地函数 bundle SHA-256：`537e5177023dde96a2b5f9d44c272330e5248c07ff24be3b10b1864136edd40e`。Node 20.19.0 下最终 `npm run check` 通过，24个测试文件、271项测试，包含独立类型检查、共享契约和函数 bundle 构建。客户端独立复核5个文件、33项测试及小程序类型检查通过，三项评审问题全部关闭；服务端兼容回执和权限标记通过独立评审。[补丁真实回读记录](family-patch-verification.json)不含账号身份或邀请口令。

双真实账号、iOS/Android 真机、微信分享和弱网交接仍待验收；页面按钮及停用成员样式尚未取得修复后截图。未上传体验版、发布小程序或提交推送代码。
