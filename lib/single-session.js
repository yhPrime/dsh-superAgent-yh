/**
 * 单会话登记表（v2.7）：单会话由人手动新建会话后点亮胶囊登记，
 * 插件不再自动建会话；单个工作区最多一个单会话；登记后禁止入档/删除（只能从控制台解除）。
 * 压缩仍复用宿主 compaction / tokenMeter。
 *
 * v2.12 / D40：单会话直派的子会话（subagent 工具）不经过工单管线，也不会被宿主归档。
 * 这里把它们按「真的是工单」判定后纳管成工单，并在空闲后归档，避免越挂越多。
 */
import { archiveChildSession } from './child-archive.js'
import { childTicketDoc, childTicketId, classifyChild } from './child-tickets.js'
import { markDone } from './ticket.js'
import { compactionEngineFor } from './compaction-bridge.js'

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

export const SINGLE_SESSION_TITLE_SUFFIX = '超级智能体团队'
const TITLE_NAME_MAX_BYTES = 59

/** 按 UTF-8 字节安全截断，不把多字节字符切成半个。 */
export function truncateUtf8(text, maxBytes) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let out = ''
  let used = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** 单会话固定标题：工作空间名（最多 59 UTF-8 字节）+ 超级智能体团队。 */
export function singleSessionTitle(workspaceName) {
  return `${truncateUtf8(workspaceName ?? '', TITLE_NAME_MAX_BYTES)}${SINGLE_SESSION_TITLE_SUFFIX}`
}

/** 宿主 session-title 的字节上限（cleanTitleText 之后按 UTF-8 截断）。 */
const TITLE_MAX_BYTES = 80
// 除普通控制字符外，方向控制符/零宽字符也不该参与标题比较（宿主 cleanTitleText 同样剔除）。
const TITLE_INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g

/**
 * 与宿主 cleanTitleText 对齐的标题规范化：去 OSC/CSI/控制字符/零宽与方向字符、
 * 空白折叠成单空格、trim，再按 80 字节 UTF-8 截断（截断后 trimEnd）。
 * 对账双方都必须先过这个函数再比较，否则空白的细微差别会被当成「标题被改乱」。
 */
