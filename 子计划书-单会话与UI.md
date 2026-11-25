# 子计划书 · 单会话（会话内智能体团队）+ UI

> 版本：v2.12｜状态：**定稿（2026-11-25 用户拍板 A：直派子智能体纳管为工单，前提「必须是真工单」）**｜定稿日期：2026-11-25｜权威范围：单会话的会话内界面 + 控制台 UI + 后端守卫收口 + 直派子会话的纳管/清理；不改源协议、不改主线 relay
>
> 唯一权威。两份草案（`docs/草案-控制台重构-v0.1.md`、`docs/草案-单会话UI重构-v0.1.md`）并入本版后仅存档。版本槽：v2.10（纯调度 preset / D30）→ v2.11（会话内 UI）→ **v2.12（本版，直派子会话纳管）**。

## 1 继承与变更说明

**继承（不变）**：执行形态 = 纯调度 preset `dsh-superagent-yh-dispatcher`（D30），worker 由 `startActivation({agentPreset})` 显式指定；三源是监听器、单会话是目的地（D14/D17/D21-D23）；登记制 D26 第 1/2/3/4/5/7/8 条与「像智能体团队但不复制」边界（§1.1）；relay 三条短消息、完工即卸载、状态机、源协议、`/status` `/action` `/settings` 形状全不动。

**v2.11 改了什么**

1. UI 正文范围收窄：「单会话界面」= 被标记为单会话的那个会话自己的对话界面；其他会话不变；控制台/侧栏不进 UI 正文，控制台单独成章后置。
2. 标题固定 `<工作空间名称>超级智能体团队`（D32）。
3. 登记成功后输入区图标必须消失（D31，修缺陷）。
4. 后端守卫收口：dispatcher 收敛失败不再静默、钩子可测、pin 失败回滚（D37，附录 A）。
5. 任务板与服务端 `state.tickets` 加上限（D34）。

**v2.12 改了什么（D40）**

1. 直派子会话纳入工单语义：单会话用 `subagent` 工具派出的子会话不经过插件管线、宿主也不归档，越挂越多（实测 26 个）。现在由维护器对账：**判定为真工单的**登记进 `state.tickets`（`id=subagent:<子会话id>`，`source=subagent`，`kind=task`，`childSessionId`=子会话，`targetSessionId`=单会话，`workspaceId`=所属工作区）；跑完转 `done` 并 relay 一条「完成」。
2. 判定只认确定性信号（不猜）：子会话事件里有任意 `tool/call` → 真工单；否则首条任务 prompt ≥40 字符且（label 非占位 或 prompt ≥80）→ 真工单；「只回复 ok」这类回声 / prompt 太薄 / 空 → 噪音，不建工单。
3. 噪音与用过的子会话都在空闲 `singleSession.childIdleMinutes`（默认 2）后 `archiveSession(id,{stopActivity:true})` 归档；失败按 3 次 + 10 分钟窗口退避，写 `lastError`，不阻塞主流程。
4. 开关 `singleSession.adoptChildren`（默认 true）；已登记工作区状态里出现 `children:{adopted,cleaned,total}` 便于验收。

**正式修订记录（v2.10 原文 → v2.11）**

