# 家庭待办提醒

面向家庭成员协作的微信小程序。当前已建立基础工程，家庭、待办、提醒等业务功能尚未实现。

采用原生微信小程序 + TypeScript、CloudBase、npm workspaces，以及 contracts/domain/ports/application/infra-cloudbase 分层。

## 快速开始

```bash
nvm use
npm ci
npm run check
```

然后用微信开发者工具导入仓库根目录。空云配置可预览占位首页，本地配置由 setup 自动生成。开发时执行 `npm run dev` 监听共享契约，页面由开发者工具编译。

## 已搭建

- 小程序入口、占位首页、通用页面状态、样式变量和服务目录。
- 统一 API、运行时校验、安全错误和 system.health 健康检查。
- 云函数、共享包分层、可注入时钟及 UUID。
- 严格类型检查、Vitest、esbuild、锁文件和 GitHub Actions 检查。
- [AGENTS.md](AGENTS.md)、环境模板和开发文档。

## 文档

- [首版业务需求](docs/REQUIREMENTS.md)
- [当前范围](docs/SCOPE.md)
- [架构与接口](docs/TECHNICAL_DESIGN.md)
- [开发与云环境接入](docs/DEVELOPMENT.md)

首版业务需求已明确：多家庭成员管理与虚拟人、待办可见性与协作、周期事项和小程序内提醒，以及跨家庭聚合处理。具体规则见需求文档，业务代码尚未实现。

## 仓库

- GitHub：https://github.com/ychp-ai/family-todo
- SSH：`git@github.com:ychp-ai/family-todo.git`
