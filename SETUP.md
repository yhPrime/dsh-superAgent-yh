# SETUP：装到本机 DSH

> 适用于 Desktop 安装版（profile 由应用管理）。自定义 profile 可直接用 CLI。

## 1 准备

- DSH `>=0.2.2-rc.5 <0.3.0`
- 一个本地 git 克隆（worker 会从它 `git worktree` 检出）
- 可选：GitHub token（private 仓库或提高限额）、飞书应用 appId/appSecret

## 2 安装插件

本地目录：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> add "C:\path\to\dsh-superAgent-yh"
```

或打好的 tgz：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> add "C:\path\to\dsh-superagent-yh-0.1.0.tgz"
```

装完在 DSH **插件**页确认 `dsh-superAgent-yh` 行存在；重载宿主。

## 3 写配置

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- id: dsh-superagent-yh
  name: dsh-superagent-yh
  config:
    dryRun: true
    repoPath: C:/path/to/local-repo
    mainSessionId: ""
    sources:
      github:
        enabled: true
        repo: owner/name
        authors: [your-login]
```

先保持 `dryRun: true` 跑一轮。

## 4 验收

1. 重启一次 DSH（客户端模块需要重启加载）；左侧栏应出现 **Superagent** 图标，点击打开主面板；右侧栏（若装 better-sidebar）有同名页签；
2. 主面板/右页签都能关闭：主面板右上「关闭」返回会话，右页签有原生关闭与体内「关闭」；
3. 在源里造一条符合条件的事件，等一个轮询周期，控制台应出现 `queued` 工单（dryRun 下不会真跑）；
4. 把 `dryRun` 改 false、`mainSessionId` 填一个已存在的会话（或留空只看控制台）；
5. 再触发一次：控制台出现 `running`，worker 会话 `worker-<id>` 出现，worktree 在 `<stateDir>/work/<id>`；
6. 完成后 `done`，主线收到「开工/完成」两条消息（需要人时多一条）；
7. 失败工单可点「重试」，进行中可「取消」，有会话的可「会话」打开，任何工单可看「日志」。

## 5 排查

- 面板「最后错误」或 `state.json` 的 `lastError`；
- `<stateDir>/logs/<ticketId>.log` 每个工单的执行日志；
- `worker-<id>` 会话日志：`~/.dsh/sessions/<cwd编码>/worker-<id>/session.v4.jsonl.zstd`（可用 `test/tools/dump-session.mjs` 解码）；
- 配置不合法时插件会带着明确错误启动失败（fail-closed），先看宿主日志里的 `ConfigError`。
