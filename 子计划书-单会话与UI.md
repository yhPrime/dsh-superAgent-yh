# 子计划书 · 单会话（会话内智能体团队）+ UI

> 版本：v2.9.1（**定稿**）｜状态：**定稿（2026-11-25 补 D29 preset 漂移纠回）**｜上次定稿：v2.9（2026-11-24）｜权威范围：单会话模式的「表现形式与执行形态」+ 控制台 UI。不改源协议、不改主线 relay。
>
> **v2.9.1 补丁（2026-11-25）**：真机发现登记成功后 preset 会被改回 `ptc`（会话首轮前的竞态：新建会话的 preset 座位把暂存值 apply 到会话上），会话一开首轮就再也切不回来。补 D29：监听宿主 `agent-preset/selected`，已登记会话上出现非 `single.preset` 的值且会话仍空白时立刻纠回（每次会话最多 3 次防抖），已开始的会话只记一次日志；不新增 UI、不改交互。
>
> **v2.9 修订（2026-11-24 定稿）**：用户要求「单会话应该默认使用极简模式这样 token 消耗最小，超级智能体插件只给单会话拼接必要的上下文」。这与 v2.8/D27「单会话切成重调度者 preset」方向相反——D27 每轮都要付 persona + 全套工具 schema 的钱，且每张工单还把路由 prompt 灌进用户会话。本版改为：单会话默认跑宿主内置 **`minimal`（极简模式）**；插件只往单会话写必要的东西（用户的话、relay 三条短消息）；路由由插件用 `ctx.llm` 一次性调用判定（**D28 已选选项 2**），单会话历史里连路由问答都不留。worker 子智能体用宿主 `startActivation` 的 `agentPreset` 字段**显式指定** `dsh-superagent-yh-worker`，不再靠继承父 preset。
>
> **v2.8 修订（2026-11-24 用户选 A）**：单会话登记时**切换到一个调度者 preset**（`dsh-superagent-yh-orchestrator`），让它在直接对话里也像智能体团队一样把任务派给子智能体，而不是自己干。另开一份占位计划 `子计划书-单会话UI修改.md`（状态：待做计划）。
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

### 2.1 三个外部源是「监听器」，单会话是「目的地」

**三个外部源**（GitHub / 飞书 / QQ）只负责监听外部平台并规范化 Trigger，不含任何执行逻辑；监听之后全部汇入**同一条管线**，目标是「**该工单所属工作空间的那个单会话**」。

**单会话不是监听器**：它就是目的地，也是 orchestrator 所在。你在里面说话 = 直接跟 orchestrator 交互（它可以当场派 worker），不经过"源"。

| | 三个外部源 | 单会话 |
|---|---|---|
| 角色 | 监听器（poll 外部平台） | 目的地 + orchestrator 驻地 |
| 产出 | Trigger → 工单 | 不是源，不产生"监听事件" |
| 之后 | 同一套 orchestrator→worker(subagent)→subagent | 由它的 agent 承担路由与派工 |

- **不会再为工单新建顶层 `worker-*` 会话**（单会话模式开启时）；worker 是目标单会话里的子智能体。
- `singleSession.enabled=false` 仅是**回退开关**（旧顶层 worker 路径），用于对照/排障，不是常规路径。
- 每个工作空间有且只有一个单会话；不同工作空间的工单进各自的单会话，互不串。
- 「会话源（`sources.session`）」这个想法**作废**：会话是目的地，不需要再把自己监听起来当任务源（见 `子计划书-会话版.md` 状态）。

### 2.2 统一执行管线（一套代码，全部源复用）

**不写两条分支。** 把 `lib/executor.js` 重构成**一条**三层管线，GitHub/飞书/QQ 的工单全部走它（单会话自己的对话直接由 agent 处理，不进这条管线）：

