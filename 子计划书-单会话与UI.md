# 子计划书 · 单会话模式 + 控制台升级

> 版本：v1.1（定稿）｜状态：**定稿（2026-11-24 拍板 D13）**｜定稿日期：2026-11-24｜权威范围：①「单会话模式」（每个工作空间一个接单会话 + 旧上下文自动压缩）②控制台 UI 升级。不改源协议、不改 worker 执行器、不改主线 relay。
>
> v1.1 实施口径澄清：§3.3 独立网页是**服务端渲染**（宿主没有 React/SSR），无法与应用内 React 组件共享渲染代码；因此改为**共享同一份 `/status` 数据与同一套主题 token/样式变量**，不复用组件。用户可见范围不变。
>
> 依据：用户 2026-11-24 需求「控制台太简陋」+「每个工作空间理应只有一个会话，跟它说的话只有短期上下文，过时间就超级压缩或删除，避免上下文堆积的额外开销，控制台要有开关」。
> 已核实宿主能力（`cordis_inspect`）：`compaction.compactNow / compactIfNeeded / compactRegion`、`tokenMeter.contextPressure(session)`、`sessionController.state/list`、`workspaceRegistry.list/resolveByPath`、`agents.get`。**压缩复用宿主自己的 compaction 服务，不自写摘要逻辑。**

## 0 一句话

给插件加一个**单会话模式**开关：每个工作空间只留一个「你说话的接单会话」，空闲或上下文涨到阈值就自动把旧上下文压成摘要；同时把控制台从「一条长列表」升级成分页签的完整控制台。

## 1 拍板记录

- **D13（2026-11-24）**：「一个会话」**只收敛接单会话**（你说话的那个）。**worker 仍每工单独立会话 + 独立 worktree**，隔离与可回滚不变。
- 因此本计划**不动** `lib/executor.js` 的 worker 流程，只新增「接单会话维护器」。

## 2 单会话模式

### 2.1 配置

```yaml
singleSession:
  enabled: false          # 总开关（控制台设置页也有同一个开关）
  idleMinutes: 30         # 空闲多久后压缩
  pressureRatio: 0.5      # 上下文占用 / 窗口 超过此比例也压缩（不在跑时才压）
  aggressive: false       # true=用 compactRegion 把除最近若干轮外全部压成摘要（"超级压缩"）
  keepRecentTurns: 2      # aggressive 时保留最近几轮
  autoCreate: true        # 工作空间没有接单会话时自动建一个
  sessionIdPrefix: intake # 自动建会话的 id 前缀：intake-<工作空间slug>
```

校验：`idleMinutes ≥ 1`；`0 < pressureRatio ≤ 1`；`keepRecentTurns ≥ 0`；非法即 `ConfigError`（fail-closed，与其它配置同口径）。

### 2.2 接单会话怎么定

按工作空间（`workspaceRegistry.list()` 的每个 `path`）：

1. 若 `sources.session.enabled` 且其 `sessionId` 的 cwd 属于该工作空间 → **就用它**（不另建）；
2. 否则找 id 为 `intake-<slug>` 的会话（`sessionController.list()` 里按 cwd + id 匹配）；
3. 找不到且 `autoCreate: true` → `sessionController.create({ sessionId: 'intake-<slug>', cwd: <工作空间路径> })`；
4. `autoCreate: false` 且找不到 → 该工作空间标记「无接单会话」，面板提示，不报错不建。

`slug` = 工作空间路径去掉盘符与非法字符后的短哈希（保证同一目录稳定、不同目录不撞）。

### 2.3 压缩维护器（新文件 `lib/single-session.js`）

一个定时器（默认 60s，跟随 `pollIntervalMs`），对每个接单会话：

```
state = sessionController.state({sessionId})
若 state.running || queue 非空 || pendingInput 非空 → 跳过（绝不压正在跑的）
pressure = tokenMeter.contextPressure(agent.session)   // {pressureTokens, contextWindow}
idleFor = now - lastActivityAt                          // lastActivity 由 state.cursor 变化时记录
需要压缩 = (idleFor ≥ idleMinutes) || (pressureTokens / contextWindow ≥ pressureRatio)
若需要：
  aggressive ? compaction.compactRegion(起点, 终点, agent, signal)
             : compaction.compactNow(agent, signal)
  记录 { at, beforeTokens, afterTokens, mode } 到 state.singleSession[sessionId]
```

- `lastActivityAt`：维护器自己记（`state.cursor` 变了就刷新），重启后从 `sessionController.list()` 的 `updatedAt` 恢复。
- 压缩失败 → 记 `lastError`，面板可见，**不重试风暴**（下一轮再试）。
- 开关关闭 → 定时器停，不碰任何会话。

### 2.4 关于「删除」

宿主**没有**公开的「清空/截断会话历史」接口；官方机制就是 compaction（把旧区间换成摘要）。所以：

- **默认用压缩**（`compactNow`），`aggressive: true` 时用 `compactRegion` 做「超级压缩」——效果上旧上下文只剩一段摘要，等价于用户要的「压缩或删除」。
- **不做**「归档旧会话 + 新建」式硬删除：那会产生新 sessionId，与「只有一个会话」矛盾，且丢历史。若以后确实要，另开子计划拍板。

### 2.5 面板要显示的

每个工作空间一张卡：

- 工作空间路径 + 接单会话 id（可点「打开会话」）
- **上下文占用进度条**：`pressureTokens / contextWindow`，超阈值变色
- 上次压缩时间 + 压缩前后 token 数
- 状态：运行中 / 空闲 xx 分钟 / 无接单会话
- 按钮：**立即压缩**、**打开会话**
- 设置页：单会话开关 + idleMinutes + pressureRatio + aggressive + keepRecentTurns + autoCreate

