# 子计划书 · 单会话（会话内智能体团队）+ UI

> 版本：v2.3（**未定稿**，待拍板）｜状态：**未定稿**｜定稿日期：—（v2.2 曾于 2026-11-24 定稿）｜权威范围：单会话模式的「表现形式与执行形态」+ 控制台 UI。不改源协议、不改主线 relay。
>
> **v2.3 修订说明（2026-11-24）**：用户指出「orchestrator/worker/subagent 三角色是原版超级智能体本来就有的，应该一开始就做进来」。核对主计划书 v1.0 §2「简化」表：当时把 orchestrator 降为规则代码、并在 worker preset 里裁掉调度/子代理工具——这丢掉了原版的三层角色结构。本版**恢复三层角色为核心**（不再是可选项），取代 v2.2 的「两层」设计。主计划 §2 中「orchestrator→规则」「worker 去调度」两行的简化，自本计划定稿起在执行形态上被本版取代。
>
> **为什么改回未定稿**：用户 2026-11-24 指出「单会话的表现不应该是这样，应该和智能体团队的表现形式相似」，随后澄清「**是很像，并不是完全一样**」。v1.1 只做了「一个接单会话 + 上下文压缩」，但工单仍由**顶层 `worker-*` 会话**执行——它们会作为独立会话出现在侧栏里，完全不像智能体团队。v2.x 把执行改成**会话内子智能体**，并在会话内呈现**自己的任务板 + 成员**：借鉴智能体团队的「一个会话里看得见团队在干活」的表现形式，但**不照搬**它的开关、组件、文案与任务语义。

## 0 一句话

单会话 = **一个会话里的一支团队**：你只跟一个会话说话；每来一个工单，它作为这个会话的**子智能体**（subagent）去干，任务板显示在会话头（和 Agent Teams 同一个位置），干完结果回到这个会话。

## 1 现在为什么不"像团队"

| | v1.1 现状 | v2.x 目标（像团队，但不等于团队） |
|---|---|---|
| 执行体 | `sessionController.create('worker-<id>')` 顶层会话 | `subagents.startActivation({provider:'spawn', parent: 接单会话})` 子智能体 |
| 侧栏 | 每个工单多一条 `worker-*` 会话 | 侧栏**只有**那一个接单会话 |
| 会话内 | 看不到任何工单痕迹 | 会话内出现**我们自己的任务板**（待办/进行中/完成）与**成员列表** |
| 上下文 | worker 自己的会话上下文 | 子智能体各自上下文；父会话只留调用/结果（短） |
| 观察 | 要点进另一个会话 | 就在当前会话里看进度、点开任务 |

### 1.1 「很像」与「不完全一样」的边界

**借鉴（要像的）**：一个会话承载全部；成员（子智能体）在会话里可见；任务进度在会话内可见；干完结果回到这个会话。

**不照搬（不一样的）**：
- 不复制 Agent Teams 的「团队模式开关 / 禁用确认 / 命令栏」——我们的入口是已有的**单会话开关**与**源**。
- 不复用它的 `TeamBoard` 组件与文案——我们渲染**自己的工单板**（数据来自工单状态机，不是共享任务板）。
- 任务语义不同：Agent Teams 是「成员认领共享任务」；我们是「源事件 → 工单 → 派给子智能体」，没有认领/依赖那套。
- 位置可以同区（会话头 subagent 区）但组件独立；若用户想要别的位置（右侧栏/成员卡片），改 §2.4 再拍板。

## 2 方案

### 2.1 源只是「监听器」，产出后走同一套流程

四个源（GitHub / 飞书 / QQ / 内部会话）**只负责监听和规范化 Trigger**，不含任何执行逻辑。监听之后全部汇入**同一条管线**，目标都是「**该工单所属工作空间的那个单会话**」：

| | 三个外部源 | 内部单会话 |
|---|---|---|
| 角色 | 监听器（poll 外部平台） | 监听器（读会话消息） |
| 产出 | Trigger → 工单 | Trigger → 工单 |
| 目标单会话 | 按工单所属工作空间（`repoPath` / 源配置映射）找到该工作空间的单会话 | 就是这个会话本身 |
| 之后 | 同一套 orchestrator→worker(subagent)→subagent | 同一套 |