```
外部监听器 → ticket(queued)                  [admission/限流/幂等 共用]
→ assessment(ticket)                         [共用入口；QQ=模型研判，其它源=规则直通]
→ resolveTarget(ticket)                      [共用：按工作空间找到那个单会话]
→ orchestrator.route(ticket, target)         [共用：目标会话 agent 判定或 rules 回退]
→ ensureWorktree(ticket)                     [共用：每工单独立目录]
→ spawnWorker(ticket, target)                [共用：subagents.startActivation({parent: target})]
→ await activation.result                    [共用结果解析]
→ teardown(activation)                       [共用：dispose + archiveSession]
→ relay + 回写 + 面板                        [共用]
```

- 唯一驻留方式：worker = 目标单会话的**子智能体**（不再有顶层 `worker-*` 分支；旧路径仅 `singleSession.enabled=false` 回退）。
- `route/spawnWorker/teardown/parseResult/resolveTarget` 各只写一份，三个源共用。
- 串行 `maxWorkers:1`、取消、超时、脱敏、日志：共用，不因源而分叉。
- 第三层（worker 派 subagent）：worker preset 加回工具。
- 符合「源只监听、执行只一套」：加新源 = 只加一个监听器，执行侧零改动。

**resolveTarget 口径**：优先级 = ①工单确定性线索（GitHub `repoPath` 工作空间；飞书/QQ 源配置里显式 `workspace`）→ ②QQ 模型研判返回的 `workspace`（必须在候选清单内）→ ③插件默认工作空间。找不到对应单会话 → 该工单 failed 并写明原因（不静默、不猜）。

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
| `lib/executor.js` | **重构为统一三层管线**：resolveTarget/route/spawnWorker/teardown/parseResult 各一份，四个源共用；不再为工单新建顶层会话（旧路径仅 `singleSession.enabled=false` 回退）；`runSubagent()` 的 `startActivation` **显式传 `agentPreset: config.workerPreset`** |
| `lib/orchestrator.js`（新） | 路由 mandate 组装、目标会话判定解析（accept/attach/stop/ignore+preset）、超时回退 rules；投递通道按 D28 选项（单会话 prompt 或 `ctx.llm` 一次性） |
| `lib/assessment.js`（新） | 按源研判：QQ 用 `ctx.llm` 严格 JSON、批处理、超时；其它源直通 accept；失败回退 accept + lastError |
| worker preset（cordis.patch.yml） | 加回 subagent 派生工具（第三层），其余精简不变 |
| `cordis.patch.yml`（v2.9） | **删除 `dsh-superagent-yh-orchestrator-preset` 整行**（order 91） |
| `lib/config.js`（v2.9） | 删 `orchestratorPreset`；`singleSession` 增 `preset`（默认 `'minimal'`），`panel.mergeSettings` 白名单同步 |
| `lib/single-session.js` | 暴露「取该工作空间接单会话的 live agent」给 executor（resolve agent + ensure 会话）；登记/解除/reconcile 改按 `singleSession.preset`（默认 `minimal`）切换与恢复 |
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

### 2.9 监听器怎么跑（脚本轮询，不要"会话驻守"）

监听器**不是会话**，也不许常驻一个 agent 去盯：

- **脚本轮询**：复用现有 `setInterval` 调度 + `source.poll(since)`，在插件进程里跑；无模型调用、无会话开销。
- **收到消息后判断分给哪个单会话**：由 `resolveTarget(ticket)` 在**宿主代码**里按 `workspaceHint` 决定（GitHub→repoPath 工作空间；飞书/QQ→源配置 workspace；缺省→默认工作空间）。这是确定性映射，不交给模型猜。
- **不驻守会话的理由**：常驻 agent 要模型保活、断线要重连、成本高且会漂移；原版也是 Source 脚本 + Main Session（orchestrator），不是每个源养一个会话。
- 单会话只在**有工单要路由/执行**时才被唤醒（orchestrator 那条 mandate），平时是普通会话。
- `gap/落后/限流` 由监听器自己记 `lastError` 并退避，不拖垮其它源。

### 2.10 监管者（Eval Assessment）：按源开启，QQ 用模型