## 3 控制台 UI 升级

### 3.1 结构（左栏主面板）

顶部工具条（标题 + 版本 + 运行状态灯 + 刷新 + 关闭）＋四个页签：

| 页签 | 内容 |
|---|---|
| **概览** | 三态统计卡（可点击跳工单页并过滤）；工作空间/接单会话卡（含上下文进度条、立即压缩）；源健康列表（ok/错误/水位/最近新增）；最近活动流（最近 10 条状态变化） |
| **工单** | 状态过滤 chips + 搜索框；表格加「来源」「形态」列；行内操作（重试/取消/会话/日志）；日志抽屉；空状态引导 |
| **源** | 每源一张卡（GitHub / 飞书 / QQ / 会话），卡头启用开关，字段分组，token 用「已配置」徽章 + 展开修改；底部 sticky 保存 |
| **设置** | 基础（dryRun / 主线会话 / repoPath / 轮询 / preset）＋**单会话模式**（开关与参数）＋提示区 |

右栏紧凑版：只保留「概览 + 工单」两页签，其余引导到左栏完整控制台。

### 3.2 视觉与交互

- 全部用宿主主题 token（`--dsw-alias-*`），暗色自动跟随；不引入任何 UI 库、不新增依赖。
- 统一圆角/间距/字号层级；状态色语义化（queued 警告色、running 品牌色、done 成功色、failed 错误色）。
- 加载骨架、可关闭错误横幅、按钮 hover/focus 可见、表格行 hover、空状态有下一步引导。
- 表单：分组 + 说明文字 + 校验错误就地提示；保存中禁用按钮并显示结果。
- 不写 DOM 到组件外、不读别的插件 DOM（遵循宿主 UI 规范）。

### 3.3 独立网页

`/dsh-superagent-yh` 保留为只读兜底，同步升级样式（同一套主题 token/样式变量）并展示单会话摘要；数据复用同一个 `/status`。实施口径：服务端渲染，不共享 React 组件（v1.1 澄清）。

## 4 接口改动

| 路由 | 改动 |
|---|---|
| `GET /status` | 增加 `singleSession`（配置 + 每会话运行态）、`workspaces[]`（路径/会话/pressure/contextWindow/lastCompact/running/idleMinutes） |
| `POST /action` | 新增 `action: 'compact'`（带 `sessionId`，Origin 校验；正在跑则 409） |
| `POST /settings` | 白名单加 `singleSession.*`；仍走 `normalizeConfig` 校验 |

## 5 代码改动清单

| 文件 | 改动 |
|---|---|
| `lib/config.js` | `singleSession` 默认值 + 校验 |
| `lib/single-session.js`（新） | 接单会话解析、维护定时器、压缩触发、运行态快照 |
| `lib/index.js` | 装配维护器；`superagent_status` 增加单会话信息 |
| `lib/panel.js` | `/status` 扩展、`/action` 加 compact、`/settings` 白名单、独立页升级 |
| `client.js` | 四页签重构 + 工作空间卡 + 单会话设置 + 视觉升级 |
| `test/unit/single-session.test.js`（新） | 触发判定（空闲/压力/正在跑不压）、会话解析、配置校验 |
| `test/unit/panel-settings.test.js` | 补 singleSession 合并与脱敏 |

## 6 里程碑

| 阶段 | 内容 | 退出条件 | 估时 |
|---|---|---|---|
| U1 | 配置 + 维护器（解析/触发/压缩/快照） | 单测：空闲触发、压力触发、运行中不压、开关关闭不动 | 0.5 天 |
| U2 | host 接口（status/workspaces、compact、settings） | 路由实测：200/409/400 | 0.5 天 |
| U3 | 控制台四页签 + 工作空间卡 + 单会话设置 | 客户端 smoke + 真实页面走查 | 1 天 |
| U4 | 独立页同步 + 集成验收 | 真实会话涨上下文 → 自动压缩 → token 下降可见 | 0.5 天 |

约 2.5–3 天。

## 7 验收（E11）

| 编号 | 判据 |
|---|---|
| E11.1 | 开关默认关；关闭时不创建、不压缩任何会话（现有行为零变化） |
| E11.2 | 开启后每个工作空间有且仅有一个接单会话（已配置 session 源则复用，不重复建） |
| E11.3 | 空闲超 `idleMinutes` 或占用超 `pressureRatio` → 自动压缩，面板显示前后 token 下降 |
| E11.4 | **正在跑/排队/等人输入时绝不压缩** |
| E11.5 | 「立即压缩」按钮可用；正在跑时返回 409 且原因可见 |
| E11.6 | `aggressive: true` 时旧上下文只剩摘要（保留最近 N 轮） |
| E11.7 | 控制台四页签可用，暗色跟随，无 console 报错；右栏紧凑版正常 |
| E11.8 | worker 每工单独立会话 + worktree **不变**；现有单测全绿 |

## 8 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R25 | 压缩本身要花一次模型调用 | 只在空闲/超阈值时压；面板显示压缩次数与前后 token，让用户看得见收益 |
| R26 | 压掉用户还想回看的内容 | 摘要保留在会话里（不是删除）；`keepRecentTurns` 可调；面板提示 |
| R27 | 误压正在进行的对话 | 三重判定（running/queue/pendingInput）+ compact 前再查一次 state |
| R28 | 自动建会话打扰用户 | `autoCreate` 可关；默认只在开启单会话模式后才建 |
| R29 | 多工作空间时定时器开销 | 单定时器遍历，跳过运行中；无接单会话的工作空间直接跳过 |

## 9 不做

- 不做硬删除历史（见 §2.4）。
- 不把 worker 合并进接单会话（D13 已定）。
- 不引入 UI 组件库、不做动画特效、不改宿主 preset 选择器。