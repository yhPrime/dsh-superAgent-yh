# 子计划书 · M3 QQ 接入

> 版本：v1.0（定稿）｜状态：**定稿（2026-11-24 拍板 D9–D11）**｜定稿日期：2026-11-24｜权威范围：仅本项目 QQ 源（官方机器人 / QQ 号两模式）的接入目标、方案、里程碑与验收；不覆盖 GitHub/飞书，不改主计划书已拍板的 D1–D8。
>
> 依据：主计划书 v1.0 §4.3/§5 M3+/§7 R7；2026-11-24 调研 `roost-qq/dsh-roost`、`aureth-labs/dsh-aurabot-qq`、`roost-qq/qq-bot-roost`（后者的 `docs/宿主协议v1.md`）。调研只读，未安装任何插件、未改用户 QQ 环境。

## 0 一句话

用**协议客户端**而不是搬别人的 bot 代码：QQ 号走 OneBot v11（复用 aurabot-qq 的 MIT 客户端），官方机器人走 `roost-host/1`（qq-bot-roost 的公开宿主协议）；两种模式都只把消息接进本插件的 `Source` 契约，复用已有的工单/隔离执行/relay/面板。

## 1 调研结论（决定方案的事实）

| 仓库 | 许可 | 它是什么 | 对本项目意味着什么 |
|---|---|---|---|
| `roost-qq/dsh-roost` | **AGPL-3.0-only** | 完整的 QQ 陪伴 bot 插件：官方接口 + 自有 agent + 人格/记忆/面板 | 不能当传输层用：它收到 QQ 消息会自己起会话回答；对外的 `/v1` 扩展 API 只能**发**不能**收**；代码一旦移植，本项目需整体 AGPL。**不移植、不依赖** |
| `aureth-labs/dsh-aurabot-qq` | **MIT** | 完整 QQ 陪伴 bot 插件，经 SnowLuma/OneBot v11 接个人号 | 同样会抢答，不能直接跑；但它的 `src/onebot/client.js`（HTTP + WS、自动重连）**可移植**（保留版权） |
| `roost-qq/qq-bot-roost` | **AGPL-3.0-only** | 零依赖 QQ 官方机器人框架，公开 `roost-host/1` 宿主协议（WS + `/rpc` + `/events`） | 用户自行安装运行；我们**按协议写客户端**（不抄代码），即可收发官方机器人消息 |

关键协议事实（写进实现依据，来自 `docs/宿主协议v1.md`）：

- 传输：`ws://host:port/`（主通道，`hello`/`welcome`/`event`/`req`/`res`）+ `POST /rpc`（同方法表）+ `GET /events`（SSE 兜底）+ `GET /health`；鉴权 `Authorization: Bearer <token>`。
- 收：`message` 事件含 `chat.kind`（group/c2c/guild/dm）、`chat.chatId`、`sender.openid`、`content`、`msgId`、`eventId`、`at`、`addressed`/`mentioned`、`mentions`。
- 发：`msg.send`，参数 `kind`/`chatId`/`content`/`msgId`/`eventId`/`receivedAt`/`requestId`；框架自带限速、主动额度、被动窗口、审核与投递账本（`requestId` 幂等）。
- 能力以 `system.capabilities` 运行时返回为准；协议版本在 `welcome.protocol`。

OneBot v11（个人号）：

- 发：`POST {httpUrl}/{action}`，`authorization: Bearer {token}`；`send_group_msg` / `send_private_msg` / `get_login_info`。
- 收：WS 正向/反向连接收 `post_type=message` 事件（`message_type`、`raw_message`、`message` 段、`sender.user_id`、`group_id`、`message_id`、`time`）；用于 @ 判定的是 `message` 里的 `{type:'at'}` 段。
- 网关：SnowLuma（README 推荐）/ NapCat / LLOneBot / Lagrange 均可；端点可从 SnowLuma `config/onebot.json`、`config/onebot_<uin>.json` 读取（`httpServers[]`/`wsServers[]` 的 host/port/path/accessToken），也可手填。

## 2 目标与不做

**做**：

1. `sources.qq` 两个模式：`personal`（OneBot v11）、`official`（roost-host/1）；
2. 收到符合条件的消息 → 规范化 Trigger（`qq:<msgId>` 或 `qq:<eventId>`）→ 走现有工单/隔离执行/relay/面板；
3. 完成/需要人/失败时回写到原会话（群/私聊），`confirmWrites` 门控；
4. 默认 `dryRun`、作者白名单、@ 触发、群/私聊开关、每小时上限（沿用 M4）；
5. 两种模式都 fail-closed：缺 token/端点/preset/协议版本不符 → 明确报错，不静默降级。

**不做**：

