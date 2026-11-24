# 子计划书 · 单会话（会话内智能体团队）+ UI

> 版本：v2.0（**未定稿**，待拍板）｜状态：**未定稿**｜定稿日期：—（v1.1 曾是定稿）｜权威范围：单会话模式的「表现形式与执行形态」+ 控制台 UI。不改源协议、不改主线 relay。
>
> **为什么改回未定稿**：用户 2026-11-24 指出「单会话的表现不应该是这样，应该和智能体团队的表现形式相似」。v1.1 只做了「一个接单会话 + 上下文压缩」，但工单仍由**顶层 `worker-*` 会话**执行——它们会作为独立会话出现在侧栏里，完全不像智能体团队。v2.0 把执行改成**会话内子智能体**，并像 Agent Teams 一样在会话头渲染**任务板 + 成员**。

## 0 一句话

单会话 = **一个会话里的一支团队**：你只跟一个会话说话；每来一个工单，它作为这个会话的**子智能体**（subagent）去干，任务板显示在会话头（和 Agent Teams 同一个位置），干完结果回到这个会话。

## 1 现在为什么不"像团队"

| | v1.1 现状 | v2.0 目标（像 Agent Teams） |
|---|---|---|
| 执行体 | `sessionController.create('worker-<id>')` 顶层会话 | `subagents.startActivation({provider:'spawn', parent: 接单会话})` 子智能体 |
| 侧栏 | 每个工单多一条 `worker-*` 会话 | 侧栏**只有**那一个接单会话 |
| 会话内 | 看不到任何工单痕迹 | 会话头出现**任务板**（pending/in_progress/completed）与**成员列表** |
| 上下文 | worker 自己的会话上下文 | 子智能体各自上下文；父会话只留调用/结果（短） |
| 观察 | 要点进另一个会话 | 就在当前会话里看进度、点开任务 |

## 2 方案

### 2.1 触发条件

- `singleSession.enabled: true` → 工单走**会话内团队**路径（本计划）
- `singleSession.enabled: false` → 保持现有 `worker-*` 顶层会话路径（不动，向后兼容）

不新增第二个开关，避免「单会话开着却还是顶层会话」的混乱。

### 2.2 执行（替换 `lib/executor.js` 的会话创建段）

```
工单 queued
→ 确保该工单的 worktree（保留：每个工单一个独立目录，可回滚）
→ 取该工作空间接单会话的 live agent（agents.get / resolveAgent）
→ subagents.startActivation({
     provider: 'spawn',
     parent: agent,
     name: 'ticket-<短id>',
     label: <工单标题>,
     cwd: <worktree>,
     prompt: [mandate 文本],
     delivery: 'parent',
     signal,
   })
→ await activation.result
→ 解析结果（结构化输出或 ticket_report）
→ done/waiting/failed + 回写来源 + 面板
```

- **不再** `sessionController.create('worker-*')`，侧栏不再多会话。
- 子智能体同样受 `maxWorkers: 1` 串行约束（一次一个 activation）。
- 取消：`activation.dispose()`；超时同样先 dispose 再标 failed。
- 深度：父会话是普通会话，子智能体深度 1；子智能体自己再派子代理由宿主 depth 限制兜底。

### 2.3 回报

- 优先：给子智能体注册 `ticket_report`（在 `agent/created` 事件里按 childId 命中后注册到 child.ctx，结束即撤）。
- 兜底：mandate 要求最后一行 `[[ticket:done]] 摘要` / `[[ticket:waiting]] 问题` / `[[ticket:failed]] 原因`，主进程解析 `activation.result` 的最终文本。
- 两种都拿不到 → failed（原因写明），不静默。

### 2.4 任务板 UI（像 Agent Teams）

- 注册到 `conversation.session.header.actions.subagent.footer`（Agent Teams 的 `TeamBoard` 用的同一个 slot），只在**当前会话有该工作空间的工单**时显示。
- 数据：`GET /status?sessionId=<当前会话>` 返回该工作空间（按 session 的 cwd 匹配）的工单；client 在 slot 里按 5s 轮询。
- 行：状态点（pending/in_progress/completed/失败）＋工单标题＋来源；展开显示工单 id/错误/摘要；点「打开」跳到控制台工单页。
- 尺寸与样式跟随宿主（`--dsw-alias-*`），不引 UI 库；与 TeamBoard 视觉对齐但不复用其组件（避免依赖别的插件内部）。

### 2.5 控制台（保留并调整）

- 概览：工作空间卡保留；「工单」页签保留（全局视角）。
- 工单表「会话」按钮改为「在会话里看」→ 用 `uiWorkspace.openSession(接单会话 id)`。
- 单会话设置不变。

### 2.6 代码改动

| 文件 | 改动 |
|---|---|
| `lib/executor.js` | 新增 team 路径：subagents.startActivation + result 解析；原 worker 路径保留为 `singleSession.enabled=false` 分支 |
| `lib/single-session.js` | 暴露「取该工作空间接单会话的 live agent」给 executor（resolve agent + ensure 会话） |
| `lib/panel.js` | `/status` 支持 `?sessionId=` 过滤该工作空间工单；tickets 增加 `mode: 'team'|'worker'` |
| `client.js` | 新增 TeamTaskBoard 组件 + 注册 `conversation.session.header.actions.subagent.footer`；工单「会话」按钮跳转调整 |
| `test/unit/executor-team.test.js`（新） | 激活参数、串行、dispose、结果解析（工具/文本/无回报） |
| `test/unit/single-session.test.js` | 补「取 live agent」路径 |

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
| E12.1 | 单会话开启：工单执行**不**产生新的顶层会话（侧栏无 `worker-*`） |
| E12.2 | 工单执行时当前会话头出现任务板（pending→in_progress→completed）与成员 |
| E12.3 | 子智能体在独立 worktree 里干活，父会话上下文只增加调用/结果（短） |
| E12.4 | 完成/需要人/失败能落到任务板与工单状态；来源回写照旧 |
| E12.5 | 取消/超时能 dispose 子智能体，不残留运行中的成员 |
| E12.6 | 单会话关闭：现有 `worker-*` 路径行为不变（回归） |
| E12.7 | 现有 83 条单测全绿；新增 T1 单测全绿 |

## 5 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R30 | `subagents.startActivation` 是宿主内部服务，跨版本可能变 | 版本锁 `<0.3`；失败明确报错，不静默降级 |
| R31 | 子智能体结果解析不稳（模型不按格式） | 工具优先 + 文本兜底；都拿不到标 failed 并保留原文 |
| R32 | 父会话上下文仍会被调用记录撑大 | 继续用 U1 的压缩维护器；子智能体上下文独立 |
| R33 | 任务板 slot 与 Agent Teams 争同一位置 | 双方都在 `footer` list 里，按 order 排；我们只在有工单时渲染 |
| R34 | worktree 仍每工单一个，磁盘会涨 | 保留现状（可回滚优先）；后续可加清理策略，不在本期 |

## 6 与已实现部分的关系

- **保留**：U1 压缩维护器、U2 `/status`/`settings`、U3 控制台四页签、独立页。
- **替换**：executor 的 worker 会话创建段（改为 subagent 分支）。
- **新增**：任务板 UI、`/status?sessionId=` 过滤、结果解析。

## 7 待拍板

- **D14**：单会话开启时，工单改为**会话内子智能体**执行（推荐）；关闭时保持顶层 worker 会话。
- **D15**：任务板放在 `conversation.session.header.actions.subagent.footer`（与 Agent Teams 同位置，推荐）。
- 拍板后本文件改回 v2.0 定稿，我再改代码。