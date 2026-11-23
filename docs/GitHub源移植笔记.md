# GitHub 源移植笔记：issue / comment 轮询 → 规范化 Trigger

- 版本：v1 草案；日期：2026-11-23；读者：写 `lib/source/github.js` 的人
- 依据：官方原型 `src/sources/{github,github-trigger,github-read,github-channel,github-pull,kind,poll,registry}.ts`
- 口径：本文只讲「把 GitHub 上的 issue/comment 变成 Trigger」；Policy/Eval/Threads/CI 等结构见文末「不需要的部分」。我们的目标契约是 `{ id, thread, actor, title, body, url, at, kind }`（计划书 §4.3 再加 `kind`）。

## 1. 官方怎么读 GitHub（先分清三条路）

| 路 | 接口 | 触发点 | 用途 |
|---|---|---|---|
| 通知 | `notifications?all=true&per_page=50&since=` | GitHub 替我算「谁 @ 我 / 分配给我 / 我订阅的」 | 主路径，按 `subject.url` 反解 issue/PR 号 |
| 仓库流 | `issues?state=all&sort=updated&direction=asc&per_page=100&since=`<br>`issues/comments?…`、`pulls/comments?…` | 自己扫全仓库新建/更新 | 由 `observeIssues/Pulls/Comments` 开关控制，默认关 |
| 线程补读 | `issues/<n>/comments`、`pulls/<n>/comments`、`pulls/<n>/reviews` | 已订阅线程按各自 since 补评论 | 保证「评论追问」不漏 |

移植结论：我们只要 **仓库流 + 按需线程补读** 这一条即可，别同时搬通知流（两路并存会重复，且通知需要额外 token scope）。

## 2. 触发条件：哪些 issue / comment 成为候选

官方 source 层**不按 label、assignee、state 过滤**——这些交给 Policy 的接收表；source 只做下面这些「读得到 / 新鲜 / 不是我」的判定。移植时把 label/assignee 规则放到我们自己的规则层。

判定清单（按官方实际顺序）：

1. **仓库匹配**：`repository.full_name` 或 URL 里的 `owner/name` 与配置一致（大小写不敏感）。
2. **不是我发的**：`item.user.login` 与智能体账号 `sameName` 相同 → 跳过（防自触发）。删除账号官方返回 `null`，归一成 `ghost`。
3. **时间窗口**：`at >= max(该 kind 首次开启时间, 14 天前整点)`。
   - issue/PR 正文只认 `created_at`（新建）；
   - 评论认 `updated_at ?? submitted_at ?? created_at`；
   - 14 天是 `POLL_HORIZON_MS`，既防首次回放历史，也防旧线程被无限追。
4. **首次启用**：`started[kind] = round.started`，即「从开关打开这一刻开始，不读以前的」。
5. **必须 `state=all`**：否则已关闭 issue 上的新评论收不到。**已关闭不是排除条件**——「评论追问一个已关闭的 issue」正是要接住的场景，state 只放进 `meta` 让规则层决定。
6. **`/issues` 里混着 PR**：靠 `pull_request` 字段区分（官方 `issue.data.pull_request` 存在即 PR），不能只看 URL/编号。
7. **`kind` 细分**：issue 正文、PR 正文、conversation 评论、inline review 评论、review（`state`+`commit_id`）。review 无正文但 `state !== 'COMMENTED'`（如 APPROVED）也算有内容——worker 可能在等这个批准。
8. **空内容不派**：`commentTrigger.text` 为空（纯空评论 / `COMMENTED` 且无 body）→ `if (trigger.text)` 才收。
9. **label / assignee**：官方只在读上下文时把 `labels`、`draft`、`merged` 读出来给模型看；**assignee 变更、加 label、改 title 本身都不产生 Trigger**。所以我们若要「打了某个 label 才接」，只能在轮询到的 issue 上做后置过滤，且要接受「加 label 不会唤醒」这个事实。
10. **@ 判定**：`mentions(text, login)`，正则带边界：`(?:^|[^a-zA-Z0-9_@])@login(?![a-zA-Z0-9_-])`，忽略大小写。命中写 `addressed: 'mention'`（官方 Policy 用它区分「明确请求」和「推断候选」）。移植时至少保留这个布尔，别用 `text.includes('@name')`（会误中 `@name2` 和邮箱）。
11. **bot 不算人**：`isHumanLogin` = login 不以 `[bot]` 结尾且 `type` 为空或 `User`；bot 评论只能当「推断候选」，永远不能当明确请求。保留 `human` 标记。

**去重 / 防重复派工（关键）**：不靠内存集合，靠确定性 ID + 水位重叠。

