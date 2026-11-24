/**
 * 单会话模式：每个工作空间一个「接单会话」，空闲或上下文超阈值时把旧上下文压成摘要。
 * 压缩复用宿主自己的 compaction 服务（不自写摘要）；占用读 tokenMeter.contextPressure。
 * 只收敛接单会话——worker 仍每工单独立（子计划书-单会话与UI.md D13）。
 */

/** 工作空间路径 → 稳定短 slug（同目录稳定、不同目录不撞）。 */
export function slugOf(path) {
  const text = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  const tail = text.split('/').filter(Boolean).pop() ?? 'root'
  const clean = tail.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'root'
  return `${clean}-${hash.toString(36)}`
}

export function intakeIdOf(prefix, path) {
  return `${prefix}-${slugOf(path)}`
}

/**
 * 是否该压缩。纯函数，便于单测。
 * 正在跑 / 有排队 / 在等人输入 → 一律不压（R27）。
 */
export function shouldCompact({ running, queued, pendingInput, idleForMs, pressureTokens, contextWindow, idleMinutes, pressureRatio }) {
  if (running) return { need: false, reason: 'running' }
  if (queued) return { need: false, reason: 'queued' }
  if (pendingInput) return { need: false, reason: 'pending-input' }
  if (contextWindow > 0 && pressureTokens / contextWindow >= pressureRatio) return { need: true, reason: 'pressure' }
  if (idleForMs >= idleMinutes * 60_000) return { need: true, reason: 'idle' }
  return { need: false, reason: 'fresh' }
}

/** 从事件页里算出「保留最近 N 轮」的压缩区间终点（含）。k ≤ N 时返回 null。 */
export function regionEndOf(records, keepRecentTurns) {
  const seqs = []
  const starts = []
  for (const record of records ?? []) {
    const event = record?.event ?? record
    if (!Number.isFinite(event?.seq)) continue
    seqs.push(event.seq)
    if (event.type === 'turn/start') starts.push(event.seq)
  }
  if (seqs.length === 0) return null
  starts.sort((a, b) => a - b)
  if (starts.length <= keepRecentTurns) return null
  // 一轮都不留：压到最新一条
  if (keepRecentTurns === 0) return Math.max(...seqs)
  // 保留最近 N 轮 → 压到「第 k-N+1 轮」开始之前
  return starts[starts.length - keepRecentTurns] - 1
}

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)