| # | v2.10 原文（定位） | v2.11 修订 | 原因 |
|---|---|---|---|
| R1 | §2.12 实现要点 D26-6（原第 194 行）：「控制台提供『解除单会话』——先注销登记→再 archiveSession；这是唯一删除路径」 | 唯一路径**保留**；按钮统一叫「删除单会话」；**不新增**「只解除、保留会话」；补 preset 恢复 best-effort 且失败可见（`state.singleSessionRestore` + `state.lastError`） | 删除即终结；两种语义并存会让人以为「解除」能保留会话 |
| R2 | §2.12「客户端」行（原第 205 行）：「已登记且是当前会话=显示已点亮；同工作区已有别的单会话=不渲染」 | 改为「**已登记=不渲染**（入口消失）；未启用/工作区被他人占用=不渲染」 | D31：残留可点图标是缺陷；「已点亮」与「不渲染」矛盾 |
| R3 | §2.4 / §2.7「任务板保留最近 20 条」 | 客户端：未终态全部 + 最近终态补足，总量 ≤20；服务端：只裁**已 relay** 的终态到最近 20 条，未终态与未 relay 不裁 | D34；未 relay 就裁会丢回写 |
| R4 | §2.13 旧注释「切到极简 preset（v2.9 / D28）」 | 订正为 dispatcher（D30） | 注释与代码不符 |
| R5 | v2.11 未涉及直派子会话 | 新增 D40：直派子会话纳管为工单 / 非工单空闲归档 | 实测 26 个子会话挂着没人清，用户拍板 A |
| R6 | 工单只来自源 | 工单可由单会话直派子会话生成（`source=subagent`） | 与 D14「worker=子智能体」对齐，避免两套执行语义 |

## 2 现状与证据

- **输入区图标** `client.js:296`：登记后只染 brand 色、仍显示，副标题「已登记；删除请到控制台」——缺陷。已有守卫：`!state.ok || enabled!==true` 不渲染（327）、`workspaceOccupied` 不渲染（328）。
- **任务板** `client.js:362`：5s 轮询 `/status?sessionId=`，取 `slice(-8)`，空则 `return null`。
- **控制台** `client.js:411` 起：四页签 overview/tickets/sources/settings；`autoCreate` 原在表单与 payload（M1 移除）；侧栏 `Icon` 自绘 SVG、未接 primitives。
- **服务端** `lib/single-session.js`：`register` 97-157（码 `not-enabled/workspace-occupied/started/no-agent/no-workspace/preset-failed`）、`pinSession` 失败只 log（假登记）、`unregister` 160-191（会话已开始只 log `preset restore skipped`）、`removeSingle` 194-206、`maintain` 290-334（失败写 `state.lastError`）。
- **dispatcher** `lib/dispatcher.js`：成功打 `dispatcher: hid N global tool(s)`；四类失败只 `ctx.logger.warn`，不写 `state.lastError`、不落插件日志。
- **钩子** `lib/index.js:117-125`：archive/pin 逻辑内联在 `child.on('workspace/session-activity')`，不可单测；`sessionController` 已在 `inject`（22 行）。
- **宿主事实**（asar 实测）：`rename` 内部 `resolveAgent` → `sessionTitle.rename`，返回 `{title: accepted.title}`；标题被 `cleanTitleText` 规范化并按 `maxTitleBytes` 截断；会话不 live 会失败。
- **工作树**：`git status` 已有 v2.11 主体实现（`client.js`、`lib/{dispatcher,index,single-session,store}.js`、两个测试已 M；新增 `lib/diagnostics.js`、`test/unit/client-dict.test.js`）。基线 `c5ac0ea`，**未 commit**。实施按第 7 章验收，已落地项只核对不重写。

## 3 目标 / 非目标

**目标**：G1 会话内界面（图标登记后消失、标题固定且自愈、任务板有上限）；G2 后端失败可见可测；G3 控制台给出分阶段方案（本批不做）；G4 发 0.8.1 补丁、文档口径一致。

**非目标**：不做控制台重构本身（第 6 章后置）；不收敛三套 5s 轮询（D35）；不改源协议/relay；不动 profile 白名单；不删旧 `intake-*`。

## 4 冲突裁决表（已定，不给选项）

