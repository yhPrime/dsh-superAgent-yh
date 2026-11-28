# M3 QQ 接入报告

> 状态：已实现（2026-11-24）｜依据：`子计划书-M3-QQ.md` v1.0（定稿 D9–D11）｜证据：`归档/过程/M3/`

## 1 交付

- `lib/source/qq.js`：两模式工厂（personal / official）
- `lib/source/qq/onebot-client.js`：移植 aurabot-qq（MIT）的 OneBot v11 客户端（保留版权头）
- `lib/source/qq/personal.js`：WS 收事件 → 队列 → Trigger；HTTP 回写
- `lib/source/qq/roost-host.js`：`roost-host/1` 的 SSE 事件流 + `POST /rpc` 客户端
- `lib/source/qq/official.js`：官方机器人消息 → Trigger；`msg.send` 回写（requestId/receivedAt）
- `lib/config.js`：QQ 两模式配置与 fail-closed 校验
- `lib/executor.js`：完成/需要人/失败时**回写来源会话**（`confirmWrites` 门控），主线 relay 不变
- 测试：`test/fakes/onebot-fake.mjs`、`test/fakes/roost-host-fake.mjs`、3 个 QQ 单测文件

## 2 四路测试（本轮）

| 路 | 覆盖 | 结果 |
|---|---|---|
| 白盒 | 配置校验、Trigger 规范化、@/白名单/群过滤、去重、队列上限、send 参数、capabilities、gap、401 | **56 条单测全绿** |
| 黑盒 | 假 OneBot：`send_group_msg`/`send_private_msg` 报文与鉴权；假 roost-host：SSE 帧、`system.capabilities`、`msg.send` 报文 | 通过（假服务日志见证据） |
| 真实使用模拟 | 个人号：群 @ 消息 → 工单 `qq:msg-9001` → worker 建 `qq.txt(M3-OK)` → done → 回写群；官方：SSE 消息 → 工单 `qq:msg-e1` → worker 建 `qq2.txt(M3-OFFICIAL)` → done → `msg.send` | 通过（两个完整闭环） |
| 健壮性 | 队列 1005 条只留 1000、重复 message_id 去重、`gap` 记错、token 错 401、能力缺 `msg.send` fail-closed、`confirmWrites=false` 拒绝回写、断线退避（代码路径） | 通过；真实断网未单独造 |

## 3 关键证据

- `归档/过程/M3/personal-state.json`：`qq:msg-9001 done`，relay 两条
- `归档/过程/M3/personal-onebot.log`：`WS event message_id=9001` + `POST /send_group_msg {"message":"【superagent】完成 ..."}`
- `归档/过程/M3/official-state.json`：`qq:msg-e1 done`
- `归档/过程/M3/official-roost.log`：`system.capabilities` + `msg.send`（含 `requestId`/`receivedAt`）
- `归档/过程/M3/qq.txt`、`qq2.txt`：worker 产物

## 4 限制

1. **真实 QQ 未验**：个人号需 SnowLuma + 小号；官方需 qq-bot-roost + AppID。两种都只用假服务跑过。
2. 官方模式回写不带 `msgId/eventId`（工单不存原始 id），可能走主动消息额度；要严格被动回复需把原始 id 存进 ticket（后续）。
3. 只发文本；媒体/语音/卡片未做。
4. qq-bot-roost 是 AGPL：我们只按协议调用，不打包其代码；用户自行安装。
5. 个人号网关属第三方 hook，有封号风险，文档已建议小号。

## 5 结论

E7.1–E7.6 在本地假服务范围内全部满足；真实环境验收挂在用户凭证/网关上。
