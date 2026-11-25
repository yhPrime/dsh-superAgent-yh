/**
 * 单会话登记表（v2.7）：单会话由人手动新建会话后点亮胶囊登记，
 * 插件不再自动建会话；单个工作区最多一个单会话；登记后禁止入档/删除（只能从控制台解除）。
 * 压缩仍复用宿主 compaction / tokenMeter。
 *
 * v2.12 / D40：单会话直派的子会话（subagent 工具）不经过工单管线，也不会被宿主归档。
 * 这里把它们按「真的是工单」判定后纳管成工单，并在空闲后归档，避免越挂越多。
 */
import { childTicketDoc, childTicketId, classifyChild } from './child-tickets.js'
import { markDone } from './ticket.js'

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

export function createSingleSessionMaintainer({ ctx, config, store, log, redact, deps = {} }) {
  const single = config.singleSession
  const activity = new Map()
  const controller = new AbortController()
  const deleting = new Set()
  const warnedStarted = new Set()

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

  store.state.singleSessions ??= {}

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

  /** 归档子会话；失败退避（3 次 + 10 分钟窗口），避免每轮刷日志。 */
  async function archiveChild(sessionId, reason) {
    const failures = (store.state.singleSessionChildArchive ??= {})
    const record = failures[sessionId]
    if (record && record.attempts >= 3 && Date.now() - record.at < 10 * 60_000) return false
    try {
      await api.archiveChild(sessionId)
      delete failures[sessionId]
      store.save()
      log?.('single-session', `archived child ${sessionId} (${reason})`)
      return true
    } catch (error) {
      const message = redact?.(error?.message) ?? error?.message ?? String(error)
      failures[sessionId] = { attempts: (record?.attempts ?? 0) + 1, at: Date.now() }
      store.state.lastError = `single-session: 子会话归档失败（${sessionId}）：${message}`
      store.save()
      log?.('single-session', `archive child ${sessionId} failed: ${message}`)
      return false
    }
  }

  /**
   * 单会话直派的子会话 → 工单（D40 / v2.12）。
   * - 真的是工单（有工具调用或任务内容够长）：登记进 state.tickets，可见可汇报；
   * - 噪音（回声/占位）：不建工单，空闲即归档；
   * 两类都在空闲 childIdleMinutes 后归档，子会话不再一直挂着。
   */
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
        try {
          records = await api.readEvents(child.sessionId)
        } catch {
          records = []
        }
        const cls = classifyChild({ records, label: child.title ?? child.label ?? '' })
        if (cls.unknown) {
          // 读不到事件：判不了就不动，更不许当噪音归档。
          const seen = (store.state.singleSessionChildUnknown ??= {})
          if (!seen[child.sessionId]) {
            seen[child.sessionId] = { at: Date.now() }
            store.save()
            log?.('single-session', `child ${child.sessionId}: 读不到事件，先不动`)
          }
          continue
        }
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
          label: child.title ?? child.label ?? '',
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
    if (!single.enabled) return { enabled: false, workspaces: [] }
    const entries = await list()
    const views = []
    for (const entry of entries) {
      const view = await inspect(entry)
      // 标题对账：只在会话活着（inspect 已拿到 agent）时重写；先比对，避免每轮无谓 rename。
      // 宿主可能把标题规范化/截断：rename 成功后以返回值为新 canonical，下一轮自然不再触发。
      try {
        store.state.singleSessionTitles ??= {}
        let canonical = store.state.singleSessionTitles[view.workspaceId]
        let dirty = false
        if (!canonical) {
          canonical = singleSessionTitle(view.workspaceName)
          store.state.singleSessionTitles[view.workspaceId] = canonical
          dirty = true
        }
        if (view.agent && view.title !== canonical) {
          const accepted = await api.renameSession({ sessionId: view.sessionId, title: canonical })
          const title = typeof accepted?.title === 'string' && accepted.title.length > 0 ? accepted.title : canonical
          view.title = title
          dirty = true
          if (title !== canonical) {
            // 返回值 ≠ 传入值：以返回值为准；canonical 更新后下一轮不再 rename，日志只打这一条。
            canonical = title
            store.state.singleSessionTitles[view.workspaceId] = canonical
            log?.('single-session', `title normalized ${view.sessionId}: rejected input, canonical → ${canonical}`)
          } else {
            log?.('single-session', `title reconciled ${view.sessionId} → ${canonical}`)
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
    maintain, onPresetSelected, snapshot, list, stateOf, compactManual, compactSession, purgeLegacy, reconcileChildren,
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
