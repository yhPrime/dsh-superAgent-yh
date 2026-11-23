# QQ 源接入说明（预留）

> 状态：**未接入，fail-closed**｜实现：`lib/source/qq.js`｜计划依据：《计划书.md》§2、§4.3、§7 R7
>
> 2026-11-24 追加：QQ 两模式（OneBot v11 / roost-host v1）的接入方案见 [`子计划书-M3-QQ.md`](../子计划书-M3-QQ.md)（**草案，待拍板 D9–D11**）；本文件在实现落地前保持"未接入"事实。

## 1 现在是什么

- `sources.qq.enabled=true` 时**配置校验直接抛错**，插件不会启动一个"看起来正常但不干活"的 QQ 源。
- 两种模式都已留位：
  - `mode: official` —— 官方 QQ 机器人；
  - `mode: personal` —— QQ 号（个人号），等用户交付插件源码后移植。
- 一致性套件用 `createQqPlaceholder()` 对空实现跑：`poll/send/ack` 全部抛「QQ … 源未接入（fail-closed）」，**不许静默返回空数组**。

## 2 契约（与 GitHub/飞书相同）

```js
interface Source {
  kind: 'qq'
  capabilities: { write: boolean, comments: boolean, threads: boolean }
  poll(since): Promise<{ triggers: Trigger[], since: string|null }>
  send(thread, text): Promise<void>       // 无能力时抛 CapabilityError/SourceError
  ack(ticket): Promise<{ skipped?: boolean, reason?: string }>
}
```

`Trigger = { id, thread, actor, title, body, url, at, kind }`，`at` 必须是 ISO 时间；`since` 是调用方水位，源自己不存水位。

## 3 官方机器人模式（official）怎么接

1. 在 QQ 开放平台申请机器人，拿到 `appId` / `appSecret` / 事件回调或轮询凭据；
2. 新增 `sources.qq.botToken` 一类配置（沿用现有 `apiBase` 思路，便于假服务测试）；
3. 实现 `poll()`：把群消息/私聊消息规范化为 Trigger（`id` 用平台 message_id，`thread` 用 `chat:<id>`）；
4. 实现 `send()`：发消息；`ack()` 无 ack 语义时返回 `{skipped:true}`；
5. 补一致性测试（`test/unit/source-suite.test.js` 增加 case）。

## 4 个人号模式（personal）移植步骤

> 依据 D8：**用户后续提供插件源码，移植进本项目**，不是外部调用。

1. 先核 LICENSE 与用户协议；只移植**消息收发层**，不碰登录态存储、不绕过风控（R7）；
2. 把收发适配成上面的契约；
3. 在 `createQqSource()` 的 `personal` 分支返回真实实现（当前抛错的那一行替换掉）；
4. 配置校验：`personal` 模式不再抛「未接入」，改为校验必要凭据；
5. 补：一致性套件 case + 真实收发一条消息的集成记录；
6. 文档更新本节状态与凭据字段名。

## 5 为什么现在不做

微信渠道选型未定 → 本期整体不做（D7）。

QQ 两模式的实现方案已于 2026-11-24 定成子计划草案（`子计划书-M3-QQ.md`），**代码仍未动**：等 D9–D11 拍板并定稿后再开工，避免先写后改。