| 议题 | 裁决 | 落点 |
|---|---|---|
| 任务板轮询 | 本批**不收敛**，三套 5s 保留，留给控制台 S2 | D35 / §6 |
| i18n 单一实现 | `DICT` 仍只在 `client.js`；新增 `test/unit/client-dict.test.js` 断言「`t('…')` 字面量集 ⊆ DICT 键集」，缺键即红 | M1 / §8 |
| 图标探测 | 已登记 `return null`；未启用、`workspaceOccupied` 同样不渲染；删 `pillOnTip` | D31 / §5.1 |
| 解除语义 | 唯一路径「先注销再 archive」；按钮「删除单会话」；不加「只解除」；preset 恢复 best-effort + 失败可见 | D33 / §5.5 |
| autoCreate | UI 移除；config 键保留并标 deprecated；已装 profile 不动（白名单不碰） | D36 / M1 |
| 任务板形态 | 位置 `conversation.session.header.actions.subagent.footer` 与形态不变，只修 a11y，点击仍开控制台；放控制台 S5 | D34/D36 |
| 版本号 | **0.8.1**（补丁级：修缺陷 + 单会话界面，不含控制台重构）；发布 `dist/dsh-superagent-yh-0.8.1.tgz` | D38 / M6 |
| 标题 | 登记成功后服务端 rename；canonical 存 `state.singleSessionTitles`；`maintain()` 每轮对账（≤60s 自愈）、冷会话不 resume；不做 `session/event` 即时纠偏；解除/删除不还原原标题 | D32 / §5.2 |
| 后端守卫 | dispatcher 失败必须 warn + `state.lastError` + 插件日志；钩子抽函数补单测；disposer 清理；pin 失败回滚 | D37 / 附录 A |
| 验收日志 | `dispatcher:` 行走 `ctx.logger`，**不在** `single-session.log`；验收看插件日志（`logs/dispatcher.log`）+ `header.tools` | D39 |
| 直派子会话 | 真工单纳管进 `state.tickets`（`source=subagent`）；噪音不建工单；两类空闲 2 分钟归档（`stopActivity:true`）；开关 `singleSession.adoptChildren` | D40 / §5.6 |
| 版本号 | **0.8.2**（补丁级：直派子会话纳管 + 清理）；发布 `dist/dsh-superagent-yh-0.8.2.tgz` | D40 / M7 |

## 5 单会话生命周期

### 5.1 登记

1. 图标条件：总开关开、本会话未登记、本工作区无他人登记。
2. 点亮 → `POST /action {action:'register-single'}` → `register`，成功顺序：写 `state.singleSessions[w]=sid` → `pinSession`（失败：删登记+unpin+抛 `pin-failed`）→ `selectPreset(single.preset)`（失败：删登记+unpin+抛 `preset-failed`）→ **rename 标题**（失败只记日志，不撤销登记）→ 存 `state.singleSessionTitles[w]` → `save()`。
3. 失败码可读文案（不用 `window.alert`）；`started` 必须给出「新建空白会话」指引。
4. 客户端下次轮询 `registered===true` → `return null`，图标消失。

### 5.2 标题（D32）

- 生成：`truncateUtf8(name, 59) + '超级智能体团队'`（后缀 21 字节，总 ≤80；按 UTF-8 字节截断，不切半个汉字）。
- 来源：`listWorkspaces()` 的 `title ?? name`，缺失回退空串（只剩后缀，不报错）。
- 存储/自愈：canonical 存 `state.singleSessionTitles[workspaceId]`；`maintain()` 对已登记且 agent 活着的会话，`view.title !== canonical` 则 rename 并 `log('single-session','title reconciled …')`；冷会话不 resume 不重写。
- 不监听 `session/event` 即时纠偏；解除/删除**不还原**原标题（删除即终结，无「只解除」入口）。

### 5.3 任务板（会话内）

取数 `GET /status?sessionId=` 的 `tickets`。显示：倒序后 `active` = 非 done/failed 全量（≤20），`finished` = done/failed 补足 `20 - active.length`；空则不渲染。行点击打开控制台（形态不变）。服务端 `state.tickets` 保留「未终态全部 + 最近 20 条已 relay 终态」，裁剪只在 relay 之后。

### 5.4 relay 展示