- 新增 `lib/assessment.js`：`assess(ticket, context) -> {verdict:'accept'|'ignore'|'stop', reason, preset?}`，**按源选实现**。
- **QQ = 模型研判 + 选工作区**（默认 `'agent'`）：QQ 消息五花八门、且**不带工作空间线索**，所以要模型同时判断两件事：①是不是真任务/闲聊/停止；②**该派给哪个工作区的单会话**。用宿主 `ctx.llm` 的模型调用（不新起会话、不养常驻 agent），要求**严格 JSON**；实现里用批处理（同一轮多条 QQ 消息一次判）+ 超时。
- 研判输入带**候选工作区清单**（`workspaceRegistry.list()` 的 id/path/name），输出示例：`{"verdict":"accept","reason":"…","workspace":"<id 或 path>","preset":"可选"}`。
- **只认候选清单里的工作区**：模型返回清单外的值一律丢弃（防幻觉），回退到确定性规则；无法判定 → 默认工作空间 + 面板提示，不丢活。
- **GitHub / 飞书 = 规则**（`'off'`）：标签/白名单已足够，零模型调用。
- 失败兜底：研判超时/报错/格式错 → **回退 accept**（宁可派错也别丢活），记 `lastError` 并在面板可见；连续失败给 QQ 源打退避。
- 配置：`sources.qq.assessment: 'agent'|'off'`、`sources.github.assessment`/`sources.feishu.assessment` 默认 `'off'`；`assessment.model` 可选（不填用宿主默认）。
- 成本：只有 QQ 且只在新消息批次上调用；面板显示「研判次数/忽略数」，超预算可在控制台关掉。

### 2.11 胶囊开关 + 工作区内顶置（v2.6）

- 控制台顶栏放一个**胶囊式开关**（pill switch，带滑块），直接绑定 `singleSession.enabled`；点一下就保存并重载，不用进设置页。
- 开启时：维护器确保每个工作区都有 `intake-<wid8>-<slug>` 单会话，并调用 `workspaceRegistry.pinSession(sessionId)` **把该会话顶置到所属工作区列表顶部**；已 pin 的重复调用无副作用。
- 关闭时：对本次 pin 过的会话调用 `unpinSession`，恢复原顺序；不删除会话。
- 顶置只影响工作区列表顺序，不改会话内容；失败记 lastError，不阻断其它工作区。

### 2.12 单会话的登记式生命周期（v2.7，取代 2.11 的自动建/自动 pin）

**D26（2026-11-24 用户定）**：

1. **不自动建**：关掉/废弃 autoCreate；单会话由用户在某个工作区**手动新建会话**。
2. **胶囊按钮**：全局单会话模式开启时，会话输入区**权限控件右侧**（slot `conversation.input.right`）出现胶囊按钮「超级智能体」。
3. **点亮即登记**：点亮后该会话登记为该工作区的单会话（`state.singleSessions[workspaceId] = sessionId`），并 `pinSession` 顶置。
4. **唯一性**：同一工作区已有登记的单会话时，该工作区其它会话**不再显示**这个胶囊。
5. **禁止入档/删除**：登记为单会话后，宿主侧 `archiveSession` 被拒（注册 `workspace/session-activity` 监听上报活动）；UI 的入档/删除操作失效。
6. **只能从控制台删**：控制台提供「解除单会话」——先注销登记（撤销活动上报）→ 再 `archiveSession`；这是唯一删除路径。
7. **控制台只列有登记的**：能发现 DSH 全部工作区，但只显示「已登记单会话」的那些；未登记的不显示。
8. 旧的 `intake-*` 自动建会话不再使用（不批量删除，避免误删用户内容）。

**实现要点**

| 层 | 改动 |
|---|---|
| host 状态 | `state.singleSessions: { [workspaceId]: sessionId }`；`singleSession.enabled` 仍是总开关 |
| host 接口 | `/status` 返回 `singleSessions`（仅已登记）；`/status?sessionId=` 返回该会话是否已登记 + 所属工作区是否已有单会话；`/action` 新增 `register-single` / `unregister-single` / `delete-single` |
| 禁止入档 | `ctx.on('workspace/session-activity')` 对已登记会话上报活动；`delete-single` 先注销再归档 |
| 客户端 | `conversation.input.right` 注册「超级智能体」胶囊；点亮=调 register；已登记且是当前会话=显示已点亮；同工作区已有别的单会话=不渲染 |
| 控制台 | 工作空间列表只渲染已登记的；每张卡加「解除单会话」（红色） |
| 移除 | maintainer 的 autoCreate 段；不再自动 pin 未登记会话 |

