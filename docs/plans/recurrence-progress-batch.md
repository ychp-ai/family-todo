# 周期、进度与批处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task, with independent spec and quality review.

**Goal:** 在现有个人及家庭待办上实现每日/每周周期、可见执行人进度、批量追加可见人及个人归属家庭。

**Architecture:** 纯领域日程投影使用上海日历与不可变片段、task 级控制区间和稀疏单次状态；用例复用可信身份、家庭写栅栏和持久化幂等。周期候选按有限日期窗口分页，进度完整扫描后发布，批量拆成有独立回执的单项事务。旧一次性数据及回执保留兼容。

**Tech Stack:** 原生 WXML/WXSS/TypeScript、npm workspaces、CloudBase、Vitest、esbuild。

**Spec:** docs/REQUIREMENTS.md; docs/technical/SCHEDULING.md; docs/business/API.md; docs/business/DATA_MODEL.md; docs/business/INTERACTIONS.md; design/

## Global Constraints

- 当前分支 codex/family-collaboration，基线 37e073a。不覆盖其他改动；本次实现不自动提交或推送。
- 用户既有会话授权 API 更新后部署到现有环境；新迁移须复核目标、索引、ACL并保留验证记录。
- Asia/Shanghai；日期范围2000–2100，UTC RFC3339毫秒瞬时；不使用客户端时钟做权威判断。
- daily/weekly；ISO weekday 1–7；每日最多6个不重复时刻；起止日期包含两端。
- 10家庭、每家20真实+20有效虚拟成员、500未删除事项；每批最多20项、事务最多80文档操作、共享8秒应用预算。
- 历史片段/次数执行人保持不变，必要历史执行人访问按当前有效成员鉴权；未来周期不可提前记录。
- 不补新建前、暂停期、删除期次数；停止不可继续；周期恢复为paused，停止历史canResume=false。
- 单次UUID由规范元组派生，不信任客户端次数；旧once引用/回执继续有效。
- 查询范围最多31天；每页默认20/最大50；未扫完必须有cursor，不发布局部最终统计；过去积压无任意截断。
- 批处理仅追加可见人，不隐式新增提醒/代记，不跨家庭迁移；原个人归属+追加单项原子。
- 不添加订阅消息、后台定时任务、外部通知、附件等首版外能力。
- 页面严格复用design；加载/空/错/重试，未知写保留requestId及完整payload，失权清理。
- 工作者不创建子代理、不提交、不推送、不部署；由主代理统一集成和部署验证。

### Task 1: 日程契约与纯领域投影

**Files:** packages/contracts/src/personal.ts、api.ts及测试/index.ts；packages/domain/src/scheduling.ts及测试/index.ts。
**Interfaces:** 产出Schedule联合类型与isSchedule；扩展PersonalActionMap既有注册集合，新增task.previewSchedule/pause/resume/stop/batchAddViewers、progress.get及严格payload/data guards。domain独立定义结构兼容Schedule、ScheduleSegment、ScheduleControl、ProjectedOccurrence与投影函数，最终准确签名写报告交给Task2。

- [x] 按API文档实现所有输入输出，lifecycle扩展paused/stopped；旧DTO、旧write回执继续通过guards。
- [x] 领域函数覆盖日历校验/加日/weekday/上海瞬时/有限窗口投影/生命周期边界；UUID派生留端口，domain只返回规范身份元组。
- [x] 行为测试包含以下断言场景，使用真实函数签名实现：
```ts
// 上海18:30新建，不追08:00。
expect(slots.map(x => x.slot)).toEqual(['20:00']);
// 星期与日期跨界，窗口拆分不变。
expect([...left, ...right]).toEqual(whole);
// 已有slot恰好切分时刻归旧片段，新片段严格晚于该时刻。
expect(oldRefs).toContain(equalTimeRef);
expect(newRefs).not.toContain(equalTimeRef);
```
- [x] 覆盖date-only创建/编辑/暂停/恢复、暂停中编辑、停止后删除恢复、未来record和实际完成时间约束、非法日期/重复时刻/跨年。
- [x] 执行相关Vitest，说明下游扩展Schedule导致的暂时类型错误；不修改应用及页面来掩盖未集成。

### Task 2: 周期持久化与应用闭环

**Files:** packages/domain/src/personal.ts/family.ts；packages/ports/src/personal.ts/family.ts；packages/infra-cloudbase/src/中的日程适配及现有codecs/stores；packages/application/src/中的周期用例及既有personal/collaborative任务/列表/上下文；cloudfunctions/api/src/index.ts；tests/recurrence*.test.ts及support；database/与tools/migration/。
**Interfaces:** 消费Task1的Schedule与投影函数（以其报告准确签名为准）；现有CollaborativeTaskService对全部既有和新增周期action提供兼容路由；FamilyStore提供片段、控制、稀疏状态分页及事务持久化，所有实现与fake同步。