不变：三条短消息；会话历史仍只有「用户的话 + 三条 relay + 必要时路由判定」；不注入标题/任务板等额外文本。

### 5.5 解除/删除（D33）

控制台工作空间卡「删除单会话（红）」→ `delete-single` → `removeSingle`：`deleting.add` → `unregister`（删登记 → `unpinSession` → 恢复 `singleSessionPrevPreset`：会话活着重试 1 次，仍失败写 `state.singleSessionRestore[w]={ok:false,reason,at}` 与 `state.lastError`；会话不活记 `not-live`）→ `archiveSession` → `log` → `finally deleting.delete`。不还原标题、不重新 pin、不删旧 `intake-*`。

### 5.6 直派子会话（D40）

- 每轮 `maintain()` 对已登记单会话取 `sessionController.list()` 里 `parentSessionId === 单会话id && origin === 'subagent'` 的子会话。
- 去重：已被插件工单管线占用（`childSessionId` 已在别的工单里）的不重复纳管；已纳管的只做状态推进。
- 判定见 `lib/child-tickets.js:classifyChild`：`tool/call` 优先；回声正则 `/^(?:只|请)?(?:回复|回答|说|答)…(?:ok|好|收到)/i` 判噪音；prompt 阈值 40/80 字符。
- 归档：`workspaceRegistry.archiveSession(id,{stopActivity:true})`（跳过活动检查）；失败退避写 `state.lastError`；`state.singleSessionChildNoise` 记噪音判定避免重读事件。
- 已完成才被发现的子会话只登记成 `done`，**不补发 relay**（避免翻旧账刷屏）；正在跑的补一条 `started`。

## 6 控制台阶段（后置，本批不做）

照 D36：单文件分层 + 轮询收敛，四页签不增删。

| 步 | 内容 | 验收 |
|---|---|---|
| S0 | 基线：0.8.1 `npm pack` 存档、截图、`client-dict` 测试固化 | 包可装、测试绿 |
| S1 | `consoleStore`：status + `single:<sid>` 资源、订阅计数单定时器、single-flight、退避 5→10→20→30s、visibility 暂停、手动 refresh | 单测：退订/退避/隐藏即停 |
| S2 | 收敛三套轮询；任务板改本地 `filterTicketsForSession`（复刻 `lib/panel.js:132-139`），`?sessionId=` 保留兼容 | 请求数下降、过滤 parity |
| S3 | 视图拆分 `Overview/Tickets/Sources/SettingsView`，`Console` ≤250 行；常量/文案/CSS 分层 | 注册面不变、行数检查 |
| S4 | 视觉交互：`.syh-head` flex-wrap、窄栏隐藏「尝试/最后错误」列（错误进标题第二行）、表单 dirty 提示、空态 | 走查清单 |
| S5 | 任务板与按钮 a11y（role/tabIndex/Enter/aria-live，去 `alert/confirm`）；独立页冻结只读降级；允许只读 `__internals` 测试缝 | 四测 + 真机走查 |

## 7 分步实施 M0–M6

> 通用回滚：本批不 commit，回滚 = `git checkout -- <文件>`；`state.json` 新键由 `migrate()` 兼容，不手工改 state。

### M0 基线与核对（无代码）

记录 `git status` / `git log -1`，确认 §2 工作树状态；登记一次确认宿主 `rename` 可用（看 `single-session.log` 有标题写入或失败行）。
验收：`git status --porcelain -- dsh-superAgent-yh` 与 §2 一致；`node test/tools/verify-v210.mjs` 基线全 PASS（服务未起则记录跳过）。回滚：无。

### M1 图标消失 + i18n 收口（`client.js`）

改动：`SingleSessionPill` 加 `if (state?.registered === true) return null`；删 `pillOnTip` 与 `on` 染色/`disabled:on`；`autoCreate` 从 `buildForm`/`formPayload`/`settingsView` 移除并删 DICT 文案，`lib/config.js` 键保留 deprecated。
行为：登记后图标消失；未启用/被占用不渲染；设置页无 autoCreate。
验收：
```powershell
node --test test/unit/client-dict.test.js
Select-String -Path client.js -Pattern "pillOnTip|autoCreate"   # 期望 0 命中
```
回滚：`git checkout -- client.js`（会连带回滚 M3 的板改动）。

