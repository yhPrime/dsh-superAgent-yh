/**
 * 单会话登记表（v2.7）：单会话由人手动新建会话后点亮胶囊登记，
 * 插件不再自动建会话；单个工作区最多一个单会话；登记后禁止入档/删除（只能从控制台解除）。
 * 压缩仍复用宿主 compaction / tokenMeter。
 */

export function slugOf(path) {
  const text = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  const tail = text.split('/').filter(Boolean).pop() ?? 'root'
  const clean = tail.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'root'
  return `${clean}-${hash.toString(36)}`
}

export function intakeIdOf(prefix, path, workspaceId) {
  const slug = slugOf(path)
  if (!workspaceId) return `${prefix}-${slug}`
  return `${prefix}-${String(workspaceId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}-${slug}`
}

export function shouldCompact({ running, queued, pendingInput, idleForMs, pressureTokens, contextWindow, idleMinutes, pressureRatio }) {
  if (running) return { need: false, reason: 'running' }
  if (queued) return { need: false, reason: 'queued' }
  if (pendingInput) return { need: false, reason: 'pending-input' }
  if (contextWindow > 0 && pressureTokens / contextWindow >= pressureRatio) return { need: true, reason: 'pressure' }
  if (idleForMs >= idleMinutes * 60_000) return { need: true, reason: 'idle' }
  return { need: false, reason: 'fresh' }
}

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
  if (keepRecentTurns === 0) return Math.max(...seqs)
  return starts[starts.length - keepRecentTurns] - 1
}

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)
const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function createSingleSessionMaintainer({ ctx, config, store, log, redact, deps = {} }) {
  const single = config.singleSession
  const activity = new Map()
  const controller = new AbortController()
  const deleting = new Set()

  const api = {
    listWorkspaces: deps.listWorkspaces ?? (() => ctx.workspaceRegistry?.list?.() ?? []),
    listSessions: deps.listSessions ?? (async () => (await ctx.sessionController.list({}, controller.signal))?.items ?? []),
    getState: deps.getState ?? ((sessionId) => ctx.sessionController.state({ sessionId }, controller.signal)),
    getAgent: deps.getAgent ?? ((sessionId) => ctx.agents?.get?.(sessionId)),
    getPressure: deps.getPressure ?? ((agent) => ctx.tokenMeter?.contextPressure?.(agent.session) ?? {}),
    getCompaction: deps.getCompaction ?? ((agent) => ctx.agentPresets?.serviceFor?.(agent, 'compaction') ?? null),
    readEvents: deps.readEvents ?? (async (sessionId) => (await ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 200 }, controller.signal))?.records ?? []),
    compactRegion: deps.compactRegion ?? ((start, end, agent, engine) => engine.compactRegion(start, end, agent, controller.signal)),
    pinSession: deps.pinSession ?? ((id) => ctx.workspaceRegistry?.pinSession?.(id)),
    unpinSession: deps.unpinSession ?? ((id) => ctx.workspaceRegistry?.unpinSession?.(id)),
    archiveSession: deps.archiveSession ?? ((id) => ctx.workspaceRegistry?.archiveSession?.(id)),
    resolveByPath: deps.resolveByPath ?? ((path) => ctx.workspaceRegistry?.resolveByPath?.(path)),
    resolveAgent: deps.resolveAgent ?? ((sessionId) => ctx.sessionController.resolveAgent(sessionId)),
  }

  store.state.singleSessions ??= {}

  const isRegistered = (sessionId) => Object.values(store.state.singleSessions).includes(sessionId)
  const workspaceOf = (sessionId) => Object.entries(store.state.singleSessions).find(([, id]) => id === sessionId)?.[0] ?? null
  const isDeleting = (sessionId) => deleting.has(sessionId)
  const sessionFor = (workspaceId) => store.state.singleSessions[workspaceId] ?? null

  /** 登记：会话 → 所属工作区；唯一性由工作区维度保证。 */
  async function register(sessionId) {
    if (!single.enabled) throw Object.assign(new Error('单会话模式未开启'), { code: 'not-enabled' })
    const existingWorkspace = workspaceOf(sessionId)
    if (existingWorkspace) {
      return { ok: true, already: true, workspaceId: existingWorkspace, sessionId }
    }
    const sessions = await api.listSessions()
    const summary = sessions.find((item) => item.sessionId === sessionId)
    if (!summary) throw Object.assign(new Error(`会话不存在：${sessionId}`), { code: 'not-found' })
    let workspaceId = summary.workspaceId ?? null
    if (!workspaceId && summary.cwd) {
      const found = await api.resolveByPath(summary.cwd).catch(() => null)
      workspaceId = found?.id ?? null
    }
    if (!workspaceId) throw Object.assign(new Error('这个会话不属于任何工作区，不能登记为单会话'), { code: 'no-workspace' })
    const occupant = store.state.singleSessions[workspaceId]
    if (occupant && occupant !== sessionId) {
      throw Object.assign(new Error(`该工作区已有单会话：${occupant}`), { code: 'workspace-occupied' })
    }
    store.state.singleSessions[workspaceId] = sessionId
    store.save()
    try {
      await api.pinSession(sessionId)
    } catch (error) {
      log?.('single-session', `pin failed ${sessionId}: ${error?.message ?? error}`)
    }
    log?.('single-session', `registered ${sessionId} → workspace ${workspaceId}`)
    return { ok: true, workspaceId, sessionId }
  }

  /** 解除登记（不归档）；用于控制台删除的第一步或用户主动解除。 */
  async function unregister(sessionId) {
    const workspaceId = workspaceOf(sessionId)
    if (!workspaceId) return { ok: true, already: true }
    delete store.state.singleSessions[workspaceId]
    store.save()
    try {
      await api.unpinSession(sessionId)
    } catch (error) {
      log?.('single-session', `unpin failed ${sessionId}: ${error?.message ?? error}`)
    }
    log?.('single-session', `unregistered ${sessionId} (workspace ${workspaceId})`)
    return { ok: true, workspaceId }
  }

  /** 控制台删除：先解除登记（撤销入档保护）→ 再归档。 */
  async function removeSingle(sessionId) {
    const workspaceId = workspaceOf(sessionId)
    if (!workspaceId) throw Object.assign(new Error('不是已登记的单会话'), { code: 'not-found' })
    deleting.add(sessionId)
    try {
      await unregister(sessionId)
      await api.archiveSession(sessionId)
      log?.('single-session', `deleted single session ${sessionId}`)
      return { ok: true, workspaceId, sessionId }
    } finally {
      deleting.delete(sessionId)
    }
  }

  async function inspect(entry) {
    const { sessionId } = entry
    let state
    try {
      state = await api.getState(sessionId)
    } catch (error) {
      return { ...entry, status: 'unavailable', error: redact?.(error.message) ?? error.message }
    }
    const running = Boolean(state?.running)
    const queued = Array.isArray(state?.queue) && state.queue.length > 0
    const pendingInput = Array.isArray(state?.pendingInput) && state.pendingInput.length > 0
    const cursor = num(state?.cursor, 0)
    const now = Date.now()
    const seen = activity.get(sessionId)
    if (!seen || seen.cursor !== cursor) activity.set(sessionId, { cursor, lastActivityAt: now })
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
    return {
      ...entry,
      status: running ? 'running' : queued ? 'queued' : pendingInput ? 'waiting' : 'idle',
      running, queued, pendingInput, cursor, idleForMs,
      idleMinutes: Math.floor(idleForMs / 60_000),
      pressureTokens, contextWindow,
      ratio: contextWindow > 0 ? pressureTokens / contextWindow : 0,
      lastCompact: store.state.singleSession?.[sessionId] ?? null,
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
    if (!engine) throw Object.assign(new Error('这个会话的 preset 没有挂 compaction 服务，无法压缩'), { code: 'no-compaction' })
    const before = view.pressureTokens
    let result
    let mode = 'compactNow'
    if (single.aggressive) {
      const records = await api.readEvents(sessionId)
      const end = regionEndOf(records, single.keepRecentTurns)
      if (end === null || end < 1) return { skipped: true, reason: 'nothing-to-compact' }
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
      /* 忽略 */
    }
    store.state.singleSession ??= {}
    const record = { at: Date.now(), reason, mode, beforeTokens: before, afterTokens: after }
    store.state.singleSession[sessionId] = record
    store.save()
    log?.('single-session', `compacted ${sessionId} (${reason}/${mode}) ${before} → ${after} tokens`)
    return { skipped: false, ...record }
  }

  /** 每轮维护：只对已登记单会话做压缩，不再自动建会话。 */
  async function maintain() {
    if (!single.enabled) return { enabled: false, workspaces: [] }
    const entries = await list()
    const views = []
    for (const entry of entries) {
      const view = await inspect(entry)
      const decision = shouldCompact({
        running: view.running, queued: view.queued, pendingInput: view.pendingInput,
        idleForMs: view.idleForMs, pressureTokens: view.pressureTokens, contextWindow: view.contextWindow,
        idleMinutes: single.idleMinutes, pressureRatio: single.pressureRatio,
      })
      view.decision = decision.reason
      if (decision.need) {
        try {
          view.compactResult = await compactOne(view, decision.reason)
          view.lastCompact = store.state.singleSession?.[view.sessionId] ?? view.lastCompact
        } catch (error) {
          view.error = redact?.(error.message) ?? error.message
          store.state.lastError = `single-session: ${view.error}`
          store.save()
          log?.('single-session', `compact failed ${view.sessionId}: ${view.error}`)
        }
      }
      views.push(publicView(view))
    }
    return { enabled: true, workspaces: views }
  }

  function publicView(view) {
    const { agent, ...rest } = view
    return rest
  }

  /** 已登记单会话列表（控制台只显示这些工作区）。 */
  async function list() {
    if (!single.enabled) return []
    const sessions = await api.listSessions()
    const byId = new Map(sessions.map((item) => [item.sessionId, item]))
    const workspaces = api.listWorkspaces() ?? []
    const out = []
    for (const [workspaceId, sessionId] of Object.entries(store.state.singleSessions)) {
      const workspace = workspaces.find((item) => item.id === workspaceId)
      const summary = byId.get(sessionId)
      out.push({
        workspaceId,
        workspaceName: workspace?.title ?? workspace?.name ?? null,
        path: workspace?.path ?? summary?.cwd ?? null,
        sessionId,
        title: summary?.title ?? null,
        updatedAt: num(summary?.updatedAt, 0),
        archived: summary?.archived === true,
        missing: !summary,
      })
    }
    return out
  }

  async function compactManual(sessionId) {
    const entry = (await list()).find((item) => item.sessionId === sessionId)
    if (!entry) throw Object.assign(new Error('不是已登记的单会话'), { code: 'not-found' })
    const view = await inspect(entry)
    if (view.running || view.queued || view.pendingInput) {
      throw Object.assign(new Error('会话正在运行/排队/等人，不能压缩'), { code: 'busy' })
    }
    return compactOne(view, 'manual')
  }

  async function snapshot() {
    if (!single.enabled) return { enabled: false, config: single, workspaces: [] }
    const entries = await list()
    const views = []
    for (const entry of entries) views.push(publicView(await inspect(entry)))
    return { enabled: true, config: single, workspaces: views }
  }

  /** 会话内胶囊用：这个会话是否已登记 + 工作区是否已被占用。 */
  async function stateOf(sessionId) {
    const workspaceId = workspaceOf(sessionId)
    const sessions = await api.listSessions()
    const summary = sessions.find((item) => item.sessionId === sessionId)
    let ownWorkspaceId = workspaceId ?? summary?.workspaceId ?? null
    if (!ownWorkspaceId && summary?.cwd) {
      const found = await api.resolveByPath(summary.cwd).catch(() => null)
      ownWorkspaceId = found?.id ?? null
    }
    const occupant = ownWorkspaceId ? store.state.singleSessions[ownWorkspaceId] ?? null : null
    return {
      enabled: single.enabled,
      registered: Boolean(workspaceId),
      workspaceId: ownWorkspaceId,
      workspaceOccupied: Boolean(occupant && occupant !== sessionId),
      occupant,
    }
  }

  return {
    register, unregister, removeSingle, isRegistered, isDeleting, workspaceOf, sessionFor,
    maintain, snapshot, list, stateOf, compactManual,
    dispose() { controller.abort() },
  }
}
