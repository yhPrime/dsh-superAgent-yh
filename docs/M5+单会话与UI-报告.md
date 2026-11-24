# 单会话 + UI 迭代报告

> 状态：U1–U3 完成，U4 待谷段（2026-11-24）｜依据：`子计划书-单会话与UI.md` v1.1（定稿 D13）｜包：0.4.0

## 1 已实现

| 阶段 | 交付 |
|---|---|
| U1 | `lib/single-session.js`：按工作空间解析唯一接单会话（会话源优先复用 → `intake-<slug>` → autoCreate）；空闲/压力触发压缩；运行中/排队/等人一律不压；`snapshot` 只读 |
| U2 | `lib/panel.js`：`/status` 增加 `workspaces`、`/action` 增加 `compact`（400/404/409 映射）、`/settings` 支持 `singleSession.*` 并跑 `normalizeConfig` 校验 |
| U3 | `client.js` 四页签（概览/工单/源/设置）；工作空间卡（上下文进度条、上次压缩、立即压缩、打开会话）；统计卡点击过滤；工单搜索 + 状态 chips；单会话设置组 |
| U4（部分） | 独立页改用主题 token 并展示单会话摘要；数据复用 `/status` |

## 2 四路测试

| 路 | 结果 |
|---|---|
| 白盒 | **82 条单测全绿**（新增 single-session 14 条、panel-settings 4 条、client smoke 2 条） |
| 黑盒 | 探针 profile 实测：`/` 200 且含「单会话模式」；`/status` 返回 `singleSession.workspaces`（8 个工作空间）；`compact` 缺 sessionId→400、未知会话→409；`settings` 合法→200、非法→400 |
| 真实使用模拟 | **待谷段（12:00–14:00）**：需要一次真实模型调用才能观察「压缩前后 token 下降」，峰段不做 |
| 健壮性 | snapshot 不建会话；不把同目录无关会话当接单会话；运行中/排队/等人不压；preset 没挂 compaction → 明确报错；非法 singleSession 配置 fail-closed |

## 3 迭代中发现并修复的问题

1. **`regionEndOf` 差一**：保留最近 N 轮时把第 N+1 轮也压了；改为 `starts[k-N]`，并补 N=0 分支。
2. **web profile 根上没有 `compaction`**：`dsh-web-app` 在根上 `disabled: true`，compaction 只在各 preset 的隔离域里挂载；改为 `agentPresets.serviceFor(agent,'compaction')` 按 agent 现取（桌面/网页 profile 都成立）。
3. **`snapshot` 会建会话**：面板每 5 秒轮询 `/status` 会触发 autoCreate；改为 `resolve({allowCreate:false})`，只有 `maintain()` 能建。
4. **误采纳同目录会话**：原逻辑会把同 cwd 的任意会话当接单会话并压缩；已删除该兜底，只认 `intake-*` 或配置的会话源。

## 4 未验

- 控制台四页签的真实视觉/交互（需重装 + 重启 DSH 后才加载；本轮按"迭代期不重启"未动用户的 desktop profile）。
- 真实自动压缩的效果（谷段补）。
- 多工作空间下 `autoCreate` 的实际体感（8 个工作空间会各建一个 `intake-*` 会话，需用户确认是否要默认关）。

## 5 数据

- 包：`dist/dsh-superagent-yh-0.4.0.tgz`
- 子计划：`子计划书-单会话与UI.md` v1.1
- 提交：见 `git log`（U1/U2/U3 各一次）