- **不会再为工单新建顶层 `worker-*` 会话**（单会话模式开启时）；worker 是目标单会话里的子智能体。
- `singleSession.enabled=false` 仅是**回退开关**（旧顶层 worker 路径），用于对照/排障，不是常规路径。
- 每个工作空间有且只有一个单会话；不同工作空间的工单进各自的单会话，互不串。

### 2.2 统一执行管线（一套代码，全部源复用）

**不写两条分支。** 把 `lib/executor.js` 重构成**一条**三层管线，GitHub/飞书/QQ/会话源产出的工单全部走它：

```
任意监听器 → ticket(queued)                  [admission/限流/幂等 共用]
→ resolveTarget(ticket)                      [共用：按工作空间找到那个单会话]
→ orchestrator.route(ticket, target)         [共用：目标会话 agent 判定或 rules 回退]
→ ensureWorktree(ticket)                     [共用：每工单独立目录]
→ spawnWorker(ticket, target)                [共用：subagents.startActivation({parent: target})]
→ await activation.result                    [共用结果解析]
→ teardown(activation)                       [共用：dispose + archiveSession]
→ relay + 回写 + 面板                        [共用]
```

- 唯一驻留方式：worker = 目标单会话的**子智能体**（不再有顶层 `worker-*` 分支；旧路径仅 `singleSession.enabled=false` 回退）。
- `route/spawnWorker/teardown/parseResult/resolveTarget` 各只写一份，四个源共用。
- 串行 `maxWorkers:1`、取消、超时、脱敏、日志：共用，不因源而分叉。
- 第三层（worker 派 subagent）：worker preset 加回工具。
- 符合「源只监听、执行只一套」：加新源 = 只加一个监听器，执行侧零改动。

**resolveTarget 口径**：工单携带 `workspaceHint`——GitHub 用 `repoPath` 所在工作空间；飞书/QQ 用该源配置的 `workspace`（缺省=插件默认工作空间）；会话源=消息所在会话的工作空间。找不到对应单会话 → 该工单 failed 并写明原因（不静默、不猜）。

### 2.3 回报

- 优先：给子智能体注册 `ticket_report`（在 `agent/created` 事件里按 childId 命中后注册到 child.ctx，结束即撤）。
- 兜底：mandate 要求最后一行 `[[ticket:done]] 摘要` / `[[ticket:waiting]] 问题` / `[[ticket:failed]] 原因`，主进程解析 `activation.result` 的最终文本。
- 两种都拿不到 → failed（原因写明），不静默。

### 2.4 任务板 UI（像团队，但自己的板）

- 注册到 `conversation.session.header.actions.subagent.footer`（团队板所在的会话内区域），只在**当前会话有该工作空间的工单**时显示；组件是我们自己的 `SuperagentBoard`，**不复用** Agent Teams 的 `TeamBoard`。
- 数据：`GET /status?sessionId=<当前会话>` 返回该工作空间（按 session 的 cwd 匹配）的工单；client 在 slot 里按 5s 轮询。
- 行：状态点（待办/进行中/完成/失败）＋工单标题＋来源；展开显示工单 id/错误/摘要；点「打开」跳到控制台工单页。
- 成员列表不自己画：子智能体进入宿主 `subagentCatalog` 后，会话头已有的成员区会自然显示它们（这正是「像团队」的来源）。
- 尺寸与样式跟随宿主（`--dsw-alias-*`），不引 UI 库。

### 2.5 控制台（保留并调整）

- 概览：工作空间卡保留；「工单」页签保留（全局视角）。
- 工单表「会话」按钮改为「在会话里看」→ 用 `uiWorkspace.openSession(接单会话 id)`。
- 单会话设置不变。

### 2.6 代码改动

| 文件 | 改动 |
|---|---|
| `lib/executor.js` | **重构为统一三层管线**：resolveTarget/route/spawnWorker/teardown/parseResult 各一份，四个源共用；不再为工单新建顶层会话（旧路径仅 `singleSession.enabled=false` 回退） |
| `lib/orchestrator.js`（新） | 路由 mandate 组装、父会话判定解析（accept/attach/stop/ignore+preset）、超时回退 rules |
| worker preset（cordis.patch.yml） | 加回 subagent 派生工具（第三层），其余精简不变 |
| `lib/single-session.js` | 暴露「取该工作空间接单会话的 live agent」给 executor（resolve agent + ensure 会话） |
| `lib/panel.js` | `/status` 支持 `?sessionId=` 过滤该工作空间工单；tickets 增加 `mode: 'team'|'worker'` |
| `client.js` | 新增 TeamTaskBoard 组件 + 注册 `conversation.session.header.actions.subagent.footer`；工单「会话」按钮跳转调整 |
| `test/unit/executor-team.test.js`（新） | 激活参数、串行、dispose、结果解析（工具/文本/无回报）、**完工即卸载** |
| `test/unit/orchestrator.test.js`（新） | 路由判定解析、超时/拒答回退 rules、preset 选择、ignore/stop 不 spawn |
| `test/unit/single-session.test.js` | 补「取 live agent」路径 |

