# dsh-superAgent-yh 自制版

把「每个工单在独立会话、独立目录里干活，人只在一条主线里收结果」做成一个可安装的 DSH 插件：
不 checkout 源码、不手改 profile、不跑外部 setup。

- 包名：`dsh-superagent-yh`（npm 不允许大写）；显示名：**dsh-superAgent-yh 自制版**
- 宿主：DeepSeek Harness `>=0.2.2-rc.5 <0.3.0`
- 来源：GitHub、飞书（插件内直连 HTTP）；QQ 个人号（OneBot v11）与官方机器人（roost-host/1）；微信本期不做

## 能力

- **配置即可用**：一个插件行 + 默认 `dryRun=true`（只记录不干活）
- **自动建工单**：任一启用源出现符合条件的动态 → 一个轮询周期内建 Ticket
- **隔离执行**：`worker-<ticketId>` 独立会话 + `workRoot/<ticketId>` 独立 git worktree
- **主线三条短消息**：开工 1 条、需要人 1 条（含问题）、完成 1 条（含链接/摘要）
- **幂等**：ticket id 去重 + 水位推进 + 跨重启保留状态
- **可见**：面板 `/dsh-superagent-yh`（三态 + 最后错误 + 按源分组）与只读工具 `superagent_status`

## 安装

```powershell
$dsh = "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd"   # 或已加入 PATH 的 dsh
& $dsh plugin --profile <你的 profile> add C:\path\to\dsh-superAgent-yh
```

或在 DSH **插件**页用「添加插件」选择本地目录/安装包。装完重载宿主。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-superagent-yh
  name: dsh-superagent-yh
  config:
    dryRun: false                     # 默认 true；确认要真干活再关
    stateDir: C:/path/to/state        # 默认 <DSH_HOME>/state/dsh-superagent-yh
    pollIntervalMs: 60000
    mainSessionId: ""                 # 主线会话 id；留空则只记状态不投递
    repoPath: C:/path/to/local-repo   # worker 从这里的 git worktree 检出
    maxTicketsPerHour: 10
    cooldownMs: 60000
    sources:
      github:
        enabled: true
        repo: owner/name
        labels: [superagent]          # 全部命中才触发（空=不筛）
        authors: [your-login]         # 触发人白名单
        token: ""                     # 也可留空用匿名（限流更严）
        confirmWrites: false          # 评论/打标签必须显式开启
      feishu:
        enabled: false
        appId: ""
        appSecret: ""
        chatIds: []
        requireMention: true
      qq:
        enabled: false
        mode: personal            # personal=OneBot v11；official=roost-host/1
        requireAt: true
        confirmWrites: false
        personal:
          httpUrl: http://127.0.0.1:6700
          wsUrl: ws://127.0.0.1:6700
          selfId: ""              # requireAt 时必填
        official:
          host: 127.0.0.1
          port: 6807
          token: ""
```

## 控制台

- **应用内（推荐）**：左侧栏的 **Superagent** 图标打开主面板；右侧栏有同名页签（需要 better-sidebar，未装则自动跳过）。
  - 看：三态计数、按源分组工单、最后错误、每个工单的问题/摘要。
  - 做：失败重试、进行中取消、打开 worker 会话、查看工单日志。
  - 配：dryRun / 主线会话 / 轮询间隔 / worker preset，以及 GitHub、飞书、QQ 三个源的启用与字段；保存写回 profile 配置（插件重载）。
- **关闭**：主面板右上「关闭」返回会话；右页签可用原生关闭，正文顶部也有「关闭」。
- **独立页**：`http://<宿主地址>/dsh-superagent-yh`（全小写），只读列表 + 三个基础设置，适合临时排查。

> 客户端模块在装好后需要**重启一次 DSH** 才会加载；host 路由与 `superagent_status` 工具不需要重启。

## 安全

- 默认 dryRun；写操作（评论/标签/发消息）必须 `confirmWrites: true`
- 作者白名单、每小时上限、冷却、ticket id 幂等
- 凭证不写进 `state.json`；日志与面板文本统一走 `redact()`
- worker 只在自己的 worktree 里改文件

## 已知限制

- 真实 GitHub / 飞书 / QQ 需要凭证与网关；仓库内集成测试用本地假服务（`test/fakes/`）
- 评论追问（同 thread 二次触发）本期只到 issue 本体，后续迭代补
- QQ 只发文本；媒体/图片/语音未做；微信不做

## 目录

```
lib/           插件代码（index/config/store/ticket/executor/relay/panel/redact + source/）
test/           单元测试、假源、会话日志解码工具
docs/           计划书报告、移植笔记、QQ 接入说明
cordis.patch.yml 插件行 + worker / 纯调度 dispatcher 两个 preset
locale/         zh/en 显示名与说明
```

## 许可

MIT（见 [LICENSE](LICENSE)）。设计参考与移植来源见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：

- 官方 superagent 原型（MIT）——工单/会话隔离的设计参考
- dsh-aurabot-qq（MIT）——OneBot v11 客户端移植
- dsh-roost / qq-bot-roost（AGPL）——只按公开协议实现 `roost-host/1`，未复制代码