- issue 正文：`id = key('github-issue', String(number))`
- 评论：`id = key('github-comment', html_url ?? 'github:<n>', String(comment.id), updated_at ?? submitted_at)`
- 评论 ID 里带 `updated_at`，所以**编辑过的评论会再触发一次**；issue 正文 ID 不带版本，所以**改 issue 正文不会再触发**（官方是有意的：只有作者能当 actor，后加 @ 不算）。
- 游标重叠：`cursorAt(t) = t - 5s`，故意回退 5 秒防迟到事件，重复项由 ID 去重吃掉。
- 单轮内：`round.read` 记录已读编号避免同一线程读两次；`round.pulls` 缓存 PR 单轮只读一次。

## 3. Trigger 规范化字段与映射

| 我们的字段 | issue / PR 正文 | comment / review | 来源字段 |
|---|---|---|---|
| `id` | `github-issue:<number>` | `github-comment:<comment.id>@<version>` | `number` / `id` + `updated_at ?? submitted_at` |
| `thread` | `github:<number>` | 同左 | issue `number`；评论从 `issue_url` / `pull_request_url` 末段取号 |
| `actor` | `user.login` | 同左 | `user.login`（`null`→`ghost`） |
| `title` | `title` | 父 issue/PR 的 `title`（需线程名缓存），取不到用 `#<n>` | `title` |
| `body` | `title + "\n\n" + (body ?? '')` | `body ?? ''`；inline 前加 `path:line` + diff_hunk 末 3 行；review 前加 `state + " review of commit " + commit_id` | `body`、`path`、`line ?? original_line`、`diff_hunk`、`state`、`commit_id` |
| `url` | `html_url` | `html_url`，缺失回退父 `html_url` | `html_url` |
| `at` | `created_at` | `updated_at ?? submitted_at ?? created_at ?? now` | 同名字段 |
| `kind` | `issue` | `comment` | 由来源流/URL 判定，建议留 `meta.commentKind` |

建议一并带上的 `meta`（规则层与回写都要）：`number`、`isPr`、`commentId`、`prAuthor`、`path`/`line`、`inReplyTo`（inline 的 `in_reply_to_id`）、`addressed`、`human`、`state`。

**水位存储**（键名照抄官方语义即可）：

```js
state.github = {
  since: "2026-11-23T15:00:00.000Z",        // 全仓库流水位
  started: { issues: "...", comment: "..." }, // 各 kind 首次开启时间
  etag: { issues: "\"abc\"", comments: "\"def\"" },
  threadSince: { "12": "2026-11-23T15:00:00Z" } // 每线程补读水位
}
```

## 4. 轮询建议

**REST 还是 gh CLI**：官方走 `gh api`（`commands.api`），因为账号认证与 scope 由 gh 管。本机没有 `gh`、没有 token，别硬抄：`lib/source/github.js` 用 Node 内置 `fetch` 打 REST，`apiBase` 可配（默认 `https://api.github.com`），本地假 GitHub 用它做集成测试。要 `--include` 的能力用 `res.headers` 替代，`--paginate --slurp` 用 `Link: rel="next"` 自己翻。

**分页**：仓库流每轮只取**一页**（`per_page=100&direction=asc`，最旧在前），读完把水位推到本页最新项的 `cursorAt`，下一轮从那里继续，所以不会漏，只是可能要多轮才追平。通知流才用 `Link` 翻页。别一上来就 `forEach` 全翻：会打爆限流，也会让「中途 abort」变得不可收拾。

**ETag / If-None-Match**：官方只用在仓库流，且**仅当本轮 `since` 与上轮完全相同**才带 `If-None-Match`（因为 ETag 对应那一次查询）。304 → 直接 return，不消耗 rate limit。水位一推进就丢弃旧 ETag。移植保留这个条件判断，不要无条件带上。

**限流与异常**：

- 读 `x-poll-interval` 头，`interval = max(60, 该值)`；配置里的 `pollSeconds` 只作为下限参考，GitHub 要求更长以它为准（官方 60–3600s）。
- 403/429：官方没有独立退避逻辑，靠「连续失败 N 次（默认 3）才报 error，单次静默、下轮重试」。我们能更好：读到 `Retry-After` / `x-ratelimit-reset` 就睡到点，且**仍然**保留「连续 N 次才报错」的降噪。
- **410 Gone = issue 真被删**：丢弃该项、记录到线程、不算本轮失败。
- **404 不能当删除**：私有库权限可能暂时丢失，要重试。这条官方在 `deleted()`/`gone()` 里专门写了注释。
- 单条坏数据（schema 不符）→ 跳过并计数，不要整轮失败（官方 `validItems` + `tally.skipped`）。
- 中途 stop/abort：**必须在推进水位之前抛**，让未读项下轮重来。

