# 草案：单会话模式界面 UI 重构

> 版本 v0.1｜状态：草案·未定稿｜权威范围：单会话模式下用户可见的界面与交互｜待拍板
>
> 日期：2026-11-25　　模块：`dsh-superAgent-yh` 0.8.0
> 上游：`docs/子计划书-单会话与UI.md` v2.10（§2.12 D26、§2.13 D28、D29、D30）
> 范围外：执行管线、工单协议、源适配、preset 内容、宿主本体。**本文件只出计划，不含实现。**

---

## 1. 现状

### 1.1 从「新建空白会话」到「单会话」的完整操作链

| # | 环节 | 控件与文案（现状） | 位置 | 别扭/歧义/易误操作 |
|---|---|---|---|---|
| 0 | 开启全局开关 | 控制台顶栏复选框，标签「单会话」，`title=单会话模式` 提示；设置页另有「启用单会话模式」 | `client.js:532-541`、`client.js:761-773` | 入口埋在控制台里。新用户不知道「要先开这个」，直接去点胶囊会失败（`not-enabled`）。 |
| 1 | 新建空白会话 | 宿主侧栏「新建会话」，插件零引导 | 宿主 `dsh-client-ui-sidebar` | 插件自己的空态文案只说「在某个工作区新建会话」（`client.js:39`），没有可点的下一步。 |
| 2 | 点亮登记 | 输入区右侧 24×24 **纯图标按钮**（无文字），`title` 三档；已登记时 `disabled`；失败 `window.alert` | `client.js:298-341`、`PILL_CSS client.js:280-286` | ① 全局开关关、工作区被占用、或 `/single` 请求失败时，胶囊**直接 `return null` 消失**（`client.js:329-330`），功能不可发现；② `busy` 只禁点，不换图标、无 loading；③ 成功后仅颜色变 brand-primary，无 toast；④ 已登记态是 `disabled`，点击毫无反馈，tooltip 却说「删除请到控制台」；⑤ 无工作区时仍可点，点了才 400。 |
| 3 | 登记校验 | 六类错误码：`not-enabled / workspace-occupied / started / no-agent / no-workspace / preset-failed`；`started` 文案要求「新建空白会话，先点亮图标，再发第一条消息」 | `lib/single-session.js:97-157`、错误映射 `lib/panel.js:395-412` | 前端把后端 message 原样 `alert`（`client.js:324`），无行动按钮；`started` 的指引在界面上没有对应入口。 |
| 4 | 登记后的会话内表现 | 只把图标染成 brand 色；会话标题靠 `pinSession` 顶置 | `client.js:284`、`lib/single-session.js:97-157` | 会话里没有持久标识（如「单会话·调度中」徽标），换页/滚动后只剩一个 24px 变色图标。 |
| 5 | 侧栏面板图标 | 自绘 16px 笑脸 SVG，注册 `sidebar.panellist`，`id=dsh-superagent-yh`、`order=26` | `client.js:806-813`、`client.js:842-848` | ① 宿主 `PanelRow` 只给插件 `size`（宽栏 16/收起 18）与 `active`，当前 `Icon({size=16})` **收了 size 却不用 active，也没换尺寸**；② 图标语义是「笑脸」，与「单会话/调度」无关；③ 未用宿主 primitives，线性风格与宿主图标不一致。宿主契约见 `…/dsh-client-ui-sidebar/lib/client.js:206-238`（`.panelRow` button + `.panelGlyph` span + `size: wide?16:18, active`）。 |
| 6 | 会话头任务板 | `SessionBoard` 挂 `conversation.session.header.actions.subagent.footer`，5s 轮询 `/status?sessionId=`；空 tickets **直接 `return null`** | `client.js:363-409`、注册 `client.js:851-857` | 未登记时整块空白，用户不知道这里将来会出现工单；已登记但无工单也无「暂无工单」占位；无 loading。 |
| 7 | 控制台工作区卡 | 每工作区一行：路径、会话、压缩时间、占用比；按钮「立即压缩」「删除」 | `client.js:566-592`、动作 `client.js:477-498` | ① **DICT 缺 `deleteSingle` / `deleteSingleConfirm` / `deleteSingleDone` 三个键**（`client.js:36-49` 全文无定义，`locale/zh.json` 只有 meta）→ 按钮、确认框、成功提示都会退化成键名；②「删除」实际是 `delete-single` = 先注销再归档（`lib/single-session.js:194-206`），用户以为只是关开关，**结果会话被归档**；③ 后端已有 `unregister-single`（`lib/panel.js:395-412`）却没有「解除但保留会话」的界面入口。 |
| 8 | 异常态 | `/single` 失败时 `state=null`，胶囊按「可点」渲染；点后才 `alert` | `client.js:303-311`、`client.js:329` | 异常被当成正常，先射后问；无重试、无降级说明。 |

