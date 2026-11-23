# 第三方来源与许可

本项目自身以 **MIT** 发布（见 `LICENSE`）。以下是设计或代码层面参考过的第三方项目，按许可要求列明：

## 1. dsh-superagent-prototype（MIT）

- 仓库：https://github.com/deepseek-ai/deepseek-harness （`apps/` 之外的官方 superagent 原型；本地副本 `C:\Users\yh\Documents\GitHub\dsh-superagent-prototype`）
- 版权：DeepSeek Harness Team
- 用途：工单 / 会话隔离 / 源契约 / 执行器流程的设计参考；本项目是独立重写，未整段复制其 TypeScript 代码。

## 2. dsh-aurabot-qq（MIT）

- 仓库：https://github.com/aureth-labs/dsh-aurabot-qq
- 版权：Aurabot authors
- 用途：`lib/source/qq/onebot-client.js` 移植自其 `src/onebot/client.js`（OneBot v11 的 HTTP/WS 客户端、重连与重试语义），文件头保留原版权与来源说明；本项目只做了裁剪与适配。

## 3. dsh-roost / qq-bot-roost（AGPL-3.0，仅协议参考）

- 仓库：https://github.com/roost-qq/dsh-roost 、https://github.com/roost-qq/qq-bot-roost
- 用途：**只按公开文档实现 `roost-host/1` 协议客户端**（SSE 事件流 + `POST /rpc`），未复制其代码。
- 说明：qq-bot-roost 由用户自行安装运行；本项目不打包、不分发其代码，因此本项目保持 MIT（协议文档本身不构成代码衍生）。

## 4. 外部运行时（不随本项目分发）

- SnowLuma / NapCat / LLOneBot / Lagrange：个人号 OneBot v11 网关，用户自行安装。
- DeepSeek Harness：宿主，用户自行安装。