### M2 标题（`lib/single-session.js`、`lib/store.js`）

改动：`truncateUtf8` / `singleSessionTitle` / `TITLE_NAME_MAX_BYTES=59`；`api.renameSession` 默认 `ctx.sessionController.rename`；register 成功后 rename（失败只 log）；写 `state.singleSessionTitles`；`maintain` 对账（仅活 agent）；`store.js` 的 `emptyState`/`migrate` 补 `singleSessionTitles`、`singleSessionRestore`。
行为：登记后 ≤60s 标题为「<工作空间名>超级智能体团队」，被改回会自愈。
验收：
```powershell
node --test test/unit/single-session.test.js
node -e "import('./lib/single-session.js').then(m=>console.log(Buffer.byteLength(m.singleSessionTitle('工作空间'.repeat(20)))))"
```
期望 ≤80 字节且后缀完整；单测覆盖「活会话重写」「冷会话不写」「rename 失败不撤销登记」。回滚：`git checkout -- lib/single-session.js lib/store.js`。

### M3 任务板上限（`client.js` + 服务端裁剪）

改动：`SessionBoard` 按 5.3 拼 ≤20；新增 `pruneTickets(state,{keepTerminal:20})`（建议 `lib/ticket.js`，在 tick 尾部调用），只裁「done/failed 且 relay 完成」。
验收：
```powershell
node --test test/unit/ticket.test.js test/unit/executor.test.js
# 单测：25 终态 + 2 未终态 → 裁剪后 22 条，未终态与未 relay 均在
```
回滚：`git checkout -- client.js lib/ticket.js lib/index.js`。

### M4 后端守卫（附录 A）

改动：新增 `lib/diagnostics.js`；`dispatcher.js` 统一 `fail()` → `ctx.logger.warn` + sink；`index.js` 里 `ctx.effect(() => registerDiagnostics(...))` 写 `state.lastError` 与 `log('dispatcher', …)`；导出并使用 `guardSessionActivity`；`child.on` 返回值收进 `eventDisposers`、dispose 时 off；131 行注释订正；pin 失败回滚。
行为：任何「列不到工具/整批失败/逐个失败/deny 为空」都在 `state.lastError`、`/status`、`logs/dispatcher.log`、控制台错误框可见。
验收：
```powershell
node --test test/unit/dispatcher.test.js test/unit/single-session.test.js
# 断言：失败路径写 lastError；guardSessionActivity 三态
```
回滚：删 `lib/diagnostics.js` + `git checkout -- lib/dispatcher.js lib/index.js lib/single-session.js`。

### M5 解除语义（`lib/single-session.js`、`client.js`）

改动：`unregister` 的 preset 恢复 best-effort（重试 1 次 + `recordRestore`/`clearRestore`）；控制台按钮文案「删除单会话」，确认文案说明「当前会话不会被结束」。
验收：`node --test test/unit/single-session.test.js`；真机删一次 → 会话消失且日志有恢复或 `recordRestore` 证据。回滚：`git checkout -- lib/single-session.js client.js`。

### M6 版本与文档

改动：`package.json` version → `0.8.1`（只改该字段，exports 不动）；README 改写 v2.11 口径；两份草案头加存档行；`docs/M9-v2.10-报告.md` 第 54 行附近补日志说明。
验收：
```powershell
npm pack    # 出 dist/dsh-superagent-yh-0.8.1.tgz
node test/tools/verify-v210.mjs   # 版本断言改 0.8.1 后全 PASS
```
回滚：`git checkout -- package.json README.md docs/` 并删 tgz。

### M7 v2.12（0.8.2）：直派子会话纳管

