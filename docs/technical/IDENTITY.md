# 身份初始化实现与验证

`identity.ensure` 已部署到现有 api 云函数。首页加载通过 App.globalData.session.ensure() 获得应用身份，无昵称头像授权弹窗。会话合并并发请求，失败/超时手动重试保留 requestId，刷新和失效操作隔离旧响应；公开 UserDTO 只存内存，不缓存 OpenID。

请求 payload 仅 `{}`，返回 `{user:{id,displayName,version}}`，首次称呼“我”。服务端每次调用构建路由，只接受本次平台第二参数 context.environment 中的微信来源、匹配 AppID 和非空 OpenID。拒绝来自 event、process.env 或残留实例状态的身份。微信自动附加 userInfo/tcbContext，入口仅剥离传输元数据，不用于鉴权。

同一可信微信身份按 SHA-256([provider,appId,subject]) 定位映射，在事务中创建/读取 users、identities、user_scopes。业务实体使用应用 UUID。数据库结果按 unknown 校验；云函数打包 wx-server-sdk@4.0.2，自包含运行，不需云端安装依赖。

服务端配置：

| 配置 | 用途 |
| --- | --- |
| FAMILY_TODO_APP_ID | 匹配本次调用的小程序 AppID |
| FAMILY_TODO_IDENTITY_ENABLED | 新环境默认关闭；本次环境已验收接入并配置 true |
| FAMILY_TODO_CURSOR_SECRET | 个人业务游标签名密钥，至少 32 字符，仅在服务端配置 |
| SCF_NAMESPACE | 平台注入的当前环境，数据库显式绑定该值 |

密钥不得进入客户端、日志或提交文件。本地 cloudbaserc.json 被 Git 忽略。health 不依赖业务身份、开关或数据库；非法请求返回稳定错误，不泄露 SDK 原文。

2026-09-11 开发者工具真实云验证：微信调用上下文形状符合上述适配；连续及并发 ensure 返回同一个应用 UUID。CLI 伪造 userInfo/tcbContext 调用仍返回 UNAUTHENTICATED。7 个集合的客户端直接读、写都返回 -502003。真实业务读写及并发事务已通过，详见 [发布记录](CLOUD_DEPLOYMENT.md)。

联调发现 wx-server-sdk 将事务冲突包装为普通 Error，内置 code 重试未触发。适配器已对明确的冲突码/标记实现最多四次退避重跑，未知错误不重试。每次重跑复用候选 UUID；不依赖进程锁。

本地覆盖首次/重复/并发初始化、所有写点失败回滚、两模拟用户隔离、实例残留身份拒绝、会话超时和乱序、跨 realm 密码学随机数，以及独立 bundle。仍待第二个真实微信账号及 iOS/Android 真机验证；真实数据库故障注入回滚尚未执行，本地回滚模拟不等于云端故障验收。

SDK 依赖 audit 仍有 6 项告警（1 moderate、5 high），涉及 axios、lodash.set、lodash.unset 及上层依赖。未强制降级或未经验证覆盖间接版本，正式发布前仍需处理。