### 2.7 完工即卸载（用户 2026-11-24 追加）

子智能体干完（done/waiting/failed 任一终态）后**必须卸载**，不长期占用：

1. `await activation.dispose()` —— 停掉并释放该子智能体的运行时（计算/内存/运行态成员）。
2. `sessionController.archiveSession(childId)` —— 归档子会话，使其离开活跃会话列表与侧栏，不再占地方。
3. 卸载失败不吞：记 `ticket.lastError`/`store.lastError`，面板可见；不影响已落地的工单终态。
4. 我们自己的任务板只保留**近期**工单（完成/失败超过保留窗口自动从板上收起，默认保留最近 20 条），不无限堆积。

**宿主边界（如实说明）**：会话头的成员区由宿主 `subagentCatalog`（父会话的持久事件）驱动，公开 API **没有**「删除某条成员记录」的接口；归档+dispose 后子智能体不再运行、不在侧栏，但成员菜单里可能仍留一条「已完成」的历史标记（宿主行为）。若验收发现它仍明显占地方，另开子计划讨论（不擅自改宿主）。我们的任务板是干净的主视图。

### 2.8 三层角色（v2.3 恢复原版语义，核心而非可选）

原版超级智能体 = **orchestrator（调度）→ worker（执行）→ subagent（子代理）**。本版在单会话团队里恢复这三层：

| 角色 | 承担者 | 职责 | 复用 |
|---|---|---|---|
| orchestrator | **接单会话的 agent**（父会话） | 对新工单做路由判定：accept/attach/stop/ignore + 选 worker preset；不写代码 | 宿主 `sessionController.prompt/followup` 给父会话一条「路由」mandate |
| worker | 父会话下的**子智能体**（每工单一个） | 拿 mandate 在独立 worktree 干活、回报 | `subagents.startActivation({provider:'spawn', parent:父})` |
| subagent | worker 再派生的**子代理** | worker 内部的细分分工 | worker preset **加回** subagent 派生工具 |

执行流（替换 §2.2 的「直接 spawn」）：

```
工单 queued（规则 admission 仍作安全闸：白名单/限流/幂等）
→ orchestrator：给父会话投一条路由 mandate，收其判定（accept/attach/stop/ignore + preset）
   · 超时/拒答/格式错 → 回退 rules 判定（健壮性，不静默）
→ accept：host 用判定出的 preset spawn worker 子智能体（保留 activation 句柄以便收结果/卸载）
→ worker 执行（可再派 subagent）→ 回报 → 完工即卸载（§2.7）
```

- 配置：`singleSession.orchestrator: 'agent' | 'rules'`，**默认 'agent'**（原版语义）；'rules' 为省调用/兜底模式。
- worker preset：在现有精简执行工具基础上**加回** `subagent`/`subagent-spawn` 相关工具（第三层），其余仍精简。
- orchestrator 路由 mandate 只含路由事实（trigger 引用、现有工单摘要），不含实现计划（沿用原版 dispatch 约束）。
- 串行约束不变（maxWorkers=1）：orchestrator 一次路由一个工单。

## 3 里程碑

| 阶段 | 内容 | 退出条件 | 估时 |
|---|---|---|---|
| T1 | executor team 路径 + 结果解析 + 单测（stub subagents） | 单测覆盖激活/串行/dispose/解析 | 0.5 天 |
| T2 | `/status?sessionId=` 过滤 + tickets.mode | 路由实测 | 0.25 天 |
| T3 | TeamTaskBoard UI + 注册 slot | 客户端 smoke + 页面走查 | 0.5 天 |
| T4 | 集成验收：一条工单 → 会话内出现成员与任务 → 完成 → 任务板变绿、侧栏不新增会话 | 真实跑通 | 0.5 天 |

约 1.75 天。

## 4 验收（E12）

