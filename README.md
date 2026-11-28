# dsh-superAgent-yh 自制版

把官方 dsh-superagent 0.1.0（MIT）整体内置的 DSH 插件：请求变成工单，每个工单在自己的 DSH 会话和目录里执行，主会话只收通知与回执。来源可接 GitHub、飞书和 QQ。

- 包名：`dsh-superagent-yh`；显示名：**dsh-superAgent-yh 自制版**
- 宿主：DeepSeek Harness `>=0.2.2-rc.5 <0.3.0`；Node `^22.19` 或 `>=24`
- 与 v1 的区别：没有「单会话登记图标」和调度者 preset。主线是官方的主 Session（router preset），只负责通知、relay 和面板工具，不接单也不干活。

## 能力

- **工单生命周期**：Source → Trigger → Eval（gate + assessment 两层）→ Ticket → Assignment → Executor；Ticket 与 Assignment 各自结束，支持 hand-back、stop、retry。
- **每工单独立执行**：worker 会话 `worker-<id>` + Execution 设置里 prepare 命令给出的目录；主线每张工单只收开工、需要人、完成等短消息。
- **策略与授权**：Policy 版本化、保存历史、按来源的允许名单与准入表；订阅消息只作上下文，不授权；写操作永远要人明确请求。
- **可见可管**：面板六页签（Overview / Source / Trigger / Eval / Execution / Settings），Thread/Ticket 详情、设置历史、管理 API。
- **三个来源**：GitHub、飞书（可选）、QQ（OneBot v11 个人号 / roost-host 官方机器人）。

## 安装

```powershell
$dsh = "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd"   # 或已在 PATH 的 dsh
& $dsh plugin --profile <你的 profile> add C:\path\to\dsh-superAgent-yh
```

或在 DSH **插件**页用「添加插件」选择本地目录。装完重启宿主。

## 配置

插件行只必填 `stateDir`（数据库、锁、worker shim、工单目录所在的绝对路径）；其余都在面板 Settings 里改：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: dsh-superagent-yh
  config:
    stateDir: C:/path/to/state/superagent
```

飞书和 QQ 的监听插件默认关闭，用它们的来源时在两行上取消注释：

```yaml
- id: dsh-superagent-yh-feishu
  disabled: false
- id: dsh-superagent-yh-qq
  disabled: false
```

然后在面板 **Settings → Sources** 填账号/网关，在 **Policy** 的对应来源里加允许发单的人。

## QQ

支持两种通道，按 `mode` 二选一：

| 字段 | 说明 |
| --- | --- |
| `mode` | `onebot`（个人号，默认）或 `official`（roost-host 官方机器人） |
| `httpUrl` / `wsUrl` | OneBot v11 的 HTTP 与 WebSocket 地址，默认 `127.0.0.1:3000` |
| `httpToken` / `wsToken` | OneBot 的 token，可为空 |
| `selfId` | 机器人 QQ 号，群消息靠它判断是否 @ 了机器人 |
| `baseUrl` / `token` | `official` 模式的 roost-host 地址与 Bearer token |
| `chats` | `[{"chatId": "123456", "name": "团队群", "listen": "mentions"}]`；`listen` 为 `mentions`（默认）或 `all` |
| `directMessages` | 是否接私聊，默认 `true` |
| `otherChats` | 名单外群：`none`（默认）或 `mentions`（被 @ 时按显式请求收下） |

收单规则：名单内群按 `listen` 判断；私聊直接请求；名单外群只在 `otherChats: mentions` 且被 @ 时收下。工单回写到消息原来的群/私聊。机器人自己发的消息不会建单，除非它作为 `policy.sources.qq.bots` 里的 bot 产生 inferred candidate。

**只用 QQ 的安装**：在面板 Sources 里把 GitHub 来源关掉，部署检查就不再要求 repository 与 GitHub CLI；Execution 的 prepare 命令写不依赖 GitHub 的即可。

## 开发

```powershell
$node = "<运行时>\dependencies\node\bin\node.exe"
$pnpm = "<运行时>\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install
& $node $pnpm typecheck
& $node $pnpm test        # vitest，Windows 上跳过 POSIX-only 的 36 条
& $node $pnpm build       # tsdown，产物进 lib/（仓库里提交）
```

`src/` 是源码，`tests/` 是测试，`prompts/` 与 `skills/` 是内置 prompt 和技能，`docs/001–008` 是官方设计文档，`docs/009-重构报告.md` 是本轮重构的记录。

## 文档

- [SETUP.md](SETUP.md)：从零装到能用
- [docs/006-deployment.md](docs/006-deployment.md)：部署、来源账号、管理 API
- [docs/007-architecture.md](docs/007-architecture.md)：模块与测试
- [计划书-v2.0.md](计划书-v2.0.md)：本轮重构的范围、里程碑与验收

## 许可

MIT（见 [LICENSE](LICENSE)）。来源与第三方组件见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：官方 dsh-superagent 0.1.0（MIT）为本插件基线；OneBot v11 客户端按公开协议实现，参考 dsh-aurabot-qq（MIT）；roost-host/1 仅按公开协议实现，未复制 AGPL 代码。