export function normalizeTitleText(text, maxBytes = TITLE_MAX_BYTES) {
  const stripped = String(text ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(TITLE_INVISIBLE_RE, '')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  return truncateUtf8(collapsed, maxBytes).trimEnd()
}

/**
 * 从宿主 session summary 取标题（0.9.4）。
 * 真机上 `list()` 返回的 summary **没有**顶层 title：标题在 `projections.values.title`
 * （可能是字符串，也可能是 { ver, seq, val } 投影项）。旧代码只读 summary.title，
 * 于是 view.title 恒为 null、对账每轮都判定不一致 → 60s rename 风暴。
 */
export function sessionTitleOf(summary) {
  const projected = summary?.projections?.values?.title
  const value = typeof projected === 'string' ? projected : typeof projected?.val === 'string' ? projected.val : null
  if (typeof value === 'string' && value.length > 0) return value
  const direct = summary?.title
  if (typeof direct === 'string' && direct.length > 0) return direct
  return null
}

/**
 * 子会话历史的读取地址（0.9.4）。宿主只承认 subagent 地址：用 `kind:'session'`
 * 读 origin=subagent 的会话会被拒（session/agent-busy「subagent Sessions require
 * their durable parent address」）。mode 传 unknown，让宿主按 descriptor 自行判定，
 * 免得 one-shot/continuable 记错时整个读取失败。
 */
export function childAddressOf(child) {
  const parentSessionId = child?.parentSessionId
  const childSessionId = child?.sessionId
  if (!parentSessionId || !childSessionId) return null
  return { kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }
}

export function createSingleSessionMaintainer({ ctx, config, store, log, redact, deps = {} }) {
  const single = config.singleSession
  const activity = new Map()
  const controller = new AbortController()
  const deleting = new Set()
  const warnedStarted = new Set()
  // 标题对账的退避状态（按 sessionId，内存态）：同一 canonical 连续不一致时
  // rename 间隔 1min → 5min → 30min 递增，绝不允许每轮 60s 无脑重写。
  const titleReconcile = new Map()
  const clock = deps.now ?? (() => Date.now())
  // 无 compaction 引擎的会话只告警一次，别每轮刷屏。
  const warnedNoCompaction = new Set()

  /** agent 当前 preset 的 id：优先宿主 presetForSession，再退 agent 上现成字段。 */
  function presetIdOf(agent) {
    let preset = null
    try {
      preset = api.presetOf(agent)
    } catch {
      preset = null
    }
    if (preset && typeof preset === 'object') preset = preset.id ?? preset.preset?.id ?? null
    if (!preset) {
      const candidate = agent?.preset ?? agent?.presetId ?? agent?.preset?.id ?? null
      preset = candidate && typeof candidate === 'object' ? candidate.id ?? null : candidate
    }
    return typeof preset === 'string' && preset.length > 0 ? preset : null
  }

  const api = {
    listWorkspaces: deps.listWorkspaces ?? (() => ctx.workspaceRegistry?.list?.() ?? []),
    listSessions: deps.listSessions ?? (async () => (await ctx.sessionController.list({}, controller.signal))?.items ?? []),
    getState: deps.getState ?? ((sessionId) => ctx.sessionController.state({ sessionId }, controller.signal)),
    getAgent: deps.getAgent ?? ((sessionId) => ctx.agents?.get?.(sessionId)),
    getPressure: deps.getPressure ?? ((agent) => ctx.tokenMeter?.contextPressure?.(agent.session) ?? {}),
    // D48：compaction 组是隔离 realm，先查 preset 桥登记的服务，再退宿主 serviceFor。
    getCompaction: deps.getCompaction ?? ((agent) => {
      const bridged = compactionEngineFor(presetIdOf(agent))
      if (bridged) return bridged
      return ctx.agentPresets?.serviceFor?.(agent, 'compaction') ?? null
    }),
    readEvents: deps.readEvents ?? (async (sessionId) => (await ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 200 }, controller.signal))?.records ?? []),
    // 读子会话历史（D40 / 0.9.4）。宿主按地址类型校验：origin=subagent 的会话用
    // { kind:'session' } 读会直接抛 session/agent-busy「subagent Sessions require their
    // durable parent address」，旧代码把异常吞成空数组 → 每个子会话都判「读不到事件」、
    // 永远不进工单也不归档。子会话必须走 subagent 地址；mode 传 unknown 让宿主自己判定。
    // D49：同时把整页（含 cursor）带回给诊断，别只留 records。
    readChildPage: deps.readChildPage ?? (async (child) => {
      const address = childAddressOf(child)
      if (!address) return { records: [], page: null }
      const page = await ctx.sessionController.events({ address, maxMessages: 200 }, controller.signal)
      return { records: page?.records ?? [], page }
    }),
    readChildEvents: deps.readChildEvents ?? (async (child) => (await api.readChildPage(child)).records),
    compactRegion: deps.compactRegion ?? ((start, end, agent, engine) => engine.compactRegion(start, end, agent, controller.signal)),
    pinSession: deps.pinSession ?? ((id) => ctx.workspaceRegistry?.pinSession?.(id)),
    unpinSession: deps.unpinSession ?? ((id) => ctx.workspaceRegistry?.unpinSession?.(id)),
    archiveSession: deps.archiveSession ?? ((id) => ctx.workspaceRegistry?.archiveSession?.(id)),
    unarchiveSession: deps.unarchiveSession ?? ((id) => ctx.workspaceRegistry?.unarchiveSession?.(id)),
    // 子会话归档：绕过「有活动就拒绝」的检查（stopActivity），否则空闲判定与宿主的活动窗口会互相卡死。
    archiveChild: deps.archiveChild ?? ((id) => ctx.workspaceRegistry?.archiveSession?.(id, { stopActivity: true })),
    resolveByPath: deps.resolveByPath ?? ((path) => ctx.workspaceRegistry?.resolveByPath?.(path)),
    resolveAgent: deps.resolveAgent ?? ((sessionId) => ctx.sessionController.resolveAgent(sessionId)),
    presetOf: deps.presetOf ?? ((agent) => ctx.agentPresets?.presetForSession?.(agent.session) ?? null),
    selectPreset: deps.selectPreset ?? ((agent, preset) => ctx.agentPresets?.select?.(agent, preset)),
    // 必须把宿主的 resolve 值（{title, seq}）原样交回调用方：canonical 要用宿主 accepted.title。
    renameSession: deps.renameSession ?? (async (args) => await ctx.sessionController.rename(args)),
    isBlank: deps.isBlank ?? ((agent) => (ctx.agents?.turnBoundaryOf?.(agent.session)?.lastTurn ?? 0) === 0),
  }

  // 诊断（0.9.9）：我们自己发出的每一次写操作都留一行，好和宿主的 session/disposed 对齐，
  // 看清「点一下单会话就消失」到底是我们哪一步引起的（pin/select/rename/unarchive）。
  const traceTarget = (args) => {
    const first = args[0]
    if (typeof first === 'string') return first
    const session = first?.session ?? first?.agent?.session
    if (session?.id) return session.id
    if (first?.sessionId) return first.sessionId
    if (first?.id) return first.id
    return ''
  }
  const traced = (label, fn) => async (...args) => {
    if (single?.enabled) log?.('single-session', `trace CALL ${label} ${String(traceTarget(args))}`)
    return await fn(...args)
  }
  api.pinSession = traced('pin', api.pinSession)
  api.unpinSession = traced('unpin', api.unpinSession)
  api.unarchiveSession = traced('unarchive', api.unarchiveSession)
  api.archiveSession = traced('archive', api.archiveSession)
  api.archiveChild = traced('archiveChild', api.archiveChild)
  api.selectPreset = traced('selectPreset', api.selectPreset)
  api.renameSession = traced('rename', api.renameSession)

  store.state.singleSessions ??= {}

  // 刚 rename 完先等一个观察窗口：宿主 summary 投影可能滞后一拍，
  // 把这种滞后当成「标题被改乱」就会每轮重写。
  const TITLE_SETTLE_MS = 5_000
  const TITLE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]
  // D49：未知子会话最多重试 8 次；到顶后转人工清单，不再每轮读。
  const maxUnknownAttempts = 8
  function titleRetryDelayMs(attempts) {
    const index = Math.max(0, Math.min(attempts - 1, TITLE_RETRY_DELAYS_MS.length - 1))
    return TITLE_RETRY_DELAYS_MS[index]
  }

  /** 「preset 未恢复」要能被面板/状态看到：写既有 lastError，并留一条按工作区的记录。 */
  function recordRestore(workspaceId, reason) {
    store.state.singleSessionRestore ??= {}
    store.state.singleSessionRestore[workspaceId] = { ok: false, reason, at: Date.now() }
    store.state.lastError = `single-session: preset 未恢复（${workspaceId}: ${reason}）`
    store.save()
  }
  function clearRestore(workspaceId) {
    if (store.state.singleSessionRestore) delete store.state.singleSessionRestore[workspaceId]
  }

  const isRegistered = (sessionId) => Object.values(store.state.singleSessions).includes(sessionId)
  const workspaceOf = (sessionId) => Object.entries(store.state.singleSessions).find(([, id]) => id === sessionId)?.[0] ?? null
  const isDeleting = (sessionId) => deleting.has(sessionId)
  const sessionFor = (workspaceId) => store.state.singleSessions[workspaceId] ?? null

  /** 会话 cwd → 工作区 id：先按 list() 的路径精确匹配，再退宿主的 resolveByPath。 */
  async function workspaceIdOfCwd(cwd) {
    if (!cwd) return null
    const list = api.listWorkspaces() ?? []
    const hit = list.find((item) => norm(item.path) === norm(cwd))
    if (hit?.id) return hit.id
    try {
      return (await api.resolveByPath(cwd))?.id ?? null
    } catch {
      return null
    }
  }

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
    if (!workspaceId && summary.cwd) workspaceId = await workspaceIdOfCwd(summary.cwd)
    if (!workspaceId) throw Object.assign(new Error('这个会话不属于任何工作区，不能登记为单会话'), { code: 'no-workspace' })
    const occupant = store.state.singleSessions[workspaceId]
    if (occupant && occupant !== sessionId) {
      throw Object.assign(new Error(`该工作区已有单会话：${occupant}`), { code: 'workspace-occupied' })
    }
    // 宿主只允许在会话首轮之前切换 preset（select 会以 “This session has already started” 拒绝），
    // 所以登记必须在空会话上完成：否则登记成功但调度者身份切不上，看起来还是普通会话自己干活。
    const resolved = await api.resolveAgent(sessionId)
    const agent = resolved && !('error' in resolved) ? resolved.agent : null
    if (!agent) throw Object.assign(new Error('这个会话不在运行中：先打开它，再点亮超级智能体图标'), { code: 'no-agent' })
    if (!api.isBlank(agent)) {
      throw Object.assign(
        new Error('这个会话已经开始了，宿主不允许中途切换预设。请新建一个空白会话，先点亮图标，再发第一条消息。'),
        { code: 'started' },
      )
    }
    store.state.singleSessions[workspaceId] = sessionId
    store.save()
    try {
      await api.pinSession(sessionId)
    } catch (error) {
      // pin 失败就当场撤销登记（与 preset 切失败同样处理），别留下“登记了但钉不住”的假象。
      delete store.state.singleSessions[workspaceId]
      store.save()
      try {
        await api.unpinSession(sessionId)
      } catch {}
      const reason = redact?.(error?.message) ?? error?.message ?? String(error)
      log?.('single-session', `pin failed ${sessionId}: ${reason}`)
      throw Object.assign(new Error(`pin 单会话失败：${reason}`), { code: 'pin-failed' })
    }
    // 切到纯调度 preset（D30 dispatcher）：单会话只派活、不动手；worker 由 startActivation 显式带 worker preset，不靠继承。
    try {
      const previous = api.presetOf(agent)
      const wanted = single.preset
      if (wanted && previous !== wanted) {
        await api.selectPreset(agent, wanted)
        if (previous) {
          store.state.singleSessionPrevPreset ??= {}
          store.state.singleSessionPrevPreset[workspaceId] = previous
        }
        log?.('single-session', `preset → ${wanted} for ${sessionId}`)
      }
    } catch (error) {
      // 切不上就当场撤销登记，别留下“登记了但没生效”的假象。
      delete store.state.singleSessions[workspaceId]
      store.save()
      try {
        await api.unpinSession(sessionId)
      } catch {}
      const reason = redact?.(error?.message) ?? error?.message ?? String(error)
      log?.('single-session', `preset switch failed ${sessionId}: ${reason}`)
      throw Object.assign(new Error(`切换单会话 preset（${single.preset}）失败：${reason}`), { code: 'preset-failed' })
    }
    // 标题固定成「<工作空间名称>超级智能体团队」。标题是装饰性失败点：失败只记日志，不撤销登记。
    // canonical 必须存宿主 **返回值**：宿主会做 cleanTitleText 规范化并按 maxTitleBytes 截断，
    // 拿自算标题当 canonical 会让 maintain 每轮判定不一致而重写（rename 风暴）。
    store.state.singleSessionTitles ??= {}
    const workspace = (api.listWorkspaces() ?? []).find((item) => item.id === workspaceId)
    const wanted = singleSessionTitle(workspace?.title ?? workspace?.name ?? '')
    store.state.singleSessionTitles[workspaceId] = wanted
    store.save()
    try {
      const accepted = await api.renameSession({ sessionId, title: wanted })
      // 没有返回值（undefined / 非字符串 / 空串）才回落用自算标题。
      const title = typeof accepted?.title === 'string' && accepted.title.length > 0 ? accepted.title : wanted
      if (title !== wanted) {
        store.state.singleSessionTitles[workspaceId] = title
        store.save()
        log?.('single-session', `title normalized ${sessionId}: ${wanted} → ${title}`)
      }
      // 记下「已发过的规范化标题」，下一轮对账据此退避，不再把投影滞后当改乱。
      titleReconcile.set(sessionId, { desired: normalizeTitleText(title), attempts: 1, lastSentAt: clock() })
      log?.('single-session', `title → ${title} for ${sessionId}`)
    } catch (error) {
      const reason = redact?.(error?.message) ?? error?.message ?? String(error)
      log?.('single-session', `title failed ${sessionId}: ${reason}`)
    }
    log?.('single-session', `registered ${sessionId} → workspace ${workspaceId}`)
    return { ok: true, workspaceId, sessionId }
  }

  /** 解除登记（不归档）；用于控制台删除的第一步或用户主动解除。 */
  async function unregister(sessionId) {
    const workspaceId = workspaceOf(sessionId)
    if (!workspaceId) return { ok: true, already: true }
    delete store.state.singleSessions[workspaceId]
    titleReconcile.delete(sessionId)
    store.save()
    try {
      await api.unpinSession(sessionId)
    } catch (error) {
      log?.('single-session', `unpin failed ${sessionId}: ${error?.message ?? error}`)
    }
    log?.('single-session', `unregistered ${sessionId} (workspace ${workspaceId})`)
    // 解除即恢复原来的 preset（会话还活着才切）；best-effort：失败重试一次，结果落可读状态。
    try {
      const previous = store.state.singleSessionPrevPreset?.[workspaceId]
      if (previous) {
        const resolved = await api.resolveAgent(sessionId)
        if (resolved && !('error' in resolved) && resolved.agent) {
          if (!api.isBlank(resolved.agent)) {
            log?.('single-session', `preset restore skipped ${sessionId}: session already started`)
            recordRestore(workspaceId, 'started')
          } else {
            let lastError = null
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                await api.selectPreset(resolved.agent, previous)
                lastError = null
                break
              } catch (error) {
                lastError = error
              }
            }
            if (lastError) throw lastError
            delete store.state.singleSessionPrevPreset[workspaceId]
            clearRestore(workspaceId)
            store.save()
            log?.('single-session', `preset restored → ${previous} for ${sessionId}`)
          }
        } else {
          log?.('single-session', `preset restore skipped ${sessionId}: session not live`)
          recordRestore(workspaceId, 'not-live')
        }
      }
    } catch (error) {
      const reason = redact?.(error?.message) ?? error?.message ?? String(error)
      recordRestore(workspaceId, reason)
      log?.('single-session', `preset restore failed ${sessionId}: ${reason}`)
    }
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

  /** 子会话闲置多久算“用完了”：拿 updatedAt（宿主给的是毫秒）。 */
  function childAgeMs(child) {
    const at = num(child?.updatedAt, 0)
    return at > 0 ? Math.max(0, Date.now() - at) : 0
  }

  /** 归档子会话；失败退避（3 次 + 10 分钟窗口）与失败话术都收在 child-archive.js（D51 共用）。 */
  async function archiveChild(sessionId, reason) {
    return archiveChildSession({
      state: store.state,
      save: () => store.save(),
      log: (message) => log?.('single-session', message),
      redact,
      archive: api.archiveChild,
    }, sessionId, reason)
  }

  /**
   * D51 兜底：结算归档漏掉的（或本版之前的）一次性 worker，终态且超过
   * `singleSession.workerArchiveDays` 天后批量归档。只认 `origin==='subagent'`
   * 且有 parent 的子会话；常驻角色是顶层会话、id 以 `role-` 开头且在 `state.roles`
   * 登记，命中直接跳过，绝不进这个集合。
   */
  async function purgeStaleWorkers() {
    if (single.workerArchive === false) return { total: 0, archived: 0, failed: [] }
    const days = Number.isFinite(single.workerArchiveDays) && single.workerArchiveDays >= 0
      ? single.workerArchiveDays
      : 3
    const cutoff = Date.now() - days * 24 * 60 * 60_000
    let sessions = []
    try {
      sessions = (await api.listSessions()) ?? []
    } catch (error) {
      log?.('single-session', `stale workers list failed: ${error?.message ?? error}`)
      return { total: 0, archived: 0, failed: [] }
    }
    const roleIds = new Set(Object.values(store.state.roles ?? {}))
    const targets = sessions.filter((item) => {
      if (!item?.sessionId || !item.parentSessionId || item.origin !== 'subagent') return false
      if (item.running) return false
      if (String(item.sessionId).startsWith('role-') || roleIds.has(item.sessionId)) return false
      const at = num(item.updatedAt, 0)
      return at > 0 && at <= cutoff
    })
    let archived = 0
    const failed = []
    for (const item of targets) {
      if (await archiveChild(item.sessionId, 'stale')) archived += 1
      else failed.push(item.sessionId)
    }
    if (targets.length > 0) log?.('single-session', `purged stale workers: ${archived}/${targets.length}`)
    return { total: targets.length, archived, failed }
  }

  /**
   * 单会话直派的子会话 → 工单（D40 / v2.12）。
   * - 真的是工单（有工具调用或任务内容够长）：登记进 state.tickets，可见可汇报；
   * - 噪音（回声/占位）：不建工单，空闲即归档；
   * 两类都在空闲 childIdleMinutes 后归档，子会话不再一直挂着。
   */
  /**
   * D49：空页/未知子会话的诊断快照。一次性写进 unknown state，便于事后区分
   * 「宿主观测层没给」与「地址/权限不对」，而不是只留一句日志。
   */
  async function diagnoseUnknownChild(child, records, page) {
    const diagnostics = {
      at: Date.now(),
      cursor: page?.cursor ?? null,
      records: records?.length ?? 0,
      running: child?.running === true,
      eventCount: null,
    }
    try {
      const state = await api.getState(child.sessionId)
      diagnostics.eventCount = Number.isFinite(state?.eventCount) ? state.eventCount : null
      diagnostics.stateCursor = state?.cursor ?? null
    } catch (error) {
      diagnostics.stateError = error?.message ?? String(error)
    }
    return diagnostics
  }

  /** D49：喂给状态面板的未知子会话清单（terminal 的也保留，等人处理）。 */
  function unknownChildren() {
    const seen = store.state.singleSessionChildUnknown ?? {}
    return Object.entries(seen).map(([sessionId, entry]) => ({
      sessionId,
      title: entry?.title ?? '',
      firstAt: entry?.firstAt ?? null,
      lastAt: entry?.lastAt ?? entry?.at ?? null,
      attempts: entry?.attempts ?? 0,
      terminal: entry?.terminal === true,
      diagnostics: entry?.diagnostics ?? null,
    }))
  }

  async function reconcileChildren(view) {
    if (!single.adoptChildren) return { adopted: 0, cleaned: 0, total: 0 }
    const parent = view.sessionId
    let all = []
    try {
      all = (await api.listSessions()) ?? []
    } catch (error) {
      log?.('single-session', `children list failed ${parent}: ${error?.message ?? error}`)
      return { adopted: 0, cleaned: 0, total: 0 }
    }
    const children = all.filter((item) => item?.parentSessionId === parent && item?.origin === 'subagent')
    const known = new Set(
      Object.values(store.state.tickets ?? {}).map((ticket) => ticket?.childSessionId).filter(Boolean),
    )
    const noise = (store.state.singleSessionChildNoise ??= {})
    let adopted = 0
    let cleaned = 0
    for (const child of children) {
      if (!child?.sessionId) continue
      const id = childTicketId(child.sessionId)
      const ticket = store.state.tickets?.[id]
      // 已被插件工单管线占用（例如 executor 派的 worker）就别重复纳管。
      if (!ticket && known.has(child.sessionId)) continue
      if (!ticket) {
        // 已判过噪音的子会话：不再重读事件，空闲就归档。
        if (noise[child.sessionId]) {
          if (!child.running && (await archiveChild(child.sessionId, `noise:${noise[child.sessionId]}`))) cleaned += 1
          continue
        }
        let records = []
        let page = null
        try {
          const read = await api.readChildPage(child)
          records = read?.records ?? []
          page = read?.page ?? null
        } catch (error) {
          // 读失败也要留证据：旧版本静默吞掉「地址不对」的异常，结果永远判 unknown。
          records = []
          page = null
          log?.('single-session', `child ${child.sessionId}: 读取失败 ${error?.code ?? ''} ${error?.message ?? error}`)
        }
        const cls = classifyChild({ records, label: sessionTitleOf(child) ?? child.label ?? '' })
        if (cls.unknown) {
          // 读不到事件：判不了就不动，更不许当噪音归档；但要过一阵重试，
          // 否则子会话一旦错过一次（还没恢复/正在写入）就永远不进工单。
          // D49：最多 8 次，之后标 terminal 转人工清单，不再无限重试。
          const seen = (store.state.singleSessionChildUnknown ??= {})
          const prev = seen[child.sessionId]
          if (prev?.terminal) continue
          const now = Date.now()
          const attempts = Math.min((prev?.attempts ?? 0) + 1, maxUnknownAttempts)
          const wait = Math.min(10 * 60_000, 60_000 * attempts)
          if (!prev || now - (prev.at ?? 0) >= wait) {
            const terminal = attempts >= maxUnknownAttempts
            const diagnostics = prev?.diagnostics ?? (await diagnoseUnknownChild(child, records, page))
            seen[child.sessionId] = {
              firstAt: prev?.firstAt ?? now,
              at: now,
              lastAt: now,
              attempts,
              terminal,
              title: sessionTitleOf(child) ?? child.label ?? '',
              diagnostics,
            }
            store.save()
            log?.(
              'single-session',
              terminal
                ? `child ${child.sessionId}: 读不到事件，转人工清单（第 ${attempts} 次）`
                : `child ${child.sessionId}: 读不到事件，先不动（第 ${attempts} 次）`,
            )
          }
          continue
        }
        delete (store.state.singleSessionChildUnknown ?? {})[child.sessionId]
        if (!cls.ticket) {
          noise[child.sessionId] = cls.reason
          store.save()
          if (!child.running && (await archiveChild(child.sessionId, `noise:${cls.reason}`))) cleaned += 1
          continue
        }
        const doc = childTicketDoc({
          childSessionId: child.sessionId,
          parentSessionId: parent,
          workspaceId: view.workspaceId,
          label: sessionTitleOf(child) ?? child.label ?? '',
          records,
          running: child.running === true,
        })
        store.state.tickets ??= {}
        store.state.tickets[id] = doc
        delete noise[child.sessionId]
        adopted += 1
        log?.('single-session', `adopted child ${child.sessionId} as ${id} (${cls.reason})`)
        if (doc.status === 'running' && deps.relay) {
          try {
            await deps.relay.send(doc, 'started')
          } catch (error) {
            log?.('single-session', `child relay started failed ${child.sessionId}: ${error?.message ?? error}`)
          }
        }
        store.save()
        continue
      }
      // 已纳管的子会话跑完了：工单转 done 并汇报一次（relay 自身幂等）。
      if (ticket.status === 'running' && !child.running) {
        markDone(ticket, { status: 'done', summary: `子智能体已完成：${ticket.title}`, question: '', link: '' })
        store.save()
        if (deps.relay) {
          try {
            await deps.relay.send(ticket, 'done')
          } catch (error) {
            log?.('single-session', `child relay done failed ${child.sessionId}: ${error?.message ?? error}`)
          }
        }
      }
      // 用完了就归档：空闲 childIdleMinutes（默认 2 分钟）即可。
      if (!child.running && !ticket.archivedAt && childAgeMs(child) >= single.childIdleMinutes * 60_000) {
        if (await archiveChild(child.sessionId, 'idle')) {
          ticket.archivedAt = Date.now()
          cleaned += 1
          store.save()
        }
      }
    }
    return { adopted, cleaned, total: children.length }
  }

  /** 每轮维护：只对已登记单会话做压缩，不再自动建会话。 */
  async function maintain() {
    // D51：即使单会话模式没开，delegate 派过 worker 也要能兜底清过期终态。
    let staleWorkers = { total: 0, archived: 0, failed: [] }
    try {
      staleWorkers = await purgeStaleWorkers()
    } catch (error) {
      log?.('single-session', `purge stale workers failed: ${error?.message ?? error}`)
    }
    if (!single.enabled) return { enabled: false, workspaces: [], staleWorkers }
    const entries = await list()
    const views = []
    for (const entry of entries) {
      const view = await inspect(entry)
      // D26：登记会话若被归档过（侧栏看不见），每轮维护把它 unarchive + 重新 pin 回来。
      try {
        await ensureVisible(view.sessionId)
      } catch (error) {
        log?.('single-session', `ensure visible failed: ${error?.message ?? error}`)
      }
      // 标题对账：只在会话活着（inspect 已拿到 agent）时重写；先规范化比对，避免每轮无谓 rename。
      // 宿主可能把标题规范化/截断：rename 成功后以返回值为新 canonical。
      try {
        store.state.singleSessionTitles ??= {}
        let canonical = store.state.singleSessionTitles[view.workspaceId]
        let dirty = false
        if (!canonical) {
          canonical = singleSessionTitle(view.workspaceName)
          store.state.singleSessionTitles[view.workspaceId] = canonical
          dirty = true
        }
        const desired = normalizeTitleText(canonical)
        // view.title 来自 sessionTitleOf()：真机在 projections.values.title；null 表示读不到标题。
        const current = view.title === null || view.title === undefined ? null : normalizeTitleText(view.title)
        const record = titleReconcile.get(view.sessionId)
        if (current !== null && current === desired) {
          // 已经一致：清掉退避记录，下次真被改乱时能立刻重写。
          titleReconcile.delete(view.sessionId)
        } else if (view.agent && current !== null) {
          let waitMs = 0
          if (record && record.desired === desired) {
            const since = clock() - record.lastSentAt
            if (since < TITLE_SETTLE_MS) waitMs = TITLE_SETTLE_MS - since
            else if (record.attempts >= 1 && since < titleRetryDelayMs(record.attempts)) {
              waitMs = titleRetryDelayMs(record.attempts) - since
            }
          }
          if (waitMs === 0) {
            const accepted = await api.renameSession({ sessionId: view.sessionId, title: desired })
            const title = typeof accepted?.title === 'string' && accepted.title.length > 0 ? accepted.title : desired
            const normalized = normalizeTitleText(title)
            const previousAttempts = record && record.desired === desired ? record.attempts : 0
            titleReconcile.set(view.sessionId, { desired: normalized, attempts: previousAttempts + 1, lastSentAt: clock() })
            view.title = title
            dirty = true
            if (normalized !== desired) {
              // 返回值 ≠ 传入值：以返回值为准；canonical 更新后下一轮不再 rename。
              canonical = title
              store.state.singleSessionTitles[view.workspaceId] = canonical
              log?.('single-session', `title normalized ${view.sessionId}: rejected input, canonical → ${canonical}`)
            } else {
              log?.('single-session', `title reconciled ${view.sessionId} → ${canonical}${previousAttempts > 0 ? ` (retry ${previousAttempts + 1})` : ''}`)
            }
          }
        }
        if (dirty) store.save()
      } catch (error) {
        log?.('single-session', `title reconcile failed ${view.sessionId}: ${redact?.(error?.message) ?? error?.message ?? String(error)}`)
      }
      // 已登记但 preset 不是调度者（例如登记发生在旧版本）：补切一次。
      try {
        const agent = view.agent
        if (agent && single.preset && api.presetOf(agent) !== single.preset) {
          if (!api.isBlank(agent)) {
            // 已经开始的会话无法再切 preset（宿主限制），只提示一次，不再每轮刷日志。
            if (!warnedStarted.has(view.sessionId)) {
              warnedStarted.add(view.sessionId)
              log?.('single-session', `preset reconcile skipped ${view.sessionId}: session already started`)
            }
          } else {
            await api.selectPreset(agent, single.preset)
            log?.('single-session', `preset → ${single.preset} for ${view.sessionId} (reconcile)`)
          }
        }
      } catch (error) {
        log?.('single-session', `preset reconcile failed ${view.sessionId}: ${error?.message ?? error}`)
      }
      // 子会话对账：直派的子智能体纳管成工单，空闲的（含噪音）归档。
      try {
        view.children = await reconcileChildren(view)
      } catch (error) {
        log?.('single-session', `children reconcile failed ${view.sessionId}: ${error?.message ?? error}`)
      }
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
          if (error?.code === 'no-compaction') {
            // D48：引擎没接上时每会话只告警一次，别每轮刷。
            if (!warnedNoCompaction.has(view.sessionId)) {
              warnedNoCompaction.add(view.sessionId)
              store.state.lastError = `single-session: ${view.error}`
              store.save()
              log?.('single-session', `compact skipped ${view.sessionId}: no compaction engine（后续不再重复告警）`)
            }
          } else {
            store.state.lastError = `single-session: ${view.error}`
            store.save()
            log?.('single-session', `compact failed ${view.sessionId}: ${view.error}`)
          }
        }
      }
      views.push(publicView(view))
    }
    return { enabled: true, workspaces: views, staleWorkers }
  }

  function publicView(view) {
    const { agent, ...rest } = view
    return rest
  }

  /**
   * 宿主里别的东西（新建会话的 preset 座位、设置里的“设为默认”）会在登记后把 preset 改回去，
   * 而会话一旦开始就再也切不回来。所以空会话上一旦发现漂移，立刻纠回 single.preset。
   */
  const presetReverts = new Map()
  async function onPresetSelected(sessionId, preset) {
    if (!single?.enabled || !single.preset) return { ok: true, ignored: 'disabled' }
    if (!isRegistered(sessionId)) return { ok: true, ignored: 'not-registered' }
    if (preset === single.preset) return { ok: true, ignored: 'same' }
    const attempts = presetReverts.get(sessionId) ?? 0
    if (attempts >= 3) return { ok: false, ignored: 'looping' }
    try {
      const resolved = await api.resolveAgent(sessionId)
      const agent = resolved && !('error' in resolved) ? resolved.agent : null
      if (!agent) {
        log?.('single-session', `preset drift ${sessionId}: ${preset} → ${single.preset} skipped, no agent`)
        return { ok: false, ignored: 'no-agent' }
      }
      if (!api.isBlank(agent)) {
        if (!warnedStarted.has(sessionId)) {
          warnedStarted.add(sessionId)
          log?.('single-session', `preset drift ${sessionId}: ${preset} → ${single.preset} skipped, session already started`)
        }
        return { ok: false, ignored: 'started' }
      }
      presetReverts.set(sessionId, attempts + 1)
      await api.selectPreset(agent, single.preset)
      log?.('single-session', `preset reverted ${preset} → ${single.preset} for ${sessionId}`)
      return { ok: true, reverted: true }
    } catch (error) {
      log?.('single-session', `preset drift fix failed ${sessionId}: ${error?.message ?? error}`)
      return { ok: false, ignored: 'error' }
    }
  }

  /**
   * 让已登记的单会话在侧栏可见（0.9.8 / D26）。
   * 宿主的 pinSession 会对「已归档」的会话直接拒绝——因此它就是归档探针：
   * pin 失败 → unarchive → 再 pin，把被归档的登记会话重新钉回侧栏。
   * 每轮维护只对登记会话调用，pin 已存在时宿主幂等返回，不写盘。
   */
  async function ensureVisible(sessionId) {
    if (!sessionId || typeof api.pinSession !== 'function' || typeof api.unarchiveSession !== 'function') return { ok: true, skipped: 'no-api' }
    try {
      await api.pinSession(sessionId)
      return { ok: true, pinned: true }
    } catch (first) {
      try {
        await api.unarchiveSession(sessionId)
        await api.pinSession(sessionId)
        log?.('single-session', `restored visibility: ${sessionId}`)
        return { ok: true, restored: true }
      } catch (error) {
        const message = redact?.(error?.message ?? first?.message) ?? String(error?.message ?? first?.message ?? error)
        log?.('single-session', `restore visibility ${sessionId} failed: ${message}`)
        return { ok: false, ignored: 'error' }
      }
    }
  }

  /**
   * 已登记的单会话被归档就立刻恢复（0.9.7 / D26）。
   * 登记后「禁止入档」目前只靠 `workspace/session-activity` 拦截；一旦宿主调用带
   * `stopActivity: true`（侧栏「停止并归档」、她自己的测试路径），活动检查被跳过，
   * 保护失效。归档是软删、可 unarchive，所以这里在归档后把它拉回来，保住登记。
   * 控制台走「解除单会话」时 `deleting` 里有 id，不恢复（那是用户明确要归档）。
   */
  async function onArchived(request) {
    const sessionId = typeof request === 'string' ? request : request?.sessionId
    if (!sessionId) return { ok: true, ignored: 'no-session' }
    if (!single?.enabled) return { ok: true, ignored: 'disabled' }
    if (!isRegistered(sessionId)) return { ok: true, ignored: 'not-registered' }
    if (deleting.has(sessionId)) return { ok: true, ignored: 'deleting' }
    try {
      await api.unarchiveSession(sessionId)
      log?.('single-session', `archived registered session restored: ${sessionId}`)
      return { ok: true, restored: true }
    } catch (error) {
      const message = redact?.(error?.message) ?? error?.message ?? String(error)
      log?.('single-session', `restore archived session ${sessionId} failed: ${message}`)
      return { ok: false, ignored: 'error' }
    }
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
        title: sessionTitleOf(summary),
        updatedAt: num(summary?.updatedAt, 0),
        archived: summary?.archived === true,
        missing: !summary,
      })
    }
    return out
  }

  /**
   * D46：常驻角色会话的压缩入口（角色不是「已登记单会话」，但用同一套 compaction 服务）。
   * 只在上下文占用超过 single.pressureRatio 时压，避免每轮任务都多烧一次模型调用。
   */
  async function compactSession(sessionId, { reason = 'role-idle', force = false } = {}) {
    let agent = null
    try {
      agent = (await api.resolveAgent(sessionId))?.agent ?? null
    } catch {
      agent = null
    }
    if (!agent) throw Object.assign(new Error('会话不在宿主里（可能已关闭），无法压缩'), { code: 'not-live' })
    const pressure = api.getPressure(agent) ?? {}
    const ratio = num(pressure.contextWindow, 0) > 0 ? num(pressure.pressureTokens, 0) / pressure.contextWindow : 0
    if (!force && ratio < single.pressureRatio) return { skipped: true, reason: 'below-threshold' }
    return compactOne({ sessionId, agent, pressureTokens: num(pressure.pressureTokens, 0) }, reason)
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
    if (!ownWorkspaceId && summary?.cwd) ownWorkspaceId = await workspaceIdOfCwd(summary.cwd)
    const occupant = ownWorkspaceId ? store.state.singleSessions[ownWorkspaceId] ?? null : null
    return {
      enabled: single.enabled,
      registered: Boolean(workspaceId),
      workspaceId: ownWorkspaceId,
      workspaceOccupied: Boolean(occupant && occupant !== sessionId),
      occupant,
      found: Boolean(summary),
      cwd: summary?.cwd ?? null,
    }
  }

  /** 清理历史自动建的 intake-* 会话（旧版本遗留）：先注销登记，再归档。 */
  async function purgeLegacy() {
    const sessions = await api.listSessions()
    const targets = sessions.filter((item) => String(item.sessionId).startsWith('intake-'))
    let archived = 0
    const failed = []
    for (const item of targets) {
      try {
        if (isRegistered(item.sessionId)) await unregister(item.sessionId)
        await api.archiveSession(item.sessionId)
        archived += 1
      } catch (error) {
        failed.push({ sessionId: item.sessionId, error: redact?.(error?.message ?? String(error)) ?? String(error) })
      }
    }
    log?.('single-session', `purged legacy intakes: ${archived}/${targets.length}`)
    return { total: targets.length, archived, failed }
  }

  return {
    register, unregister, removeSingle, isRegistered, isDeleting, workspaceOf, sessionFor,
    maintain, onPresetSelected, onArchived, ensureVisible, snapshot, list, stateOf, compactManual, compactSession, purgeLegacy, purgeStaleWorkers, reconcileChildren,
    unknownChildren,
    dispose() { controller.abort() },
  }
}

/**
 * 宿主 workspace/session-activity 钩子：已登记（且不是控制台删除中）的单会话上报“有活动”，
 * 让宿主的 archiveSession 拒绝入档/删除。
 */
export async function guardSessionActivity(maintainer, { sessionId } = {}, next) {
  const rest = await next()
  if (!maintainer?.isRegistered?.(sessionId) || maintainer?.isDeleting?.(sessionId)) return rest
  return [{ kind: 'turn' }, ...(rest ?? [])]
}