| 编号 | 判据 |
|---|---|
| E12.1 | 单会话开启：**任何源**（外部/内部）的工单都**不**产生新的顶层会话（侧栏无 `worker-*`） |
| E12.2 | 工单执行时当前会话头出现任务板（pending→in_progress→completed）与成员 |
| E12.3 | 子智能体在独立 worktree 里干活，父会话上下文只增加调用/结果（短） |
| E12.4 | 完成/需要人/失败能落到任务板与工单状态；来源回写照旧 |
| E12.5 | 取消/超时能 dispose 子智能体，不残留运行中的成员 |
| E12.6 | 单会话关闭：现有 `worker-*` 路径行为不变（回归） |
| E12.7 | 现有 83 条单测全绿；新增 T1 单测全绿 |
| E12.8 | **完工即卸载**：终态后子智能体被 dispose+archive，不再运行、不在侧栏；任务板不无限堆积（保留窗口生效） |
| E12.9 | **三层角色齐备**：orchestrator（父会话路由）→ worker（子智能体）→ subagent（worker 可再派生）；`orchestrator:'agent'` 时路由由父会话判定，'rules' 时走规则 |
| E12.10 | orchestrator 超时/拒答/格式错 → 回退 rules 且不静默（记 lastError）；ignore/stop 不 spawn worker |
| E12.11 | **四源同管线**：GitHub/飞书/QQ/会话源的工单都进「工单所属工作空间的单会话」；新增一个监听器不改执行侧 |

## 5 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R30 | `subagents.startActivation` 是宿主内部服务，跨版本可能变 | 版本锁 `<0.3`；失败明确报错，不静默降级 |
| R31 | 子智能体结果解析不稳（模型不按格式） | 工具优先 + 文本兜底；都拿不到标 failed 并保留原文 |
| R32 | 父会话上下文仍会被调用记录撑大 | 继续用 U1 的压缩维护器；子智能体上下文独立 |
| R33 | 任务板 slot 与 Agent Teams 争同一位置 | 双方都在 `footer` list 里，按 order 排；我们只在有工单时渲染 |
| R34 | worktree 仍每工单一个，磁盘会涨 | 保留现状（可回滚优先）；后续可加清理策略，不在本期 |
| R35 | 宿主成员菜单可能留「已完成」历史标记（无公开删除接口） | dispose+archive 保证不运行/不在侧栏；任务板做干净主视图；如仍占地方另开子计划，不擅自改宿主 |
| R36 | orchestrator 用模型路由可能误判/超时/不回报 | 规则 admission 仍作安全闸；超时/拒答回退 rules 并记 lastError；路由 mandate 只给路由事实不给实现计划 |

## 6 与已实现部分的关系

- **保留**：U1 压缩维护器、U2 `/status`/`settings`、U3 控制台四页签、独立页。
- **重构**：executor 变成一条三层管线（resolveTarget→route→spawnWorker→teardown→parseResult），四个源共用；旧顶层 worker 创建仅作 `singleSession.enabled=false` 回退。
- **新增**：任务板 UI、`/status?sessionId=` 过滤、结果解析、orchestrator 路由、worker preset 加回 subagent 工具。

## 7 待拍板

- **D14**：单会话开启时，工单改为**会话内子智能体**执行（推荐）；关闭时保持顶层 worker 会话。
- **D15**：任务板放在会话内 subagent 区（`conversation.session.header.actions.subagent.footer`），用**自己的** `SuperagentBoard` 组件（像团队、不照搬）。若想要别的位置，先说，我改 §2.4。
- **D16**（2026-11-24 追加）：**完工即卸载**——终态后 `dispose()` + `archiveSession(childId)`，任务板保留窗口默认最近 20 条。宿主成员菜单若留历史标记属宿主边界（R35），不擅自改。
- **D17**（2026-11-24 追加，恢复原版）：**三层角色** orchestrator/worker/subagent 为核心；**源只是监听器**，四个源监听后全部汇入同一管线，目标是「工单所属工作空间的那个单会话」；orchestrator 由该单会话 agent 承担（`orchestrator:'agent'|'rules'`，默认 'agent'），worker preset 加回 subagent 派生工具。
- 已确认口径（2026-11-24）：**很像智能体团队，但不是完全一样**——借鉴表现形式，不复制其开关/组件/任务语义（§1.1）。
- **2026-11-24 用户拍板 D14/D15/D16（v2.2 曾定稿）；v2.3 因恢复三层角色改回未定稿，D17 待拍板。** 拍板后改回定稿（v2.3）再执行。