/**
 * 单会话唯一的派活入口 `delegate`（D43）：
 * - 带 role：交给常驻角色会话（按需创建，不占子智能体名额）；
 * - 不带 role：开一个临时 worker 子智能体（上限 singleSession.maxSubagents，超了排队 FIFO）。
 * 宿主的子智能体名额是全树硬顶，触顶会抛 ACTIVATION_LIMIT_REACHED；这里接住并排队，
 * 等有子会话空闲再继续，避免「一次炸出一堆」和「占位等待」。
 */
import { randomUUID } from 'node:crypto'

import { archiveChildSession } from './child-archive.js'

const FLUSH_MS = 3000

const DELEGATE_TOOL = {
  name: 'delegate',
  description:
    '把一件具体工作派出去执行。带 role 交给常驻角色（同一角色复用同一会话，会带上它的长期笔记）；不带 role 则开临时 worker 子智能体（并发上限 6，超了自动排队）。不要用子智能体做占位或等待：要等就结束本回合。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '完整、自包含的任务说明：工作目录、要做什么、怎么验证。' },
      role: { type: 'string', description: '常驻角色名（可选）。同类活做过两次以上才建角色；名字自己定，建前先看现有角色清单。' },
      cwd: { type: 'string', description: '工作目录（可选，默认单会话所在工作区）。' },
      title: { type: 'string', description: '一句话任务标题（可选，用于面板与日志）。' },
    },
    required: ['prompt'],
  },
}

