# SETUP：装到本机 DSH

适用于 Desktop 安装版；自定义 profile 直接用 CLI 也一样。

## 1 准备

- DSH `>=0.2.2-rc.5 <0.3.0`，Node `^22.19` 或 `>=24`
- git；worker 的 `prepare` 命令会用到
- 想接 GitHub：一个能用的 `gh`（或用 agent 账号的 `gh` 包装）
- 想接飞书：`lark-cli` 与自建应用凭证
- 想接 QQ：一台 OneBot v11 网关，或 roost-host 服务与 token

## 2 安装

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> add "C:\path\to\dsh-superAgent-yh"
```

装完在 DSH **插件**页确认有 `dsh-superAgent-yh` 行，然后重启一次宿主。

## 3 写配置

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 写插件行（`stateDir` 必填，必须绝对路径）：

```yaml
- id: dsh-superagent-yh
  config:
    stateDir: C:/Users/you/.dsh/state/superagent
```

用飞书或 QQ 时，再把对应的插件行打开：

```yaml
- id: dsh-superagent-yh-feishu
  disabled: false
- id: dsh-superagent-yh-qq
  disabled: false
```

## 4 配来源

重启后打开 **Superagent** 面板：

1. **Settings → Sources**：GitHub 填 `owner/name` 与 agent 的 `gh` 路径；飞书填 bot 的 `lark-cli`、要听的群和私聊开关；QQ 填通道与网关地址（字段见 README「QQ」）。
2. **Policy**：在对应来源下加允许发单的账号；QQ 群里的 @、私聊里的直接请求才会变成工单。
3. **Execution**：填工单目录根和 `prepare` 命令，例如：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent-yh/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent-yh/$DSH_SUPERAGENT_TICKET"
   ```

只用 QQ 时，第 1 步把 GitHub 来源关掉即可，部署检查不再要求 repository 与 GitHub CLI。

## 5 验收

1. Overview 无 setup 问题，各 health 条目为 ready（或来源暂未启动）；
2. 在 QQ 群里 @ 机器人一句请求，或在 GitHub/飞书来源造一条允许的人发的事件；
3. 面板 Trigger 出现记录，Eval 通过后出现 Ticket；接受后 worker 会话 `worker-<id>` 出现；
4. 完成后 Ticket 结束，消息回到原群/原会话；
5. 重启宿主后再触发同一条消息，不应重复建单。

## 6 排查

- Overview 的 setup/health 条目指出问题所在，Settings 里改完会自动重跑部署检查；
- 日志在 `<stateDir>` 下；
- 强制结束宿主后马上重启可能遇到 `Lock file is already being held`：等 30 秒或删掉 `<stateDir>.lock` 目录。
