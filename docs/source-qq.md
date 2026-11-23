# QQ 源接入说明

> 状态：**已实现（2026-11-24）**｜实现：`lib/source/qq.js` + `lib/source/qq/{personal,official,onebot-client,roost-host}.js`｜方案：`子计划书-M3-QQ.md` v1.0（定稿）
>
> 两种模式都只按公开协议写客户端：个人号走 OneBot v11，官方机器人走 `roost-host/1`。**不移植、不依赖 `dsh-roost` / `dsh-aurabot-qq` 本体**（它们收到消息会自己起会话回答，且 roost 是 AGPL）。

## 1 个人号（mode: personal）

```yaml
sources:
  qq:
    enabled: true
    mode: personal
    requireAt: true            # 群消息必须 @ 机器人
    authors: ["123456"]        # 可选：发送者 QQ 号白名单
    allowedGroups: []           # 可选：只接这些群
    confirmWrites: false        # 回写必须显式开
    personal:
      httpUrl: http://127.0.0.1:6700
      wsUrl: ws://127.0.0.1:6700
      httpToken: ""
      wsToken: ""
      selfId: "999999"          # 机器人自己的 QQ 号；requireAt 时必填
      snowLumaDir: ""           # 可选：C:/path/to/SnowLuma，只读它的 config/onebot.json
```

- 网关：SnowLuma / NapCat / LLOneBot / Lagrange 均可；`snowLumaDir` 只读 `config/onebot.json` 与 `config/onebot_<uin>.json`，不写、不碰登录态。
- 收：WS（Universal）事件 → 内存队列（上限 1000，超出丢最旧并记日志）→ `poll` 规范化。
- 发：HTTP `send_group_msg` / `send_private_msg`；超时按“不确定是否发出”处理，不重试（避免重复消息）。
- 去重：`message_id` 最近 2000 条；断线重连由客户端指数退避。
- 风险：个人号网关属于第三方 hook，有封号风险，建议只用小号。

## 2 官方机器人（mode: official）

```yaml
sources:
  qq:
    enabled: true
    mode: official
    requireAt: true            # 群消息必须 @ 机器人
    authors: []                 # 可选：发送者 openid / QQ 号白名单
    allowedGroups: []
    confirmWrites: false
    official:
      host: 127.0.0.1
      port: 6807                # qq-bot-roost 面板里「外接协议」的端口
      token: "<宿主协议令牌>"
      allowRemote: false        # 非回环地址必须显式 true
```

- 需要用户自己运行 [qq-bot-roost](https://github.com/roost-qq/qq-bot-roost)（官方机器人框架，AGPL；我们只按协议调用，不打包它的代码）。
- 收：`GET /events` SSE（断线用 `Last-Event-ID`/`since` 补发；`gap` 记错误不假装没丢）。
- 发：`POST /rpc` 调 `msg.send`，带 `kind/chatId/content/requestId/receivedAt`；能力表缺 `msg.send` 时 fail-closed。
- 鉴权：`Authorization: Bearer <token>`；空 token 拒绝启动。

## 3 共同行为

- 收到消息 → `Trigger{ id, thread, actor, title, body, at, kind }` → 现有工单/隔离执行/主线三条消息/面板。
- `thread`：`group:<groupId>` / `private:<userId>`（个人号）、`chat:<kind>:<chatId>`（官方）。
- 完成/需要人/失败会**回写来源会话**（`confirmWrites: true` 时），同时照旧发主线三条短消息。
- 默认 `dryRun`、每小时上限、冷却、脱敏、幂等全部沿用主插件。
- 缺配置/令牌/网关/能力 → 启动即明确报错（fail-closed），不静默降级。

## 4 已知限制

- 两种模式都只在**本地假服务**上跑过端到端（`test/fakes/onebot-fake.mjs`、`roost-host-fake.mjs`）；真实 QQ 环境未验（需要小号 + SnowLuma，或官方 AppID + qq-bot-roost）。
- 官方模式的 `msg.send` 不带 `msgId/eventId`（工单不保留原始 id），因此可能走主动消息额度；如需严格被动回复，后续把原始 `msgId/eventId` 存进 ticket。
- 媒体/图片/语音/卡片未做，只发文本。
- 微信不做（主计划 D7）。