- 不移植、不安装、不依赖 `dsh-roost` / `dsh-aurabot-qq`（两个都是完整 bot，会抢答）；
- 不实现人格/记忆/情绪/主动搭话（那是 roost/aurabot 的职责，不是本插件的）；
- 不碰 QQ 登录态、不绕过风控、不读取 SnowLuma 的账号数据（只读它的本地 OneBot 端点配置，可选手填）；
- 微信不做（主计划 D7）。

## 3 方案

### 3.1 契约扩展（QQ 两模式共用一个 Source）

```js
interface Source {
  kind: 'qq'
  mode: 'personal' | 'official'
  capabilities: { write: true, comments: false, threads: true }
  poll(since): Promise<{ triggers: Trigger[], since }>   // 从本地事件队列 drain，不自己定水位
  send(thread, text): Promise<Receipt>                    // thread = '<kind>:<chatId>'
  ack(ticket): Promise<{ skipped?: true, reason?: string }>
}
```

- `poll` 的水位仍是调用方（index）传；QQ 侧另有自己的游标（OneBot 消息 `time/message_id`、roost `seq`），用于断线补发，不与插件水位混用。
- 事件先入内存环形队列（上限 1000，超出丢最旧并记 `lastError`），`poll` 只 drain；这样 WS 推送与现有轮询调度兼容。
- `thread` 统一编码：`group:<chatId>` / `private:<userId>`；回写按前缀分发。

### 3.2 personal 模式（OneBot v11）

- 新文件 `lib/source/qq/onebot-client.js`：**移植** aurabot-qq `src/onebot/client.js`（MIT，文件头保留版权与来源），只保留：连接、鉴权、echo 配对、WS 重连退避、`call(action, params)`；去掉 aurabot 的业务策略。
- `lib/source/qq/personal.js`：`poll` 把队列里的 `message` 事件规范化为 Trigger；过滤：仅 `message_type=group|private`、`sender.user_id` 白名单、群消息必须 @ 机器人（`selfId`）、忽略自己发的、`time > since`。
- 配置来源：显式 `httpUrl/wsUrl/httpToken/wsToken/selfId` 优先；`snowLumaDir` 可选时读其配置（只读，不写）。
- 重连期间消息不丢：WS 断线后按 `message_id` 去重；不确定的发送错误（超时）不重试（参考 aurabot 的 `uncertain` 语义）。

### 3.3 official 模式（roost-host/1）

> 定稿修订（2026-11-24）：传输采用协议文档里的 **SSE（`GET /events`）+ `POST /rpc`**，不实现 WS 帧握手。理由：语义相同（同一方法表、同一事件流、断线用 `Last-Event-ID`/`since` 补发），代码量约为 WS 客户端的 1/2，符合「最简洁的最优解」；WS 作为后续可选优化，不阻塞验收。

- 新文件 `lib/source/qq/roost-host.js`：SSE 客户端（`GET /events?since=`，`Authorization: Bearer`，断线指数退避，`gap` 记错误）+ `POST /rpc` 调用器（`{id, method, params}` → `{ok,data|error}`）。
- `lib/source/qq/official.js`：
  - 收：`message` 帧 → Trigger（`id=eventId`，`thread=chat:<kind>:<chatId>`，`body=content`，`actor=sender.openid`）。
  - 发：`msg.send`，带 `kind/chatId/content/msgId/eventId/receivedAt/requestId`（`receivedAt` 用事件的 `at`，避免被动窗口失效；`requestId` 用 ticket id 保证幂等）。
  - 能力探测：启动/首次 poll 调 `system.capabilities`，缺 `msg.send`/`message` scope 就 fail-closed 报「宿主协议不满足」。
  - `gap` 事件：记 `lastError` 并重新连接，不假装没丢。
- 不实现 QQ 官方 API 直连（需要 AppID/Secret + 公网回调/网关，重复框架已做的事）；也不抄 qq-bot-roost 代码（AGPL）。

### 3.4 配置（在现有 `sources.qq` 上扩展）

```yaml
sources:
  qq:
    enabled: true
    mode: personal            # personal | official
    requireAt: true           # 群消息必须 @ 机器人
    allowedGroups: []          # 空=全部（仍需 @）
    authors: []                # 发送者白名单（QQ号或 openid）
    confirmWrites: false       # 回写必须显式开
    personal:
      httpUrl: http://127.0.0.1:6700
      wsUrl: ws://127.0.0.1:6700
      httpToken: ""
      wsToken: ""
      selfId: ""
      snowLumaDir: ""          # 可选：自动读 onebot 配置
    official:
      host: 127.0.0.1
      port: 6807
      token: ""                # 必填；空=拒绝启动
      allowRemote: false
```

