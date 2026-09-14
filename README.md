# 家庭待办提醒

面向家庭成员协作的微信小程序。当前已实现身份接入、个人及家庭待办、成员协作、每日/每周周期、小程序内提醒、家人进度与批量追加可见人。真实部署与验收范围见发布记录。

采用原生微信小程序 + TypeScript、CloudBase、npm workspaces，以及 contracts/domain/ports/application/infra-cloudbase 分层。

## 快速开始

```bash
nvm use
npm ci
npm run check
```

然后用微信开发者工具导入仓库根目录。空云配置可预览页面和配置错误状态，本地配置由 setup 自动生成。开发时执行 `npm run dev` 监听共享契约，页面由开发者工具编译。

## 已搭建

- 原生首页、详情、编辑、回收站、家庭管理、邀请和进度页面；新增、编辑、完成/跳过/撤销、删除/恢复及历史次数记录。
- 多家庭筛选、真实/无账号成员、邀请与撤销、退出/移除及拥有权转交、事项可见与代记权限。
- 每日/每周最多 6 个时刻、服务端日程预览、暂停/继续/停止；历史次数保留原执行对象。
- 按家庭/日期/执行对象查看可见进度，最多 20 项批量追加可见人或将个人事项归属家庭；未完成批次可续办。
- 未决业务写按账号和环境保存原请求，重启后从首页主动确认结果；编辑及快速新增支持草稿恢复，保存成功后清理。邀请接受口令仅在进程内保留。
- 统一 API、运行时校验、安全错误和 system.health 健康检查。
- `identity.ensure` 契约、逐请求身份解析、事务用户映射和小程序会话协调；支持初始化去重、同请求 ID 重试、超时与失效响应隔离。已接入真实云环境，见 [身份接入](docs/technical/IDENTITY.md)。
- 已通过 CloudBase CLI 部署身份、个人与家庭待办、周期、进度和批量追加 API，创建并配置 19 个服务端专用集合，详见 [发布记录](docs/technical/CLOUD_DEPLOYMENT.md)。
- 云函数、共享包分层、可注入时钟及 UUID。
- 严格类型检查、Vitest、esbuild、锁文件和 GitHub Actions 检查。
- [AGENTS.md](AGENTS.md)、环境模板和开发文档。

## 文档

- [首版业务需求](docs/REQUIREMENTS.md)
- [业务开发设计与验收](docs/business/DELIVERY.md)
- [当前范围](docs/SCOPE.md)
- [首版技术方案](docs/TECHNICAL_DESIGN.md)
- [开发与云环境接入](docs/DEVELOPMENT.md)

首版业务需求已明确：多家庭成员管理与虚拟人、待办可见性与协作、周期事项和小程序内提醒，以及跨家庭聚合处理。当前实现及验证边界详见 [当前范围](docs/SCOPE.md)、[家庭协作实现](docs/technical/FAMILY.md) 和 [日程实现](docs/technical/SCHEDULING.md)。原生页面严格对照 `design/` 设计稿，不自行调整布局、样式、文案或交互。

## 仓库

- GitHub：https://github.com/ychp-ai/family-todo
- SSH：`git@github.com:ychp-ai/family-todo.git`