改动：新增 `lib/child-tickets.js`；`lib/config.js` 加 `singleSession.adoptChildren`/`childIdleMinutes`；`lib/single-session.js` 加 `reconcileChildren`/`archiveChild` 并在 `maintain()` 调用；`lib/index.js` 把 `relay` 传进维护器；文档与版本 0.8.2。
验收（E12.22–E12.23）：
```powershell
node --test test/unit/child-tickets.test.js test/unit/single-session.test.js
node test/tools/verify-v210.mjs   # 版本断言改 0.8.2 后全 PASS
```
E12.22：真机重启后，既有 26 个子会话中的噪音与完成项在 ≤2 轮维护内被归档，`state.tickets` 出现 `subagent:*` 的真工单。
E12.23：新发一条任务 → 子会话被 `started` 汇报，完成后 `done` 汇报，其后被归档；主工单（源触发的）行为不变。

## 8 测试口径

| 轮次 | 验什么 | 证据 |
|---|---|---|
| 白盒 | 标题（59 字节边界/多字节/空名）、register 顺序与回滚、maintain 标题对账（活/冷）、裁剪（未终态/未 relay 不裁）、`guardSessionActivity` 三态、dispatcher 四类失败、DICT 键集、disposer 清理 | `node --test test/unit/` 全绿 |
| 黑盒 | `/status` 字段、`/single?sessionId=` 形状、`/action` 各分支错误码、`/settings` 白名单与 32KB、Origin 403、`version=0.8.1` | `test/tools/verify-v210.mjs`（改名 v211） |
| 真实使用 | 新建空白会话 → 点亮 → 图标消失 → 标题出现 → 发任务只派 subagent → 删单会话 → 会话消失 | 走查 + `single-session.log` / 插件日志 |
| 健壮性 | rename 抛错、sessionTitle 服务缺失、冷会话、state 缺新键、并发登记同工作区、个别工具隐藏失败、`/status` 500 | 单测 + 故障注入 |

**需人工真机验证（只剩这张清单）**

1. 登记后宿主 UI 的「入档/删除」是否真被 `workspace/session-activity` 挡住（D26-5 只能真机证）。
2. 侧栏/会话列表标题是否正确显示，长工作空间名是否 59 字节截断且后缀完整。
3. 发首轮消息后 LLM/宿主标题生成器是否不再覆盖标题。
4. 单会话 `header.tools` 是否只剩 `subagent`（无 `ops_bash`/`exp_recall`/shell/fs）。
5. worker 会话工具面不受影响（bash/fs 可用）。
6. 直派子会话：发任务后任务板出现 `subagent:*` 行；子会话结束后被归档（`single-session.log` 有 `archived child ... (idle)`）。

## 9 兼容与迁移

- `state.json`：新增 `singleSessionTitles`、`singleSessionRestore`、`singleSessionChildNoise`、`singleSessionChildArchive`，`migrate()`/`??=` 读时补齐；老 state 直接可用。
- 配置：`singleSession.autoCreate` 保留（deprecated，UI 不再读写）；已装 profile 的 `cordis.patch.yml` 不自动改。
- 旧 `intake-*`：不批量删除。
- 行为变化：登记后图标消失（可能找不到入口）→ 控制台/README 写明去控制台删除；无独立「解除」入口。
- `client.js` 改动必须**重启 DSH** 才加载；host 侧改动随插件重载生效。