校验（fail-closed）：`mode` 只能是两值；personal 至少 `httpUrl` 或 `wsUrl`；official 必须 token；`enabled=true` 但缺配置 → 启动即报 ConfigError（沿用 M3 空实现的行为，文案指向本文档）。

## 4 里程碑与估时

| 阶段 | 内容 | 退出条件 | 估时 |
|---|---|---|---|
| M3.1 契约与骨架 | 本子计划定稿；`qq.js` 两模式工厂、配置校验、事件队列、假 OneBot/假宿主测试工具 | 单测覆盖配置/队列/规范化；两个假服务能跑 | 0.5 天 |
| M3.2 personal | 移植 OneBot 客户端 + personal 源 + 假 OneBot 端到端（消息→工单→worker→回写） | 假 OneBot 跑通 done/waiting；断线重连不丢不重 | 1–1.5 天 |
| M3.3 official | roost-host 客户端 + official 源 + 假宿主端到端 | 假宿主跑通 done/waiting；capabilities 不符 fail-closed | 1–1.5 天 |
| M3.4 真实联调 | 用户环境：SnowLuma + QQ 小号；qq-bot-roost + 官方机器人 | 各收 1 条真实消息、回写 1 条；证据留档 | 0.5–1 天（需用户环境） |
| M3.5 测试收口 | 四路测试（白盒/黑盒/真实模拟/健壮性）+ `docs/source-qq.md` 更新 + 打包 | 四路全绿；包内包含新源与文档 | 0.5–1 天 |

合计约 3.5–5 天（不含等待用户凭证/网关）。

## 5 测试计划（沿用主计划 §6 四路）

- 白盒：配置校验、事件队列上限/去重、Trigger 规范化、@ 过滤、白名单、`thread` 编解码、协议帧解析（hello/welcome/event/gap/res）。
- 黑盒：两个假服务（OneBot HTTP+WS、roost-host WS+RPC）跑完整闭环；token 错误/scope 不足/协议版本不符/端口不通的报错文案；`confirmWrites=false` 时 send 拒绝。
- 真实使用模拟：假服务上跑群 @、私聊、重复消息、worker 不回报、需要人；真实环境留 M3.4。
- 健壮性：WS 断线重连、`gap` 补发、消息洪峰（队列上限）、超长正文（20K 截断）、单源挂起不影响 GitHub/飞书、宿主重启后水位/队列恢复。

## 6 风险与回退

| 编号 | 风险 | 处置 |
|---|---|---|
| R7 | roost/qq-bot-roost 是 AGPL | **不抄代码**，只按公开协议写客户端；本项目保持 MIT。若用户要求移植 roost 代码，需先接受 AGPL 传染 |
| R8 | QQ 号网关封号/风控 | 只建议小号；不碰登录态；不做批量/自动加好友；失败只报错不重试风暴 |
| R9 | 宿主协议/OneBot 变体差异 | 以 `system.capabilities` / `get_version_info` 探测；不支持就 fail-closed，并在面板写原因 |
| R10 | 两个 bot 同时在线抢答 | 明确：本插件只接工单，不跑人格；用户若同时装 roost/aurabot，建议给它们单独的小号或关闭其自动回复 |
| R11 | 私聊/群消息含敏感内容 | 沿用 `redact()`；面板/日志只留摘要；默认 dryRun |

## 7 验收（E7）

| 编号 | 判据 |
|---|---|
| E7.1 | personal：假 OneBot 下，群 @ 消息 ≤1 个轮询周期建工单；worker 完成回写原群；重复消息不重复建单 |
| E7.2 | official：假 roost-host 下同样闭环；`msg.send` 带 `receivedAt`/`requestId` |
| E7.3 | 两种模式默认 dryRun；未配置/令牌缺失/能力不足时启用即明确报错（fail-closed） |
| E7.4 | 群/私聊、@、白名单、`confirmWrites` 四个开关按配置生效 |
| E7.5 | 断线重连后不丢消息（补发）且不重复派工（幂等） |
| E7.6 | 四路测试全绿；`docs/source-qq.md` 与 README 更新；打包后可安装 |

## 8 已拍板（2026-11-24）

- **D9**：官方机器人按 **`roost-host/1` 协议写客户端**（SSE + `/rpc`，不移植 AGPL 代码，不自己重写 QQ 官方 API）。
- **D10**：个人号以 **SnowLuma 为主**（可自动读本地 OneBot 端点配置），**手填兜底**。
- **D11**：QQ 两模式**并入本插件**（一个 `Source` 两个 mode），不拆独立包。

本文件自本条起状态为「定稿」；后续按 §4 里程碑开工。改动方案须在本文件先改版本与状态再动代码。