**首次无水位**：直接取 `now`（`round.started`），并立刻落库。不要取 1970，也不要取「最新一条的时间」——后者会把本页剩下的项当历史漏掉。

## 5. 回写（ack / comment / label）与幂等

官方**没有独立的 ack 接口**：工单完成后的回写就是一条评论，靠隐藏标记做幂等。label 只读不写。

发送路径：

- 普通回写：`POST issues/<n>/comments`，body 里带 `<!-- dsh-superagent:<messageId> -->`（渲染后不可见）。
- inline review 回复：先取目标评论 `pulls/comments/<discussion_id>` 得 `rootId = in_reply_to_id ?? id`，再 `POST pulls/<n>/comments/<rootId>/replies`；目标评论已被删则退回顶层评论，不要报错卡死。
- 发送前先列该路径的评论，若已有「自己账号 + 同一 `in_reply_to_id` + 含该 marker」的评论 → 直接返回 `sent`，不重复发。这样进程崩溃、outbox 重放都不会刷屏。
- 410 或 403 且 message 含 `locked` → 返回 `gone`（永不再发）；其它错误抛出，留给重试。
- ack 语义：`sent`/`gone` 都算「已处理」，`gone` 要记日志但不阻塞工单收口。

**用 label 做 ack 的坑（官方没做，我们若要做）**：加/删 label 会更新 issue 的 `updated_at`，导致它再次出现在 `/issues?since=` 里；再叠加「评论也带 marker 检查」不到位，就会出现 ack → 重新轮询 → 再 ack 的自激。要么不用 label 做 ack，要么在规则层对「无新评论、仅 updated_at 变化」的 issue 一律不产出 Trigger。

## 6. 关键逻辑（伪代码）

```js
const HORIZON_MS = 14 * 24 * 3600_000
const cursorAt = t => new Date(Date.parse(t) - 5000).toISOString() // 回退 5s 防迟到，重复靠 id 去重

async function pollRound(ctx) {
  const round = { started: new Date().toISOString(), read: new Set(), failures: [] }
  for (const stream of [{ id: 'issues', path: 'issues?state=all&sort=updated&direction=asc&per_page=100' },
                        { id: 'comments', path: 'issues/comments?per_page=100' },
                        { id: 'review-comments', path: 'pulls/comments?per_page=100' }]) {
    if (!streamEnabled(ctx, stream.id)) { delete ctx.state.github.since[stream.id]; continue }
    try { await readStream(ctx, round, stream) }
    catch (e) { if (!ctx.stopped) round.failures.push(`${stream.id}: ${e}`) } // 各流独立失败
  }
  return round
}

async function readStream(ctx, round, stream) {
  const st = ctx.state.github
  const horizon = Math.floor((Date.parse(round.started) - HORIZON_MS) / 3600_000) * 3600_000
  const since = new Date(Math.max(Date.parse(st.since[stream.id] ?? round.started), horizon)).toISOString()
  const ifNoneMatch = st.etag[stream.id] && st.since[stream.id] === since ? { 'If-None-Match': st.etag[stream.id] } : {}

  const res = await api(`${stream.path}&since=${encodeURIComponent(since)}`, { headers: ifNoneMatch })
  if (res.status === 304) return
  const items = (await res.json()).filter(isValid)   // 坏项计数后跳过

  for (const item of items) {
    if (ctx.stopped) throw new Error('stopped during poll')           // 推进水位前必须抛
    if (sameLogin(item.user?.login, ctx.agentLogin)) continue          // 别自触发
    if (!fresh(item, stream.id, round)) continue                       // 早于开启时间/超出 14 天
    const trigger = stream.id === 'issues'
      ? normalizeIssue(item)                                          // pull_request 字段区分 PR
      : normalizeComment(item, stream.kind)
    if (trigger) await ctx.receive(trigger)                           // receive 内部按 id 去重
  }

  const newest = Math.max(...items.map(i => Date.parse(i.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  st.since[stream.id] = Date.parse(moved) > Date.parse(since) ? moved : since
  const etag = res.headers.get('etag')
  if (etag && st.since[stream.id] === since) st.etag[stream.id] = etag  // 只有 since 没动才留 ETag
}

function normalizeComment(c, commentKind) {
  const text = [c.state && c.state !== 'COMMENTED' ? `${c.state} review of commit ${c.commit_id ?? 'unknown'}` : '',
                commentKind === 'inline' && c.path ? `${c.path}:${c.line ?? c.original_line ?? ''}` : '',
                c.body ?? ''].filter(Boolean).join('\n\n')
  if (!text) return null                                             // 空评论不派工
  const at = c.updated_at ?? c.submitted_at ?? c.created_at
  return {
    id: `github-comment:${c.html_url ?? c.id}:${at}`,                 // 编辑会变 → 再触发
    thread: `github:${numberOf(c.issue_url ?? c.pull_request_url)}`,
    actor: c.user?.login ?? 'ghost',
    title: (titleCache.get(number) ?? `#${number}`),
    body: text, url: c.html_url ?? parentUrl, at, kind: 'comment',
    meta: { number, isPr: /\/pull\//.test(c.html_url ?? ''), commentId: c.id, commentKind,
            addressed: mentions(text, ctx.agentLogin), human: isHuman(c.user) }
  }
}

