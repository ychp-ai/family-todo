# 客户端状态

此目录预留给后续跨页面共享状态，当前没有业务 store。

- 页面局部状态保留在 Page/Component 内。
- SDK 调用封装在 services，store 只协调应用状态。
- 用户、家庭和待办模型确认后按业务领域新增 store，不提前创建假数据。
- 异步状态至少区分 loading、empty、error 和 ready；切换上下文时丢弃过期请求。
