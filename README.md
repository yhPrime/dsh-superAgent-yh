# dsh-superAgent-yh 自制版

把「一个会话里的一支智能体团队」做成可安装的 DSH 插件：你只在一个会话里说话，插件把活派给 worker 会话和独立 worktree，结果用三条短消息回到这条线；不 checkout 源码、不手改 profile、不跑外部 setup。

- 包名：`dsh-superagent-yh`（npm 不允许大写）；显示名：**dsh-superAgent-yh 自制版**
- 宿主：DeepSeek Harness `>=0.2.2-rc.5 <0.3.0`
- 来源：GitHub、飞书（插件内直连 HTTP）；QQ 个人号（OneBot v11）与官方机器人（roost-host/1）；微信本期不做

## 能力（v2.11）

- **配置即可用**：一个插件行 + 默认 `dryRun=true`（只记录不干活）
- **自动建工单**：任一启用源出现符合条件的动态 → 一个轮询周期内建 Ticket
- **单会话登记制**：在你想当「团队入口」的空白会话里点亮输入区图标，即登记该会话为这一工作空间的单会话；一个工作空间同时只有一个
- **标题固定**：登记成功后该会话标题自动改为 `<工作空间名称>超级智能体团队`（工作空间名按 59 字节截断，总长 ≤80 字节，后缀保留）；之后被改掉会在 60 秒内自愈
- **纯调度执行**：单会话跑本插件自带的 `dsh-superagent-yh-dispatcher` preset，只派活不动手——工具面只剩 `subagent`（`run_code` 与全局 ops/exp 工具被 restrict 藏掉）
- **隔离执行 + 三条短消息**：worker 用 `worker-*` 会话 + `workRoot/<ticketId>` 独立 git worktree；主线只收开工、需要人、完成三条短消息
- **可见**：区头任务板（最多 20 条：未终态全部 + 最近完成）、控制台面板、只读工具 `superagent_status`

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
    mainSessionId: ""                 # 传统主线投递；单会话模式不必填
    repoPath: C:/path/to/local-repo   # worker 从这里的 git worktree 检出
    singleSession:
      enabled: false                  # 打开后会话里才出现登记图标
      preset: dsh-superagent-yh-dispatcher   # 单会话执行的 preset，一般不用改
      idleMinutes: 30                 # 空闲多久触发压缩
      pressureRatio: 0.5              # 上下文压力阈值
      autoCreate: true                # 已废弃：不再生效，仅为兼容旧配置保留
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
## 用单会话

1. 打开 `singleSession.enabled: true` 并重载插件。
2. 新建一个**空白**会话（已经开始说话的会话不能中途切 preset），在输入区右侧点 **Superagent 图标**。
3. 图标消失＝登记成功；标题变为「<工作空间名>超级智能体团队」，之后直接说话即可，活会派给 worker。
4. 想拆掉：进控制台 → 工作空间卡片 → **删除单会话**（先注销登记、再归档该会话；不另设「只解除」入口）。删除后 preset 会尽量恢复，恢复失败会显示在控制台错误框。

图标只在「总开关开 + 本会话未登记 + 本工作空间无他人登记」时出现；未启用或被占用时不渲染。

## 控制台

- **应用内（推荐）**：左侧栏 **Superagent** 图标打开主面板；右侧栏同名页签（需 better-sidebar，未装自动跳过）。
  - 看：三态计数、按源分组工单、最后错误、每个工单的问题/摘要、各工作空间的单会话登记状态。
  - 做：失败重试、进行中取消、打开 worker 会话、查看工单日志、立即压缩、删除单会话。
  - 配：dryRun / 轮询间隔 / worker preset，以及 GitHub、飞书、QQ 三个源的启用与字段；保存写回 profile 配置（插件重载）。
- **关闭**：主面板右上「关闭」返回会话；右页签用原生关闭，正文顶部也有「关闭」。
- **独立页**：`http://<宿主地址>/dsh-superagent-yh`（全小写），只读列表 + 基础设置，适合临时排查（后续版本冻结为只读降级）。

> `client.js` 改动必须**重启一次 DSH** 才会加载；host 路由与 `superagent_status` 随插件重载生效。

## 安全

- 默认 dryRun；写操作（评论/标签/发消息）必须 `confirmWrites: true`
- 作者白名单、每小时上限、冷却、ticket id 幂等；凭证不写进 `state.json`；日志与面板文本统一走 `redact()`
- worker 只在自己的 worktree 里改文件；单会话默认无 shell/fs 工具

## 已知限制

- 真实 GitHub / 飞书 / QQ 需要凭证与网关；仓库内集成测试用本地假服务（`test/fakes/`）。评论追问（同 thread 二次触发）本期只到 issue 本体
- QQ 只发文本，媒体/图片/语音与微信不做
- 登记后图标消失是设计（入口关闭），删除只能走控制台；「只解除、保留会话」本期不提供

## 目录

```
lib/           插件代码（index/config/store/ticket/executor/relay/panel/redact/dispatcher/diagnostics + source/）
test/          单元测试、假源、会话日志解码工具、真机黑盒脚本
docs/          计划书报告、草案存档、QQ 接入说明
cordis.patch.yml 插件行 + worker / 纯调度 dispatcher 两个 preset
locale/        zh/en 显示名与说明
```

## 许可

MIT（见 [LICENSE](LICENSE)）。设计参考与移植来源见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：

- 官方 superagent 原型（MIT）——工单/会话隔离的设计参考
- dsh-aurabot-qq（MIT）——OneBot v11 客户端移植；dsh-roost / qq-bot-roost（AGPL）——只按公开协议实现 `roost-host/1`，未复制代码
