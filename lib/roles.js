/**
 * 常驻角色（D42）：独立会话 + 注册表，不占子智能体名额。
 * - 角色不预置：单会话派活时带 role 名，第一次出现时按需创建（受 maxRoles 硬顶约束）。
 * - 派活 = 往该角色的会话投一条 prompt；插件轮询会话状态，空闲后把最后一条 assistant 文本回报给单会话。
 * - 角色会话不自动归档（D40 的 2 分钟归档只管 subagent 与临时会话）；上下文由维护器压缩。
 */
import { randomUUID } from 'node:crypto'
import { notesBlock, appendJournal } from './role-notes.js'

const POLL_MS = 3000
const TASK_TIMEOUT_MS = 30 * 60 * 1000

export function roleSessionIdOf(role) {
  const slug = String(role).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'role'
  return `role-${slug}-${randomUUID().slice(0, 8)}`
}

export function createRoles({ ctx, config, store, log, redact, deps = {} }) {
  const maxRoles = Math.max(1, Math.trunc(config.singleSession?.maxRoles ?? 6))
  const api = {
    listSessions: deps.listSessions ?? (async () => (await ctx.sessionController.list({}, undefined))?.items ?? []),
    createSession: deps.createSession ?? ((request) => ctx.sessionController.create(request)),
    resolveAgent: deps.resolveAgent ?? ((sessionId) => ctx.sessionController.resolveAgent(sessionId)),
    prompt: deps.prompt ?? ((request) => ctx.sessionController.prompt(request, undefined)),
    getState: deps.getState ?? ((sessionId) => ctx.sessionController.state({ sessionId }, undefined)),
    readEvents: deps.readEvents ?? (async (sessionId) => (await ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: 20 }, undefined))?.records ?? []),
    archiveSession: deps.archiveSession ?? ((sessionId) => ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })),
    workspacePath: deps.workspacePath ?? (async (workspaceId) => (ctx.workspaceRegistry?.list?.() ?? []).find((item) => item.id === workspaceId)?.path ?? null),
    notify: deps.notify ?? (async () => {}),
    ...deps,
  }

  store.state.roles ??= {}
  const roles = store.state.roles
  const watchers = new Map()

  const list = () =>
    Object.entries(roles).map(([role, entry]) => ({
      role,
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      createdAt: entry.createdAt,
      lastTaskAt: entry.lastTaskAt ?? null,
      status: entry.status ?? 'idle',
      lastError: entry.lastError ?? null,
    }))

  async function snapshot() {
    const rows = list()
    const sessions = await api.listSessions().catch(() => [])
    const byId = new Map((sessions ?? []).map((item) => [item.sessionId, item]))
    return rows.map((row) => {
      const item = byId.get(row.sessionId)
      return {
        ...row,
        running: Boolean(item?.running),
        agentAvailable: Boolean(item?.agentAvailable),
        updatedAt: item?.updatedAt ?? null,
      }
    })
  }

  function workspacePathOf(entry) {
    return entry.workspacePath ?? null
  }

  /** 按名取角色；没有就按需创建（上限 6，硬顶）。 */
  async function ensure(role, { workspaceId, workspacePath } = {}) {
    const name = String(role ?? '').trim()
    if (!name) throw Object.assign(new Error('角色名不能为空'), { code: 'role-invalid' })
    const existing = roles[name]
    if (existing) {
      if (workspaceId && existing.workspaceId && existing.workspaceId !== workspaceId) {
        throw Object.assign(new Error(`角色「${name}」绑定在另一个工作区，不能跨区复用`), { code: 'role-other-workspace' })
      }
      return { entry: existing, created: false }
    }
    if (Object.keys(roles).length >= maxRoles) {
      throw Object.assign(new Error(`常驻角色已达上限 ${maxRoles}，先解除一个再建「${name}」`), { code: 'role-limit' })
    }
    if (!workspaceId) throw Object.assign(new Error(`新建角色「${name}」需要工作区`), { code: 'role-no-workspace' })
    const sessionId = roleSessionIdOf(name)
    await api.createSession({ sessionId, workspaceId, agentPreset: config.workerPreset })
    const entry = {
      sessionId, workspaceId, workspacePath: workspacePath ?? (await api.workspacePath(workspaceId)),
      createdAt: Date.now(), status: 'idle',
    }
    roles[name] = entry
    store.save()
    log?.('roles', `created ${name} → ${sessionId} @ ${entry.workspacePath ?? workspaceId}`)
    return { entry, created: true }
  }

  /** 派活：注入笔记 + 投 prompt + 起一个轻量 watcher 等它空闲后回报。 */
  async function dispatch(role, task, { workspaceId, workspacePath, intakeSessionId } = {}) {
    const { entry, created } = await ensure(role, { workspaceId, workspacePath })
    const path = workspacePathOf(entry) ?? workspacePath
    const notes = path ? notesBlock(path, role) : ''
    const text = [notes, String(task ?? '').trim()].filter(Boolean).join('\n\n')
    if (!text) throw Object.assign(new Error('任务内容不能为空'), { code: 'role-empty-task' })
    await api.prompt({
      requestId: `role:${role}:${randomUUID().slice(0, 8)}`,
      sessionId: entry.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
    entry.lastTaskAt = Date.now()
    entry.status = 'running'
    store.save()
    if (path) appendJournal(path, role, `派活：${String(task).replace(/\s+/g, ' ').slice(0, 120)}`)
    log?.('roles', `dispatch ${role} (${entry.sessionId})${created ? ' [new]' : ''}`)
    watch(role, entry, { intakeSessionId, path })
    return { role, sessionId: entry.sessionId, created }
  }

  /** 等角色空闲：轮询 state，空闲后取最后一条 assistant 文本回报给单会话。 */
  function watch(role, entry, { intakeSessionId, path }) {
    if (watchers.has(role)) return
    const startedAt = Date.now()
    let seenRun = false
    const timer = setInterval(async () => {
      try {
        if (Date.now() - startedAt > TASK_TIMEOUT_MS) {
          finish({ ok: false, reason: 'watch timeout' })
          return
        }
        const state = await api.getState(entry.sessionId)
        if (state?.running || state?.active) {
          seenRun = true
          return
        }
        if (!seenRun) return // 还没跑起来，别把上一轮的 idle 当完成
        const text = await lastAssistantText(entry.sessionId)
        finish({ ok: true, text })
      } catch (error) {
        finish({ ok: false, reason: error?.message ?? String(error) })
      }
    }, POLL_MS)
    timer.unref?.()
    watchers.set(role, timer)

    function finish({ ok, text, reason }) {
      clearInterval(timer)
      watchers.delete(role)
      entry.status = ok ? 'idle' : 'failed'
      if (ok) delete entry.lastError
      else entry.lastError = reason
      store.save()
      if (path) appendJournal(path, role, ok ? `完成：${String(text ?? '').slice(0, 120)}` : `失败：${reason}`)
      if (intakeSessionId) {
        const body = ok
          ? `【角色 ${role} 回报】\n${String(text ?? '（无文本输出）').slice(0, 2000)}`
          : `【角色 ${role} 失败】${reason}`
        Promise.resolve(api.notify(intakeSessionId, body)).catch(() => {})
      }
      if (ok && api.compact) {
        Promise.resolve(api.compact(entry.sessionId)).catch((error) => {
          log?.('roles', `compact ${role} failed: ${error?.message ?? error}`)
        })
      }
      log?.('roles', `${role} ${ok ? 'done' : 'failed'}${reason ? `: ${reason}` : ''}`)
    }
  }

  async function lastAssistantText(sessionId) {
    const records = await api.readEvents(sessionId)
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record?.type !== 'assistant/message') continue
      const parts = record.data?.message?.content ?? []
      const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n').trim()
      if (text) return text
    }
    return ''
  }

  /** 解除角色：先归档会话再删注册表，避免「有角色指向死会话」。 */
  async function remove(role) {
    const entry = roles[String(role)]
    if (!entry) return { ok: true, already: true }
    try {
      await api.archiveSession(entry.sessionId)
    } catch (error) {
      entry.lastError = `归档失败：${error?.message ?? error}`
      store.save()
      throw Object.assign(new Error(`角色「${role}」归档失败：${entry.lastError}`), { code: 'role-archive-failed' })
    }
    delete roles[String(role)]
    store.save()
    log?.('roles', `removed ${role}`)
    return { ok: true }
  }

  function dispose() {
    for (const timer of watchers.values()) clearInterval(timer)
    watchers.clear()
  }

  return { ensure, dispatch, snapshot, list, remove, dispose, maxRoles }
}