export function createSingleSessionMaintainer({ ctx, config, store, log, redact, deps = {} }) {
  const single = config.singleSession
  const activity = new Map()
  const controller = new AbortController()

  const api = {
    listWorkspaces: deps.listWorkspaces ?? (() => ctx.workspaceRegistry?.list?.() ?? []),
    listSessions: deps.listSessions ?? (async () => (await ctx.sessionController.list({}, controller.signal))?.items ?? []),
    getState: deps.getState ?? ((sessionId) => ctx.sessionController.state({ sessionId }, controller.signal)),
    getAgent: deps.getAgent ?? ((sessionId) => ctx.agents?.get?.(sessionId)),
    getPressure: deps.getPressure ?? ((agent) => ctx.tokenMeter?.contextPressure?.(agent.session) ?? {}),
    // compaction 由 preset 挂载（web profile 在根上禁用了 compaction-basic），必须按 agent 的 preset 取。
    getCompaction: deps.getCompaction ?? ((agent) => ctx.agentPresets?.serviceFor?.(agent, 'compaction') ?? null),
    readEvents: deps.readEvents ?? (async (sessionId) => (await ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 200 }, controller.signal))?.records ?? []),
    compactRegion: deps.compactRegion ?? ((start, end, agent, engine) => engine.compactRegion(start, end, agent, controller.signal)),
    createSession: deps.createSession ?? ((request) => ctx.sessionController.create(request)),
    resolveAgent: deps.resolveAgent ?? ((sessionId) => ctx.sessionController.resolveAgent(sessionId)),
  }

  store.state.singleSession ??= {}

  /** 每个工作空间解析出唯一接单会话；已配置的会话源优先复用。allowCreate=false 时只读。 */
  async function resolve({ allowCreate = true } = {}) {
    const workspaces = api.listWorkspaces() ?? []
    const sessions = await api.listSessions()
    const byId = new Map(sessions.map((item) => [item.sessionId, item]))
    const sourceSessionId = config.sources?.session?.enabled ? config.sources.session.sessionId : ''
    const out = []

    for (const workspace of workspaces) {
      const path = workspace.path ?? workspace.cwd ?? ''
      if (!path) continue
      const wanted = intakeIdOf(single.sessionIdPrefix, path)
      let sessionId = null

      if (sourceSessionId && byId.has(sourceSessionId)) {
        const owned = byId.get(sourceSessionId)
        if (!owned.cwd || String(owned.cwd).toLowerCase() === path.toLowerCase()) sessionId = sourceSessionId
      }
      if (!sessionId && byId.has(wanted)) sessionId = wanted
      // 只认「自己的接单会话」：绝不把同目录下无关的会话拿来压缩。
      if (!sessionId && single.autoCreate && allowCreate) {
        try {
          const created = await api.createSession({ sessionId: wanted, cwd: path })
          sessionId = created?.sessionId ?? wanted
          log?.('single-session', `created intake session ${sessionId} for ${path}`)
        } catch (error) {
          out.push({ workspaceId: workspace.id ?? null, path, sessionId: null, error: redact?.(error.message) ?? error.message })
          continue
        }
      }
      const summary = sessionId ? byId.get(sessionId) : null
      out.push({
        workspaceId: workspace.id ?? null,
        path,
        sessionId,
        title: summary?.title ?? null,
        updatedAt: num(summary?.updatedAt, 0),
        missing: !sessionId,
      })
    }
    return out
  }

  async function inspect(entry) {
    const { sessionId } = entry
    if (!sessionId) return { ...entry, status: 'missing' }
    let state
    try {
      state = await api.getState(sessionId)
    } catch (error) {
      return { ...entry, status: 'unavailable', error: redact?.(error.message) ?? error.message }
    }
    const running = Boolean(state?.running)
    const queued = Array.isArray(state?.queue) && state.queue.length > 0
    const pendingInput = Array.isArray(state?.pendingInput) && state.pendingInput.length > 0

    const seen = activity.get(sessionId)
    const cursor = num(state?.cursor, 0)
    const now = Date.now()
    if (!seen || seen.cursor !== cursor) {
      activity.set(sessionId, { cursor, lastActivityAt: now })
    }
    const lastActivityAt = activity.get(sessionId).lastActivityAt || num(entry.updatedAt, now)
    const idleForMs = Math.max(0, now - lastActivityAt)

    let pressureTokens = 0
    let contextWindow = 0
    const agent = api.getAgent(sessionId)
    if (agent) {
      try {
        const pressure = api.getPressure(agent) ?? {}
        pressureTokens = num(pressure.pressureTokens)
        contextWindow = num(pressure.contextWindow)
      } catch {
        /* 读不到占用就不按压力触发 */
      }
    }
    const record = store.state.singleSession[sessionId] ?? null
    return {
      ...entry,
      status: running ? 'running' : queued ? 'queued' : pendingInput ? 'waiting' : 'idle',
      running,
      queued,
      pendingInput,
      cursor,
      idleMinutes: Math.floor(idleForMs / 60_000),
      idleForMs,
      pressureTokens,
      contextWindow,
      ratio: contextWindow > 0 ? pressureTokens / contextWindow : 0,
      lastCompact: record,
      agent,
    }
  }

  async function compactOne(view, reason) {
    const { sessionId } = view
    let agent = view.agent
    if (!agent) {
      try {
        agent = (await api.resolveAgent(sessionId))?.agent ?? null
      } catch {
        agent = null
      }
      if (!agent) throw Object.assign(new Error('会话不在宿主里（可能已关闭），无法压缩'), { code: 'not-live' })
    }
    const engine = api.getCompaction(agent)
    if (!engine) {
      throw Object.assign(new Error('这个会话的 preset 没有挂 compaction 服务，无法压缩'), { code: 'no-compaction' })
    }
    const before = view.pressureTokens
    let result
    let mode = 'compactNow'
    if (single.aggressive) {
      const records = await api.readEvents(sessionId)
      const end = regionEndOf(records, single.keepRecentTurns)
      if (end === null || end < 1) {
        return { skipped: true, reason: 'nothing-to-compact' }
      }
      mode = 'compactRegion'
      result = await api.compactRegion(1, end, agent, engine)
    } else {
      result = await engine.compactNow(agent, controller.signal)
    }
    if (result === null || result === undefined) return { skipped: true, reason: 'host-declined' }
    let after = before
    try {
      after = num(api.getPressure(agent)?.pressureTokens, before)
    } catch {
      /* 压缩后读不到就沿用 before */
    }
    const record = { at: Date.now(), reason, mode, beforeTokens: before, afterTokens: after }
    store.state.singleSession[sessionId] = record
    store.save()
    log?.('single-session', `compacted ${sessionId} (${reason}/${mode}) ${before} → ${after} tokens`)
    return { skipped: false, ...record }
  }

  /** 一轮维护：解析 → 检查 → 需要就压。由 index.js 的 tick 调用，不另起定时器。 */
  async function maintain() {
    if (!single.enabled) return { enabled: false, workspaces: [] }
    const entries = await resolve()
    const views = []
    for (const entry of entries) {
      const view = await inspect(entry)
      if (view.sessionId && view.status !== 'unavailable' && view.status !== 'missing') {
        const decision = shouldCompact({
          running: view.running,
          queued: view.queued,
          pendingInput: view.pendingInput,
          idleForMs: view.idleForMs,
          pressureTokens: view.pressureTokens,
          contextWindow: view.contextWindow,
          idleMinutes: single.idleMinutes,
          pressureRatio: single.pressureRatio,
        })
        view.decision = decision.reason
        if (decision.need) {
          try {
            view.compactResult = await compactOne(view, decision.reason)
            view.lastCompact = store.state.singleSession[view.sessionId] ?? view.lastCompact
          } catch (error) {
            view.error = redact?.(error.message) ?? error.message
            store.state.lastError = `single-session: ${view.error}`
            store.save()
            log?.('single-session', `compact failed ${view.sessionId}: ${view.error}`)
          }
        }
      }
      views.push(publicView(view))
    }
    return { enabled: true, workspaces: views }
  }

  /** 手动「立即压缩」：正在跑/排队/等人一律拒绝（409 由路由层翻译）。 */
  async function compactManual(sessionId) {
    const entries = await resolve({ allowCreate: false })
    const entry = entries.find((item) => item.sessionId === sessionId)
    if (!entry) {
      const known = entries.some((item) => item.sessionId)
      if (!known) throw Object.assign(new Error('单会话模式未启用或没有接单会话'), { code: 'not-enabled' })
      throw Object.assign(new Error(`不是本插件的接单会话：${sessionId}`), { code: 'not-found' })
    }
    const view = await inspect(entry)
    if (view.running || view.queued || view.pendingInput) {
      throw Object.assign(new Error(`会话正在${view.running ? '运行' : view.queued ? '排队' : '等人输入'}，不能压缩`), { code: 'busy' })
    }
    return compactOne(view, 'manual')
  }

  function publicView(view) {
    const { agent, ...rest } = view
    return rest
  }

  /** 只读快照（不触发压缩、不建会话），给 /status 用。 */
  async function snapshot() {
    if (!single.enabled) return { enabled: false, config: single, workspaces: [] }
    const entries = await resolve({ allowCreate: false })
    const views = []
    for (const entry of entries) views.push(publicView(await inspect(entry)))
    return { enabled: true, config: single, workspaces: views }
  }

  return {
    maintain,
    snapshot,
    compactManual,
    dispose() {
      controller.abort()
    },
  }
}