### 2.13 单会话 = 极简模式，插件只拼必要上下文（v2.9 / D28，取代 v2.8 / D27）

- **默认 preset = 宿主内置 `minimal`（极简模式）**：新增配置 `singleSession.preset`，默认 `'minimal'`。登记单会话时 `agentPresets.select(agent, singleSession.preset)` 切过去，原 preset 记到 `state.singleSessionPrevPreset[workspaceId]`；解除时会话活着就切回原 preset，不活只清记录。维护器 reconcile 每轮仍确保它停在该 preset（保持 v2.8 的"补切"行为）。
- **删除重 preset**：`cordis.patch.yml` 里 `dsh-superagent-yh-orchestrator-preset` 整行（order 91）删除；`config.orchestratorPreset` 删除；`lib/single-session.js` 不再引用它。理由：它存在的唯一依据是"worker 继承父 preset，所以父必须是 worker 的超集"，而这个依据已被宿主能力推翻（下一条），留着就是每轮白付 token。
- **worker 显式带 preset**：`lib/executor.js` 的 `runSubagent()` 在 `subagents.startActivation({...})` 里加 `agentPreset: config.workerPreset`。依据：宿主 `startActivation` 接受 `agentPreset`（asar 内实测 `startActivation({provider:'spawn', label, delivery:'caller', signal, childId, parent: agent, agentPreset: 'cordis', cwd, prompt, outputSchema})`）。于是父会话可以是极简模式，worker 仍拿得到 bash/fs/subagent 全套工具。
- **极简模式自带的能力正合用**：图片读取、自动历史压缩、空闲 `/compact`；维护器注册时要的 `compaction` 服务因此仍在（须探针实测，见 R39）。
- **单会话历史里只该有三种东西**：用户自己的话；relay 的开工/需人/完成三条短消息（每工单 ≤1K token 目标）；路由判定的一问一答。插件的 persona、工具 schema、长 mandate 都不再进单会话——它们随 preset 消失或只存在于 worker 会话内。
- **直接对话不再"派活"**：极简模式的单会话就是普通对话（自己答或说做不了）。派活只发生在外部工单进管线时，由 executor 直接 spawn worker 子智能体，不经单会话模型二次决策。若以后想要"对话里也能派活"，那是显式打开重 preset 的可选项，不进默认行为。
- **路由通道（D28 已拍板：选项 2）**：走 `ctx.llm` 一次性调用，复用 `lib/assessment.js` 的严格 JSON + 超时 + 回退 plumbing；不再用 `ctx.sessionController.prompt` 投 routePrompt。单会话历史只留 relay 短消息，路由问答不进用户会话。失败（超时/格式错/无 llm）回退 `rules` 并记 `lastError`，不静默。

## 3 里程碑