## 10 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 宿主 `rename` 会规范化/截断（`cleanTitleText`、`maxTitleBytes`），返回的 `accepted.title` 可能 ≠ 传入值 | 若拿自算标题当 canonical，每轮对账都重写（rename 风暴） | canonical 以返回值为准；失败则保留原值只重写一次并记日志（M2 单测） |
| `rename` 要求会话 live | 冷会话调用直接失败 | `maintain` 只在有 `agent` 时重写；冷会话跳过 |
| 裁剪早于 relay | 已终态未回写的工单被删，结果丢失 | 只裁已 relay 终态，单测锁死 |
| pin 成功、preset 失败只 unpin | 假登记、占用工作区 | 顺序固定 pin→preset，两步失败都删登记+unpin，幂等 |
| 把噪音误纳成工单 | 任务板被测试回声刷屏 | 判定以 `tool/call` 优先，回声正则；`adoptChildren=false` 可整体关闭 |
| 子会话归档失败（宿主活动窗口） | 子会话清不掉、日志刷屏 | `stopActivity:true` + 3 次/10 分钟退避 + `lastError` 可见 |
| 图标消失被当成功能坏了 | 无处删除 | 控制台卡片/README 写明；`/status` 暴露登记状态 |
| 客户端改动未重启 | 看到旧图标/旧文案 | 验收前重启 DSH 并刷新页面 |

## 11 附录 A 后端守卫（前置 P0，本批就做）

| 失败路径 | 现状 | v2.11 要求 |
|---|---|---|
| `definitions()` 抛错 | 仅 warn | `fail('cannot list global tools: …')` → `state.lastError` + 插件日志 |
| 无全局工具（`denied.length===0`） | 仅 info「no global tool to hide」 | 降为 warn 并落状态，不静默 fail-open |
| 整批 `restrict` 失败 | warn 后逐个重试 | `fail('batch restrict failed …, retrying one by one')` |
| 逐个仍失败 | warn | `fail(..., 'error')`，列出失败名单与计数 |
| 跨 scope 拿不到 store/log | dispatcher 在 preset 子 scope | `lib/diagnostics.js` 模块级 sink；主插件 `ctx.effect(() => registerDiagnostics(...))` 注册 |
| archive/pin 钩子 | 内联匿名函数不可测 | 导出 `guardSessionActivity(maintainer, event, next)` 并单测（已登记→注入 turn；删除中/未登记→原样） |
| `child.on` disposer | 未保存/未调用 | `eventDisposers` 数组，dispose 时逐个 off |
| `pinSession` 失败 | 只 log，登记残留 | 删登记 + unpin + 抛 `pin-failed` |
| 旧注释 | 「极简 preset（v2.9 / D28）」 | 改为 dispatcher（D30） |

日志口径（D39）：`dispatcher:` 行走 `ctx.logger`（本版经 diagnostics 另落 `logs/dispatcher.log` 与 `state.lastError`），**不写** `single-session.log`；验收看插件日志 + `header.tools`。

## 12 附录 B 与 v2.10 差异条款清单

1. D26-6 / §2.12 原 194 行 → R1（唯一删除路径、删「只解除」、preset 恢复可见）。
2. §2.12 原 205 行客户端行 → R2（登记后不渲染）。
3. §2.4/§2.7 任务板窗口 → R3（≤20、未终态优先、服务端裁剪）。
4. D31 图标：登记后 `return null`，删「已点亮」文案。
5. D32 标题：`<工作空间名>超级智能体团队`，59+21 字节，登记写 + maintain 对账，不还原。
6. D33 解除：唯一路径 + preset best-effort + 失败可见。
7. D34 任务板：客户端 ≤20；服务端留最近 20 条已 relay 终态。
8. D35 轮询本批不收敛（留控制台 S2）。
9. D36 控制台后置：分层 + 收敛，四页签不变，autoCreate 仅 UI 移除，独立页只读降级。
10. D37 后端守卫见附录 A；D38 版本 0.8.1；D39 日志口径见附录 A 末。
11. §2.13 / D28-D30 执行形态不变（纯调度 preset）。
12. §5.6 / D40：直派子会话纳管（`source=subagent`），真工单才登记，噪音与用过的空闲 2 分钟归档。
13. D40 版本 0.8.2；开关 `singleSession.adoptChildren`、`singleSession.childIdleMinutes`。
12. 文档：本版唯一权威，两份草案归档。