export function createDelegate({ ctx, config, store, log, redact, roles, getSubagents, archiveSession, workspaceOf }) {
  const limit = Math.max(1, Math.trunc(config.singleSession?.maxSubagents ?? 6))
  const workerArchive = config.singleSession?.workerArchive !== false
  const pending = []
  const inflight = new Map() // childSessionId -> { sessionId, parentSessionId, at }
  const controller = new AbortController()

  const short = (value) => String(value ?? '').slice(0, 40)

  function workspaceIdOf(sessionId) {
    try {
      return workspaceOf?.(sessionId) ?? null
    } catch {
      return null
    }
  }

  async function childrenOf(parentSessionId) {
    const items = (await ctx.sessionController.list({}, controller.signal))?.items ?? []
    return items.filter((item) => item.parentSessionId === parentSessionId)
  }

  /** 当前真实在跑的子会话数（不靠自计数，宿主状态为准，重启/崩溃后也准）。 */
  async function runningCount(parentSessionId) {
    const items = await childrenOf(parentSessionId)
    return items.filter((item) => item.running).length
  }

  async function spawn({ prompt, cwd, title, parent, intakeSessionId }) {
    const subagents = getSubagents()
    if (!subagents?.startActivation) throw new Error('宿主没有 subagents 服务，无法派子智能体')
    const activation = await subagents.startActivation({
      provider: 'spawn',
      parent,
      agentPreset: config.workerPreset,
      name: `deleg-${randomUUID().slice(0, 8)}`,
      label: short(title || prompt),
      cwd,
      prompt: [{ type: 'text', text: String(prompt) }],
      delivery: 'parent',
      // 宿主的 startActivation 要 signal（内部会调 signal.throwIfAborted()），漏传就报
      // 「Cannot read properties of undefined (reading 'throwIfAborted')」。
      signal: controller.signal,
    })
    inflight.set(activation.childId, {
      sessionId: intakeSessionId,
      parentSessionId: parent?.id ?? parent?.session?.id ?? intakeSessionId,
      at: Date.now(),
    })
    try {
      const child = ctx.agents?.get?.(activation.childId)
      if (child) ctx.permissionPresets.set(child.session, 'danger-full-access')
    } catch (error) {
      log?.('delegate', `permission failed: ${error?.message ?? error}`)
    }
    log?.('delegate', `spawned ${activation.childId} for ${intakeSessionId}`)
    return activation
  }

  function enqueue(item) {
    pending.push(item)
    log?.('delegate', `queued (${pending.length}) ${short(item.title || item.prompt)}`)
    return pending.length
  }

  async function flush() {
    while (pending.length > 0) {
      const item = pending[0]
      let running = 0
      try {
        running = await runningCount(item.intakeSessionId)
      } catch (error) {
        log?.('delegate', `flush count failed: ${error?.message ?? error}`)
        return
      }
      if (running >= limit) return
      pending.shift()
      try {
        await spawn(item)
      } catch (error) {
        const code = error?.code ?? ''
        if (String(code) === 'ACTIVATION_LIMIT_REACHED' || String(error?.message ?? '').includes('subagent limit reached')) {
          pending.unshift(item)
          return
        }
        item.fail?.(error)
        log?.('delegate', `spawn failed: ${error?.message ?? error}`)
      }
    }
  }

  const roleIds = () => new Set(Object.values(store?.state?.roles ?? {}))

  function protectedSession(sessionId, ids = roleIds()) {
    return String(sessionId).startsWith('role-') || ids.has(sessionId)
  }

  /** 结算归档前核对宿主状态；列表读不到时退回 spawn 记录（delegate 只派 subagent）。 */
  async function settledDescriptor(childSessionId, record) {
    let info = null
    try {
      const items = (await ctx.sessionController.list({}, controller.signal))?.items ?? []
      info = items.find((item) => item?.sessionId === childSessionId) ?? null
    } catch (error) {
      log?.('delegate', `settled child lookup failed: ${error?.message ?? error}`)
    }
    if (!record?.parentSessionId) return null
    if (info) {
      if (!info.parentSessionId || info.parentSessionId !== record.parentSessionId) return null
      if (info.origin && info.origin !== 'subagent') return null
      if (protectedSession(info.sessionId)) return null
    }
    if (protectedSession(childSessionId)) return null
    return info ?? { sessionId: childSessionId, parentSessionId: record.parentSessionId, origin: 'subagent' }
  }

  /** D51：delegate 派出的一次性 worker 结算即归档（软删，可 unarchive 恢复）。
   * 返回 archived / skip / failed；failed 保留 inflight，交给 3s 扫描按退避重试。 */
  async function archiveSettled(childSessionId, record) {
    if (!workerArchive) return 'skip'
    const info = await settledDescriptor(childSessionId, record)
    if (!info) {
      log?.('delegate', `skip archive ${childSessionId}: not an eligible subagent child`)
      return 'skip'
    }
    const ok = await archiveChildSession({
      state: store.state,
      save: () => store.save(),
      log: (message) => log?.('delegate', message),
      redact,
      archive: (id) => archiveSession?.(id, { stopActivity: true }),
    }, childSessionId, 'settled')
    return ok ? 'archived' : 'failed'
  }

  /**
   * D51 兜底：宿主 `subagent/end` 事件在部分 scope 下收不到时，靠 3s 扫描 inflight
   * 发现 `running === false` 的 worker，走同一条 onChildSettled 归档路径。
   */
  async function reapSettled() {
    if (!workerArchive || inflight.size === 0) return
    let items = []
    try {
      items = (await ctx.sessionController.list({}, controller.signal))?.items ?? []
    } catch (error) {
      log?.('delegate', `settled scan failed: ${error?.message ?? error}`)
      return
    }
    const byId = new Map(items.filter((item) => item?.sessionId).map((item) => [item.sessionId, item]))
    for (const childSessionId of [...inflight.keys()]) {
      const info = byId.get(childSessionId)
      if (info && info.running === false) {
        let outcome = 'failed'
        try {
          outcome = await archiveSettled(childSessionId, inflight.get(childSessionId))
        } catch (error) {
          log?.('delegate', `archive settled child ${childSessionId} failed: ${error?.message ?? error}`)
        }
        if (outcome !== 'failed') inflight.delete(childSessionId)
      }
    }
  }

  const timer = setInterval(() => {
    reapSettled()
      .catch((error) => log?.('delegate', `settled scan crashed: ${error?.message ?? error}`))
      .finally(() => flush().catch((error) => log?.('delegate', `flush crashed: ${error?.message ?? error}`)))
  }, FLUSH_MS)
  timer.unref?.()

  const tool = {
    name: DELEGATE_TOOL.name,
    description: DELEGATE_TOOL.description,
    parameters: DELEGATE_TOOL.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new Error('delegate: prompt 不能为空')
      const agent = exec?.agent ?? null
      const intakeSessionId = agent?.id ?? null
      const workspaceId = intakeSessionId ? workspaceIdOf(intakeSessionId) : null
      const role = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : null
      const title = typeof args.title === 'string' ? args.title : ''
      let cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null

      if (role) {
        const result = await roles.dispatch(role, prompt, {
          workspaceId,
          intakeSessionId,
          workspacePath: cwd,
        })
        return { mode: 'role', ...result }
      }

      if (!cwd) {
        try {
          const items = (await ctx.sessionController.list({}, controller.signal))?.items ?? []
          const self = items.find((item) => item.sessionId === intakeSessionId)
          cwd = self?.cwd ?? process.cwd()
        } catch {
          cwd = process.cwd()
        }
      }

      const item = { prompt, cwd, title, parent: agent, intakeSessionId }
      const running = await runningCount(intakeSessionId).catch(() => 0)
      if (running >= limit) {
        const position = enqueue(item)
        return { mode: 'worker', status: 'queued', position, limit }
      }
      try {
        const activation = await spawn(item)
        return { mode: 'worker', status: 'started', childSessionId: activation.childId, limit }
      } catch (error) {
        const code = String(error?.code ?? '')
        if (code === 'ACTIVATION_LIMIT_REACHED' || String(error?.message ?? '').includes('subagent limit reached')) {
          const position = enqueue(item)
          return { mode: 'worker', status: 'queued', position, limit }
        }
        throw error
      }
    },
  }

  return {
    tool,
    flush,
    snapshot() {
      return { limit, pending: pending.length, pendingTitles: pending.map((item) => short(item.title || item.prompt)) }
    },
    async onChildSettled(childSessionId) {
      const record = inflight.get(childSessionId)
      if (record) {
        let outcome = 'failed'
        try {
          outcome = await archiveSettled(childSessionId, record)
        } catch (error) {
          log?.('delegate', `archive settled child ${childSessionId} failed: ${error?.message ?? error}`)
        }
        // 归档失败时保留 inflight：3s 扫描会按 child-archive 的退避继续重试。
        if (outcome !== 'failed') inflight.delete(childSessionId)
      }
      await flush().catch(() => {})
    },
    dispose() {
      clearInterval(timer)
      controller.abort()
      pending.length = 0
      inflight.clear()
    },
  }
}