// 回写：先查 marker，再发
async function send(thread, text, messageId) {
  const marker = `<!-- dsh-superagent:${messageId} -->`
  const body = `${text}\n\n${marker}`
  const existing = await listComments(thread)                         // 只查一页够用
  if (existing.some(c => sameLogin(c.user?.login, me) && c.body?.includes(marker))) return 'sent'
  const res = await post(`/repos/${repo}/issues/${n}/comments`, { body })
  if (res.status === 410 || (res.status === 403 && /locked/i.test(await res.text()))) return 'gone'
  if (!res.ok) throw new Error(`comment failed: ${res.status}`)        // 留给重试
  return 'sent'
}
```

## 7. 官方实现里我们不需要的部分

- **Policy**（`allowed` 白名单、`bots` 名单、admission 四格表、`scope()` 的 listed/unlisted × addressed/unaddressed）：我们用简版规则引擎替代，只保留 `addressed`、`human` 两个事实。
- **Eval / MasterAssessor / 推断候选**：v1 不做「这条评论值不值得干」的模型评估，规则命中就派工。
- **Threads 体系**：`threads.patch/describe/subscribed`、每线程 `pollError`、`nameThread`、14 天 horizon 的订阅轮询——我们用「tickets + 水位」就够了。
- **通知流与 per-item retry map**（`retries`、24h 放弃）：v1 不走 notifications，省掉这套重试账本；代价是拿不到「分配给我但没 @ 我」的语义，需要时再补。
- **CI**：`pullChecks`、`branchCi`、`ciTrigger`、check-runs/statuses 两套聚合——本期不做。
- **PR 生命周期与绑定**：`github-pull.ts` 的 claim/observe/auto-merge/merge 通知。
- **`github-read.ts` 的上下文读取器**：`githubThreadContext`、`threadMessages`、review 线程拼装——v1 直接把 body 塞进 mandate。
- **其它**：`find()` 查询解析、`environment` 变量注入、`health`/`HealthBoard`、`facts`、`Tally/validItems`（简化成计数器）、`gh`/`GH_CONFIG_DIR` 包装、`deployment` 推送权限校验、多语言文案、OutboundMessage/Outbox 全链路（只借 marker 幂等）。

## 8. 必须保留的坑

1. **确定性 ID 是去重唯一手段**，且评论 ID 必须含版本（`updated_at`）；不要用「进程内 seen set」。
2. **`cursorAt` 回退 5 秒**；水位只推到「本页最新项」，不是 `now`。
3. **中途 abort 先抛、后推水位**，否则半页丢失。
4. **`/issues` 含 PR**，必须看 `pull_request` 字段。
5. **必须 `state=all`**；已关闭 issue 的新评论要接；state 只进 `meta` 交给规则。
6. **`since` 对 `/issues` 是 updated_at 语义**：加 label、改标题都会让它重新出现，所以「只在新评论/新创建时出 Trigger」是防噪声的核心闸门。
7. **跳过自己账号**（大小写不敏感）、删除账号归一成 `ghost`、bot 不算人。
8. **410 = 删了**（丢弃并记录），**404 ≠ 删了**（重试）。
9. **403 + locked → 回写永久失败**（`gone`），别再重试。
10. **inline review 回复的根 ID 是 `in_reply_to_id ?? id`**，用错 ID 直接 404。
11. **回写先查 marker 再发**，marker 用 `<!-- ... -->`，否则崩溃重放会刷重复评论。
12. **分页只取一页、升序、`per_page=100`**，靠水位推进；ETag 只在 `since` 未变时复用。
13. **`x-poll-interval` 要遵守**，间隔不低于 60s；连续失败 3 次才报 error。
14. **mention 正则加边界**，否则 `@foo` 会命中 `@foobar`。
15. **用 label 做 ack 会自激**（label 改动 bump `updated_at`），要么不用，要么在规则层挡住「无新内容」的更新。
16. **首次启用从 `now` 开始**，写清「不读历史」，否则上线即洪水派工。