### 1.2 与 UI 相关的未验项（沿用计划书与 M9 报告）

- E12.20（单会话工具面只剩调度）、E12.21（worker 工具面不受影响）：**待真机**。因此 UI 文案**不得**写「shell/fs 已隐藏」这类承诺。
- 任务板视觉走查：**待人工**（`项目信息.md` 标「待确认」）。
- 单会话真实压缩 U4：**未做**。会话内目前完全没有压缩反馈，只有控制台按钮态（`client.js:477-487`）。
- 轮询现状：胶囊 `/single`、任务板 `/status`、控制台 `/status` 三条独立 5s 轮询（`client.js:313-317`、`:363-409`、`:99-119`）。

---

## 2. 目标与非目标

**目标**

- G1 从「新建空白会话」到「已登记」的每一步都有可见的下一步，不靠读文档。
- G2 登记相关五态（未启用/未登记/登记中/已登记/被占用/异常）在界面上可区分：图标、tooltip、文案、可点性都不同。
- G3 侧栏图标符合宿主契约：优先 primitives、原样透传 `size`/`active`、只返回图标本体。
- G4 「解除单会话（保留会话）」与「删除会话（归档）」不再混为一个按钮；失败给可行动提示，不用 `alert`。
- G5 视觉与宿主一致，能复用 primitives 就不自造按钮、尺寸、颜色。

**非目标**

- 不改登记模型：仍必须「空白会话 + 输入区登记」，D26/D30 语义不动。
- 不碰 dispatcher / worker / preset 内容 / 工具限制 / 压缩算法。
- 不新增页面路由，不重做控制台信息架构（只动单会话相关块）。
- 不实现宿主未公开的「删除会话」接口（R35 仍在）。
- 不做独立暗色/移动端适配（沿用宿主 `--dsw-*` token）。

---

## 3. 选项

### A. 最小视觉修复

- **改什么**：只改 `client.js` 图标与胶囊（primitives 图标、size/active 透传、五态颜色、loading、补 DICT 键），`package.json` 加 primitives optional peer。
- **不改什么**：入口位置、空态、控制台按钮语义。
- **代价**：0.5 天。**风险**：低（纯前端）。
- **缺点**：可发现性没解决——开关关着/被占用时仍然看不见入口；「删除=归档」的误操作仍在。

### B. 显式入口 + 空态 + 按钮拆分（推荐）

- **改什么**：A 的全部，外加
  1. 胶囊不再因「未启用/被占用」消失，改为灰态/禁用态 + tooltip + 点击跳控制台；
  2. 输入区图标加「已登记」状态点，已登记点击给 toast 解释而不是静默；
  3. 任务板空态常驻一行（未登记 → 引导点亮；已登记无工单 → 「暂无工单」）；
  4. 控制台把「删除」拆成「解除单会话（保留会话）」与「删除会话（归档）」，补齐 DICT；
  5. `pillState()` 抽成纯函数便于单测。
- **改动面**：`client.js`、`package.json`、`test/unit/client-smoke.test.js`（+ 新增字典测试）；**不动** `lib/`、`cordis.patch.yml`。
- **代价**：1～1.5 天。**风险**：低～中——全部在前端；「胶囊改图标+状态点」属设计变更，需 P1/P2 拍板。

### C. 单会话总览（中心页）

- **改什么**：B 的全部，外加控制台/右栏「单会话总览」卡：跨工作区列出登记态、接单会话标题、压缩水位、一键跳转/解除；可能需要 `/single` 或 `/status` 增加只读字段。
- **改动面**：`client.js`、`lib/panel.js`、可能 `lib/single-session.js`（只读视图）+ 单测。
- **代价**：2～2.5 天。**风险**：中——接口面扩大；与 R35（宿主无公开删除接口）容易冲突；总览与现有控制台工作区卡信息重复。

### D. 改登记模型（不推荐）

自动建会话、允许非空白会话登记、或把登记搬到设置页。**改变产品语义**，超出 UI 重构范围，且与 D26 冲突。列出仅为完整性，不建议。

---

## 4. 推荐