| 阶段 | 内容 | 退出条件 | 估时 |
|---|---|---|---|
| T0 | preset 切换与 `startActivation.agentPreset`（含探针：`select` 能否切内置 `minimal`、minimal 是否挂 `compaction`） | 探针输出两项均成立 | 0.25 天 |
| T1 | executor team 路径 + 结果解析 + 单测（stub subagents） | 单测覆盖激活/串行/dispose/解析 | 0.5 天 |
| T2 | `/status?sessionId=` 过滤 + tickets.mode | 路由实测 | 0.25 天 |
| T3 | TeamTaskBoard UI + 注册 slot | 客户端 smoke + 页面走查 | 0.5 天 |
| T4 | 集成验收：一条工单 → 会话内出现成员与任务 → 完成 → 任务板变绿、侧栏不新增会话 | 真实跑通 | 0.5 天 |
| T5 | **v2.9 落地**：`singleSession.preset='minimal'` + 删重 preset + worker 显式 `agentPreset` + orchestrator 走 `ctx.llm` + relay 投 `targetSessionId` | E12.17–E12.19 全绿，四路测试通过 | 0.5 天 |

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
| E12.11 | **三源同管线**：GitHub/飞书/QQ 的工单都进「工单所属工作空间的单会话」；单会话自己不算监听器；新增一个监听器不改执行侧 |
| E12.12 | **监听器不驻守会话**：只有脚本轮询，没有常驻 agent；目标单会话由 `resolveTarget` 在宿主侧确定 |
| E12.13 | **监管者按源**：QQ 默认走模型研判（严格 JSON、批处理、超时）；GitHub/飞书默认 `off` 零调用；研判失败回退 accept 且记 lastError |
| E12.14 | QQ 研判可用开关关闭（`sources.qq.assessment='off'`）；面板能看到研判次数/忽略数 |
| E12.15 | **QQ 研判同时选工作区**：输出 `workspace` 必须在候选清单内；清单外值被丢弃并回退；无法判定落默认工作空间且面板可见 |
| E12.16 | 确定性线索优先：GitHub/飞书（或 QQ 显式配置 workspace）不受模型选择影响 |
| E12.17 | **单会话默认极简**：未改配置时登记后该会话 preset = `minimal`（宿主 UI 显示「极简模式」）；解除后切回原 preset、不残留 |
| E12.18 | **worker 不继承父 preset**：子智能体激活参数里 `agentPreset = dsh-superagent-yh-worker`，其会话内 bash/fs 工具可用 |
| E12.19 | **单会话只增必要上下文**：一张工单跑完，单会话历史只增加 relay 短消息（+ 路由一问一答，若 D28 选 1）；无插件 persona / 工具 schema / 长 mandate 注入 |

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
| R37 | QQ 研判每批一次模型调用，可能贵/慢/误判 | 只对 QQ、批处理、超时短；失败回退 accept 不丢活；面板可见研判次数，可一键关；连续失败退避 |
| R39 | `agentPresets.select` 未必接受内置 id（`minimal`），或 minimal 未挂 `compaction`（维护器 239 行要它） | T0 探针先验；切不动就回落 `standard` 并明确报错，不静默；仍不行则改回内置切换机制前先问用户 |
| R40 | 极简模式没有 fs/bash，若哪天真把工单交给单会话自己干会干不了活 | executor 固定 spawn worker，父会话只做路由/汇总；E12.18 守住 |
| R38 | 模型选错工作区（幻觉路径/重名） | 只接受候选清单里的 id/path；清单外一律丢弃；无法判定落默认工作空间并记 lastError |

## 6 与已实现部分的关系

- **保留**：U1 压缩维护器、U2 `/status`/`settings`、U3 控制台四页签、独立页。
- **重构**：executor 变成一条三层管线（resolveTarget→route→spawnWorker→teardown→parseResult），四个源共用；旧顶层 worker 创建仅作 `singleSession.enabled=false` 回退。
- **新增**：任务板 UI、`/status?sessionId=` 过滤、结果解析、orchestrator 路由、worker preset 加回 subagent 工具。

## 7 待拍板

