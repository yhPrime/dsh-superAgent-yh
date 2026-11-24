/**
 * 装配：读配置 → 开 state → 建源 → 调度轮询 → 串行派工 → 主线 relay → 只读状态工具。
 * 失败不吞：source 错误落 state.lastError，工单错误落 ticket.lastError，均可被面板/状态工具看到。
 */
import { normalizeConfig, secretsOf } from './config.js'
import { createRedactor } from './redact.js'
import { openStore } from './store.js'
import { assertSource } from './source/contract.js'
import { createGithubSource } from './source/github.js'
import { createFeishuSource } from './source/feishu.js'
import { createQqSource } from './source/qq.js'
import { createRelay } from './relay.js'
import { createExecutor, createFileLogger } from './executor.js'
import { registerPanel } from './panel.js'
import { createSingleSessionMaintainer } from './single-session.js'
import { createAssessment } from './assessment.js'
import { createOrchestrator } from './orchestrator.js'
import { createTargetResolver } from './target.js'
import { createTicket, hourlyCount, threadCoolingDown, ticketStats } from './ticket.js'

export const name = 'dsh-superagent-yh'
export const inject = ['sessionController', 'agents', 'tools', 'permissionPresets', 'agentPresets']

const STATUS_TOOL = {
  name: 'superagent_status',
  description: '查看 dsh-superAgent-yh 的工单三态统计与最近工单（只读，含最后错误）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string', description: '只看某个源：github / feishu / qq（可选）' },
      limit: { type: 'number', description: '最多列出多少个工单，默认 20' },
    },
  },
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const redact = createRedactor(secretsOf(config))
  const store = openStore({ dir: config.stateDir })
  const log = createFileLogger(store, redact)
  ctx.effect(() => () => store.close())

  const sources = {}
  if (config.sources.github.enabled) {
    sources.github = assertSource(createGithubSource(config.sources.github), 'github')
  }
  if (config.sources.feishu.enabled) {
    sources.feishu = assertSource(createFeishuSource(config.sources.feishu), 'feishu')
  }
  if (config.sources.qq.enabled) {
    sources.qq = assertSource(createQqSource(config.sources.qq, { log: (message) => log('qq', message) }), 'qq')
  }

  const relay = createRelay({ ctx, store, config, redact, log })
  // workspaceRegistry 只在子注入域可见：captured 后按需读取，避免 should-not-inject 报错。
  let workspaceRegistry = null
  ctx.inject(['workspaceRegistry'], (child) => {
    workspaceRegistry = child.workspaceRegistry ?? null
    child.effect(() => () => { workspaceRegistry = null })
  })
  const listWorkspaces = () => workspaceRegistry?.list?.() ?? []
  // llm / 默认模型路由同样只在子注入域可见；按需读取，QQ 研判才用得上。
  let llm = null
  let agentDefaultModel = null
  ctx.inject(['llm', 'agentDefaultModel'], (child) => {
    llm = child.llm ?? null
    agentDefaultModel = child.agentDefaultModel ?? null
    child.effect(() => () => {
      llm = null
      agentDefaultModel = null
    })
  })
  const assessment = createAssessment({
    ctx, config, log, redact,
    deps: {
      listWorkspaces,
      llm: () => llm,
      defaultModel: () => agentDefaultModel?.currentSelection?.() ?? {},
    },
  })
  const orchestrator = createOrchestrator({ ctx, config, store, log, redact })
  const targetResolver = createTargetResolver({
    ctx, config, log, redact,
    deps: {
      listWorkspaces,
      registeredSession: (workspaceId) => singleSession?.sessionFor?.(workspaceId) ?? null,
    },
  })
  let subagents = null
  ctx.inject(['subagents'], (child) => {
    subagents = child.subagents ?? child.get?.('subagents') ?? null
    child.effect(() => () => {
      subagents = null
    })
  })
  const executor = createExecutor({
    ctx, config, store, relay, redact, log, sources,
    assessment, orchestrator, targetResolver,
    getSubagents: () => subagents,
    archiveSession: (id) => workspaceRegistry?.archiveSession?.(id),
  })

  // 单会话维护器：只要 tokenMeter + workspaceRegistry；compaction 按 agent 的 preset 现取（web profile 根上没有）。
  let singleSession = null
  ctx.inject(['tokenMeter', 'workspaceRegistry'], (child) => {
    const maintainer = createSingleSessionMaintainer({ ctx: child, config, store, log, redact })
    singleSession = maintainer
    // 已登记的单会话禁止入档/删除：上报活动让宿主的 archiveSession 拒绝（控制台删除时会先注销）。
    child.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next()
      if (!maintainer.isRegistered(sessionId) || maintainer.isDeleting(sessionId)) return rest
      return [{ kind: 'turn' }, ...(rest ?? [])]
    })
    child.effect(() => () => {
      maintainer.dispose()
      if (singleSession === maintainer) singleSession = null
    })
  })

  let stopped = false
  let ticking = false

  /** 工单的工作区线索：GitHub 用本地克隆路径；其它源可用显式 workspace。 */
  function workspaceHintOf(kind) {
    const source = config.sources?.[kind] ?? {}
    if (kind === 'github') return config.repoPath || source.workspace || ''
    return source.workspace || ''
  }

  function ingest(trigger, kind) {
    const id = `${kind}:${trigger.id}`
    if (store.state.tickets[id]) return 'duplicate'
    const cooling = threadCoolingDown(store.state.tickets, kind, trigger.thread, config.cooldownMs)
    if (cooling) {
      log(id, `cooldown: thread ${trigger.thread} 冷却中（已有 ${cooling.id}）`)
      return 'cooldown'
    }
    const ticket = createTicket(trigger, { source: kind })
    ticket.dryRun = config.dryRun
    const hint = workspaceHintOf(kind)
    if (hint) ticket.workspaceHint = hint
    store.state.tickets[id] = ticket
    log(id, `queued [${trigger.kind}] ${trigger.title} (${trigger.url}) dryRun=${config.dryRun}`)
    return 'created'
  }

  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      for (const [kind, source] of Object.entries(sources)) {
        if (hourlyCount(store.state.tickets) >= config.maxTicketsPerHour) {
          store.state.sourceStatus[kind] = { ok: true, at: Date.now(), throttled: true, lastError: `每小时上限 ${config.maxTicketsPerHour} 已到` }
          store.state.lastError = `每小时上限 ${config.maxTicketsPerHour} 已到，暂停建单（水位不推进，恢复后会补上）`
          store.save()
          continue
        }
        const pollStartedAt = new Date().toISOString()
        const since = store.state.watermark[kind] ?? new Date(Date.now() - config.horizonDays * 86_400_000).toISOString()
        try {
          const result = await source.poll(since)
          let added = 0
          for (const trigger of result?.triggers ?? []) if (ingest(trigger, kind) === 'created') added += 1
          const next = result?.since && new Date(result.since) > new Date(pollStartedAt) ? result.since : pollStartedAt
          store.state.watermark[kind] = next
          store.state.sourceStatus[kind] = { ok: true, at: Date.now(), added, watermark: next }
          if (added > 0) log(kind, `poll added ${added} ticket(s)`)
        } catch (error) {
          const message = redact(error && error.message ? error.message : String(error))
          store.state.sourceStatus[kind] = { ok: false, at: Date.now(), lastError: message }
          store.state.lastError = `${kind}: ${message}`
          log(kind, `poll failed: ${message}`)
        }
        store.save()
      }

      if (!config.dryRun && !executor.busy()) {
        const next = Object.values(store.state.tickets).find((ticket) => ticket.status === 'queued' && !ticket.dryRun)
        if (next) {
          log(next.id, 'dispatch')
          await executor.runTicket(next.id)
        }
      }

      // 单会话模式：复用同一个 tick，不另起定时器。
      if (singleSession && config.singleSession.enabled) {
        try {
          await singleSession.maintain()
        } catch (error) {
          const message = redact(error && error.message ? error.message : String(error))
          store.state.lastError = `single-session: ${message}`
          store.save()
          log('single-session', `maintain failed: ${message}`)
        }
      }
    } finally {
      ticking = false
    }
  }

  const runTick = () => {
    tick().catch((error) => log('tick', `uncaught: ${redact(error && error.message ? error.message : String(error))}`))
  }
  const timer = setInterval(runTick, config.pollIntervalMs)
  const kick = setTimeout(runTick, config.startupDelayMs)

  const statusTool = {
    name: STATUS_TOOL.name,
    description: STATUS_TOOL.description,
    parameters: STATUS_TOOL.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}) {
      const filter = typeof args.source === 'string' && args.source ? args.source : null
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
      const all = Object.values(store.state.tickets).filter((ticket) => !filter || ticket.source === filter)
      return {
        dryRun: config.dryRun,
        mainSessionId: config.mainSessionId || null,
        pollIntervalMs: config.pollIntervalMs,
        singleSession: singleSession ? await singleSession.snapshot() : { enabled: config.singleSession.enabled, config: config.singleSession, workspaces: [] },
        stats: ticketStats(all),
        lastError: store.state.lastError,
        sources: store.state.sourceStatus,
        tickets: all
          .slice(-limit)
          .map((ticket) => ({
            id: ticket.id,
            source: ticket.source,
            title: ticket.title,
            status: ticket.status,
            url: ticket.url,
            sessionId: ticket.sessionId,
            workdir: ticket.workdir,
            lastError: ticket.lastError,
            question: ticket.report?.question ?? null,
            summary: ticket.report?.summary ?? null,
          })),
      }
    },
  }
  ctx.effect(() => ctx.tools.register(statusTool))

  ctx.inject(['webServer'], (child) => {
    try {
      const origin = registerPanel({ ctx: child, store, config, redact, log, getSingleSession: () => singleSession })
      ctx.logger.info('dsh-superAgent-yh panel: %s/dsh-superagent-yh', origin)
    } catch (error) {
      log('panel', `register failed: ${redact(error && error.message ? error.message : String(error))}`)
    }
  })

  ctx.effect(() => () => {
    stopped = true
    clearInterval(timer)
    clearTimeout(kick)
    executor.dispose()
    relay.dispose()
    for (const source of Object.values(sources)) {
      try {
        source.dispose?.()
      } catch {
        /* 已关闭 */
      }
    }
  })

  ctx.logger.info(
    'dsh-superAgent-yh ready (dryRun=%s, sources=%s, stateDir=%s)',
    config.dryRun,
    Object.keys(sources).join(',') || 'none',
    config.stateDir,
  )
}