**推荐 B。** 理由：

1. 病根是「状态不可见 + 危险动作混在一起」，不是「缺一个中心页」；B 正好各打一处，C 的信息在 B 之后再看是否需要。
2. B 只动 `client.js` 与测试，不碰 dispatcher/worker/协议，回滚面最小。
3. 侧栏图标契约是宿主硬约束，A 已覆盖；B 在其上补的入口与空态都是纯前端条件渲染，不需要新接口。
4. 「解除/删除拆分」后端已支持（`unregister-single` 与 `delete-single` 分开），B 不扩协议。

---

## 5. 交互状态机

状态由 `GET /single?sessionId=` 返回的 `{enabled, registered, workspaceOccupied, occupant, workspaceId}`（`lib/single-session.js:419-435`）加本地 `busy` 推导。建议落成纯函数 `pillState(state, busy)`。

| 态 | 判定 | 图标 | tooltip | 提示文案 | 可点 |
|---|---|---|---|---|---|
| 未启用 | `enabled=false` | 中性灰线性图标 | 「单会话未开启」 | 「去控制台开启单会话模式」 | 可点 → 打开面板（不提交） |
| 未登记 | `enabled && !registered && !workspaceOccupied` | 中性图标 | 「点亮：把本会话设为本工作区的单会话」 | 无 | 可点 → 登记中 |
| 登记中 | `busy=true` | 同图标 + 旋转/脉冲 | 「正在登记…」 | 行内「正在切换 preset，请稍候」 | 不可点 |
| 已登记 | `registered === true` | brand 色 + 右上角状态点 | 「本工作区单会话；到控制台可解除」 | 点击给 toast：「已登记，解除请到控制台」 | 按钮 disabled，但保留点击提示（`aria-disabled`） |
| 被占用 | `!registered && workspaceOccupied` | 灰 + 锁/斜线角标 | 「本工作区已有单会话：{occupantTitle}」 | 点击 → 打开控制台工作区卡 | 可点 → 只导航 |
| 已解除 | 上一次 `registered`，本次回落 | 中性图标 | 同「未登记」 | toast：「已解除，本会话可照常使用」 | 可点 → 登记 |
| 异常 | `/single` 非 2xx 或 `register` 失败 | 图标不消失，加感叹角标 | 错误摘要 | 行内错误条 + 「重试」；`started` 给「新建空白会话」按钮 | 可点 → 重试 |

补充：

- `started` 文案沿用 `lib/single-session.js:97-157` 的语义，但把「新建空白会话」做成可点入口，而不是只写在 alert 里。
- `preset-failed` 文案必须说明「已回滚登记，本会话未被修改」，避免用户以为半登记成功。
- 被占用的 `occupant` 目前只是 sessionId（`lib/single-session.js:425-431`）。要显示标题，二选一：**i)** 前端用已有 `/status` 快照的 `workspaces[].title` 反查（不改后端）；**ii)** `/single` 补一个只读 `occupantTitle`（1 行）。推荐 ii，列为拍板项 P9。
- 异常态不允许 `return null`：宁可显示灰态也不让功能凭空消失。

---

## 6. 分步实施

> 前置：本草案拍板定稿后才动代码。`client.js` 每次改动需**重启 DSH**；面板路由保持全小写。