- **D14**：单会话开启时，工单改为**会话内子智能体**执行（推荐）；关闭时保持顶层 worker 会话。
- **D15**：任务板放在会话内 subagent 区（`conversation.session.header.actions.subagent.footer`），用**自己的** `SuperagentBoard` 组件（像团队、不照搬）。若想要别的位置，先说，我改 §2.4。
- **D16**（2026-11-24 追加）：**完工即卸载**——终态后 `dispose()` + `archiveSession(childId)`，任务板保留窗口默认最近 20 条。宿主成员菜单若留历史标记属宿主边界（R35），不擅自改。
- **D17**（2026-11-24 追加，恢复原版）：**三层角色** orchestrator/worker/subagent 为核心；**只有三个外部源是监听器**，监听后全部汇入同一管线，目标是「工单所属工作空间的那个单会话」；**单会话是目的地/orchestrator 驻地，不是源**；orchestrator 由该单会话 agent 承担（`orchestrator:'agent'|'rules'`，默认 'agent'），worker preset 加回 subagent 派生工具。
- **D18**（2026-11-24）：`子计划书-会话版.md`（`sources.session`）**作废**——会话是目的地，不需要把自己当任务源监听。
- **D19**（2026-11-24 拍板）：旧顶层 `worker-*` 路径**保留为回退开关**（`singleSession.enabled=false` 时才走），用于对照/排障；不删除。
- **D20**（2026-11-24 拍板）：**监管者（Eval Assessment）本期只留接口**——`lib/assessment.js` 默认 `accept`、零模型调用；`assessment:'off'|'agent'` 只实现 off，做不做以后再说（§2.10）。
- **D21**（2026-11-24 拍板）：**监听器=脚本轮询，不做会话驻守**；目标单会话由宿主 `resolveTarget` 确定性决定（§2.9）。
- **D22**（2026-11-24 用户指示）：**QQ 源启用模型研判**（`sources.qq.assessment='agent'`）——QQ 任务五花八门，需要模型判断；GitHub/飞书仍规则直通、零调用。
- **D23**（2026-11-24 用户指示）：QQ 研判**同时判断派给哪个工作区的单会话**；结果带 `workspace`，只认候选清单内的值（R38）。
- **D24**（2026-11-24 用户拍板）：**QQ 的 `confirmWrites` 默认开启**——结果直接发回原群/好友；回写仍受 `authors`/`allowedGroups` 收窄。发送时机保持现状（完成/需要人/失败各一条，开工不发）。
- **D25**（2026-11-24 用户指示）：单会话做成**胶囊式开关**；开启时每个工作区的接单会话 `pinSession` **顶置**，关闭时 `unpinSession` 恢复。
- **D26**（2026-11-24 用户定，v2.7 取代 D25 的自动建/自动 pin）：单会话改为**手动新建会话 + 权限右侧胶囊「超级智能体」登记**；登记后唯一、禁止入档删除、只能从控制台解除；控制台只列已登记的工作区（§2.12）。
- **D27**（2026-11-24 用户选 A，**已被 D28 取代**）：登记时切换到**调度者 preset**，让单会话在直接对话里也把任务派给子智能体；解除时切回原 preset（§2.13）。单会话 UI 的后续修改另立占位计划 `子计划书-单会话UI修改.md`（待做计划）。
- **D28**（2026-11-24 用户拍板，v2.9 定稿）：单会话**默认跑宿主极简模式**（`singleSession.preset='minimal'`），不再切重调度者 preset；删 `dsh-superagent-yh-orchestrator-preset` 与 `config.orchestratorPreset`；worker 由 `startActivation({agentPreset: config.workerPreset})` 显式指定；插件只向单会话拼接必要上下文（用户的话 + relay 三条短消息）。**路由已选选项 2**：`ctx.llm` 一次性调用判定，单会话内不留路由问答；超时/格式错回退 `rules` 并记 `lastError`。
- **D29**（2026-11-25 实现 D28 时发现的竞态，按 D28 意图直接补）：已登记单会话上必须稳定停在 `single.preset`。宿主 `agent-presets` 的座位可能把新建会话时暂存的默认 preset 在登记后 `apply` 到会话上（真机日志：登记切 `minimal` 成功，19 秒后 `agent-preset/selected=ptc`），而会话开首轮后 `select` 永远被拒（"This session has already started"）。插件订阅宿主 `agent-preset/selected`，对已登记会话纠回（空白会话才切、每次最多 3 次、已开始只记一次日志）。
- 已确认口径（2026-11-24）：**很像智能体团队，但不是完全一样**——借鉴表现形式，不复制其开关/组件/任务语义（§1.1）。
- **2026-11-24 用户拍板 D14–D23，本文件定稿（v2.5）**，按 T1→T4 执行；四路测试按迭代规则跑完再收口。