- [x] 新周期创建、once改周期、周期编辑、pause/resume/stop、删除恢复在单项事务中写Task/segment/control/event/receipt；旧once不无端迁移或改ref。
- [x] 完成/跳过/撤销校验ref和片段与task级控制；投影未落库version=0，首写原子持久化；管理者/该次历史执行人/当前helper分开计算。
- [x] 日期列表、积压和提醒都使用有界投影分页及revision/actor绑定，长期未开应用仍可加载全部积压；完整前summary=null。
- [x] 对照以下测试实现真实用例集成：
```ts
expect(afterEdit.oldMorning.subject).toEqual(originalSubject);
expect(recordInvalidOldEvening.error.code).toBe('INVALID_STATE');
expect(restored.task.lifecycle).toBe('paused');
expect(stoppedRestored.task.capabilities.canResume).toBe(false);
expect(replayed).toEqual(firstWrite);
```
- [x] 覆盖旧回执重放、家庭交接、权限撤销、事务失败回滚、同版本并发、分页跨片段无重复、提醒receipt独立。
- [x] 迁移集合与索引ACL支持重复运行，函数自包含；运行相关测试、类型与构建检查。

### Task 3: 进度与批处理用例

**Files:** packages/application/src/progress.ts、batch-viewers.ts及必要路由与存储；tests/progress.test.ts、batch-viewers.test.ts。
**Interfaces:** 消费Task2统一候选/投影和权限检查；progress.get按family/date/subject返回members|null和完整cursor；task.batchAddViewers父进度及actor/requestId/taskId子回执原子保存。

- [x] 进度按各次subject聚合，仅当前可见数据，skipped不计分母，未来安排计pending，未扫完members=null。
- [x] 批量父请求指纹检查、重复taskId拒绝；每项实时鉴权、expectedVersion、目标family校验；追加去重且保留提醒/代记与本人关闭状态。
- [x] 8秒预算不足以启动下一项时返回pending；原ID完整payload续跑，已提交项不重复；全部终态后新ID只重试失败项。
- [x] 行为测试：
```ts
expect(progress.denominator).toBe(progress.completed + progress.pending);
expect(partial.members).toBeNull();
expect(second.results[0]).toEqual(first.results[0]);
expect(viewersAfter).toEqual(expect.arrayContaining(viewersBefore));
expect(helpersAfter).toEqual(helpersBefore);
```
- [x] 验证跨家庭混合成功/失败、预算中断、并发同ID、响应丢失后重放及重放后失权不泄漏旧DTO；单项归属失败整体回滚。

### Task 4: 原生周期、进度与批处理页面

**Files:** miniprogram/services/；pages/editor/detail/home/families/；新增进度页面及app.json；页面行为测试、docs/technical/CLIENT.md。
**Interfaces:** 仅通过services使用Task1动作；完全消费服务端nextOccurrences/canRecord/canResume/进度和逐项批量状态。

- [x] 按design实现每日/每周/日期范围/多时刻与预览、当前/历史次数及暂停恢复停止；选择执行对象保留历史必要查看人。
- [x] 家庭进度按家庭、执行对象、日期读取，显示可见范围和空态，未完整结果继续加载。
- [x] 首页多选可管理事项，按家庭追加可见人；个人显式选目标家庭；逐项结果/pending续跑/失败项重试，不隐式新增权限。
- [x] Page模拟行为测试覆盖未来次数不可记录、历史subject、未知写重试不重复、进度未完整不显示0、切换范围忽略旧响应、失权清理。
- [ ] 原生开发者工具编译和可执行页面验收，受限实测明确记录；运行小程序类型检查和服务/Page测试。

### Task 5: 完整评审、部署与交付文档

**Files:** README.md、AGENTS.md、docs/SCOPE.md、技术/业务/数据库/发布记录。
**Interfaces:** 采用已评审Task1–4完整实现与迁移，不将本地模拟标作真机验证。

- [x] 独立task评审及最终整体评审，修复影响正确性和安全的问题。
- [x] 执行npm run check，独立bundle与git diff --check；保留结果和已知实测边界。
- [x] 使用既有授权核对环境同名api，迁移可重跑、仅服务端ACL，CLI部署/detail/health；单账号真实周期/批量/进度回读并保存脱敏证据。
- [x] 同步已实现范围、操作数和限制；双真实账号与真机不足明确列出，不宣称体验版已发布。

原生验收状态：2026-09-14开发者工具自动化页面操作超时，Mac 锁定且无法自动解锁，等待手动解锁后完成 Task 4 最后一项。代码、云迁移、部署和单账号 API 验证已通过；实际证据见发布记录。