| 步 | 改哪些文件 | 做什么 | 验收 |
|---|---|---|---|
| S0 | 本文件；`test/unit/client-dict.test.js`（新） | 定稿本草案；加「DICT 完整性」单测：扫 `client.js` 中 `t('…')` 的键，必须同时存在于 `DICT.zh` 与 `DICT.en` | 该测试先**红灯**抓出 `deleteSingle*` 三个缺失键；补齐后全绿。**可自动验** |
| S1 | `package.json`、`client.js:806-813`、`client.js:842-848` | 图标契约：`peerDependencies` 加 `@deepseek-ai/dsh-client-ui-primitives`（optional）；`Icon(props)` 透传 `size`/`active`，优先 `require` primitives 的 `IconChecklistOutlineRegular`，`try/catch` 回落自绘（viewBox 16、stroke currentColor、线宽 1.2）；不包 `<button>`、不写死 30×30、不加 margin | `client-smoke.test.js` 增断言：`Icon({size:18})` 输出宽高 18；树里无 `button`；有 `aria-hidden`。**可自动验**；宽栏/收起视觉 → **需人工走查** |
| S2 | `client.js:288-341`、`client.js:36-49` | 抽出 `pillState()`；五态渲染 + loading + 行内错误，去掉 `window.alert`；补 DICT 文案 | 单测遍历 7 个态断言类名/`disabled`/`aria-pressed`/tooltip 键；**可自动验**；视觉 → **需人工走查** |
| S3 | `client.js:329-332`、`client.js:318-328` | 删掉「未启用/被占用即 `return null`」；点击导航到 `ctx.layout.selectPanel(PANEL_ID)` | 单测断言两种态都渲染节点；**可自动验** |
| S4 | `client.js:363-409` | 任务板空态：未登记一行引导 + 已登记无工单「暂无工单」；保留 5s 轮询 | 单测断言空态文案键；视觉 → **需人工走查**（对应「任务板视觉走查」未验项） |
| S5 | `client.js:489-498`、`client.js:591-592`、`client.js:36-49` | 拆「解除单会话（保留会话）」→ `unregister-single`；「删除会话（归档）」→ `delete-single`；确认框写清后果；补齐三个键 | 字典测试全绿；单测断言两个按钮分别 POST 不同 action；**可自动验**；文案 → **需人工走查** |
| S6 | `client.js:99-119`、`:313-317`、`:363-409` | （可选，P8）三条 5s 轮询收敛为共享快照 | 网络面板只剩一种轮询；**需人工走查**（或加日志断言） |

每步一个 commit；只允许 `client.js` / `package.json` / `test/unit/*` / `locale/*`（locale 仅 meta，不动）范围内。

---

## 7. 与 dispatcher / worker 的边界

- UI **只**消费现有 HTTP：`GET /single`、`GET /status`；`POST /action` 的 `register-single` / `unregister-single` / `delete-single` / `compact`；`POST /settings` 只改 `singleSession.enabled`。
- UI **不**：写 preset、调 `selectPreset`、读工单协议、调 `ctx.tools.restrict`、改 `lib/dispatcher.js` 的 deny 集合。
- 工具面文案保持中性：E12.20/E12.21 真机通过前，不显示「已隐藏 shell/fs」之类的承诺。
- 单会话历史只留用户话 + relay 三条短消息（§2.13），属协议，UI 不增删消息。
- 压缩触发与判定仍在 `lib/single-session.js`（`maintain`/`compactManual`）；UI 只展示结果。

---

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| primitives 运行时不解析 | optional peer + `try/catch` 回落自绘；两条渲染路径都过单测 |
| 宿主 slot props 变更（`size`/`active`） | 只透传、不假设；缺省 `size=16`，`active` 不参与自绘颜色 |
| 已登记按钮从 `disabled` 改为可点，误触重复登记 | 点击只做 toast + 导航，**不**重复 POST；`disabled` + `aria-disabled` 双保险 |
| 「解除」被当成「删除」 | 两个按钮文案写清「保留会话」/「归档会话」；危险色只给删除 |
| 被占用态显示后占用信息泄露会话标题 | 只显示标题，不显示路径/内容；P9 若选 ii 则仅回 title |
| 轮询收敛引入状态不一致 | 本期可不做（P8）；保持现状也无不一致 |
| 回滚 | 每步独立 commit，仅前端；`git revert <commit>` 后重启 DSH 即恢复。不涉及 `lib/`、`cordis.patch.yml`、数据文件 |

---

## 9. 需用户拍板项

- **P1** 选哪个方案：**A / B（推荐）/ C / D**？
- **P2** 「工作区已被占用」时，其它会话的入口：**显示灰态+tooltip（推荐）** / 继续隐藏？
- **P3** 全局开关关闭时是否显示灰态入口：**显示，点击打开控制台（推荐）** / 继续隐藏？
- **P4** 已登记后点击图标：**给 toast 解释（推荐）** / 保持无反应？
- **P5** 控制台是否拆成「解除单会话（保留会话）」与「删除会话（归档）」：**拆（推荐）** / 维持一个按钮？
- **P6** 任务板是否常驻空态占位：**常驻（推荐）** / 维持空则隐藏？
- **P7** 侧栏图标选型：**primitives `IconChecklistOutlineRegular`（推荐，拿不到回落自绘）** / 自绘「调度」图标？
- **P8** 三条 5s 轮询是否本期收敛：**本期不做（推荐）** / 本期一起做？
- **P9** `/single` 是否补只读 `occupantTitle` 供 tooltip：**补（推荐，1 行）** / 前端用 `/status` 反查（不改后端）？
