/**
 * resolveTarget：把工单落到「某个工作区的那个单会话」。
 * 顺序固定：工单确定性线索 → QQ 研判给的 workspace → 默认工作区。
 * 只认工作区候选清单里的 id/path，模型幻觉一律丢弃（与 assessment.matchWorkspace 同口径）。
 */
import { intakeIdOf, slugOf } from './single-session.js'

const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function pickWorkspace({ ticket, assessment, workspaces, defaultWorkspaceId }) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const find = (value) => {
    const needle = norm(value)
    if (!needle) return null
    return list.find((item) => norm(item.id) === needle || norm(item.path) === needle) ?? null
  }

  const hint = ticket?.workspaceHint
  if (hint) {
    const hit = find(hint)
    if (hit) return { workspace: hit, via: 'hint' }
  }
  const picked = assessment?.workspace
  if (picked) {
    const hit = find(picked.id ?? picked.path ?? picked)
    if (hit) return { workspace: hit, via: 'assessment' }
  }
  if (defaultWorkspaceId) {
    const hit = list.find((item) => item.id === defaultWorkspaceId || norm(item.path) === norm(defaultWorkspaceId))
    if (hit) return { workspace: hit, via: 'default' }
  }
  return { workspace: null, via: 'none' }
}

/** 在该工作区的会话里找单会话：优先 intake-<slug>，否则同名 cwd 的顶层会话。 */
export function pickSession(workspace, sessions, prefix = 'intake') {
  if (!workspace) return null
  const wanted = intakeIdOf(prefix, workspace.path ?? workspace.cwd ?? '')
  const list = Array.isArray(sessions) ? sessions : []
  const exact = list.find((item) => item.sessionId === wanted)
  if (exact) return exact
  const sameCwd = list.find((item) => {
    if (!item.cwd) return false
    if (norm(item.cwd) !== norm(workspace.path)) return false
    if (item.parentSessionId || item.origin === 'subagent') return false
    return typeof item.sessionId === 'string' && item.sessionId.startsWith(`${prefix}-`)
  })
  return sameCwd ?? null
}

export function createTargetResolver({ ctx, config, log, redact, deps = {} }) {
  const listWorkspaces = deps.listWorkspaces ?? (() => ctx?.workspaceRegistry?.list?.() ?? [])
  const listSessions = deps.listSessions ?? (async (signal) => (await ctx.sessionController.list({}, signal))?.items ?? [])
  const createSession = deps.createSession ?? ((request) => ctx.sessionController.create(request))

  async function resolve(ticket, assessment, signal) {
    const workspaces = (listWorkspaces() ?? []).map((item) => ({
      id: item.id ?? item.workspaceId,
      path: item.path ?? item.cwd,
      name: item.name,
    }))
    const picked = pickWorkspace({
      ticket,
      assessment,
      workspaces,
      defaultWorkspaceId: config?.singleSession?.defaultWorkspaceId,
    })
    if (!picked.workspace) {
      return { sessionId: null, workspace: null, via: picked.via, error: '找不到工单对应的工作区' }
    }
    const sessions = await listSessions(signal)
    let session = pickSession(picked.workspace, sessions, config?.singleSession?.sessionIdPrefix ?? 'intake')
    if (!session && config?.singleSession?.autoCreate !== false) {
      const wanted = intakeIdOf(config?.singleSession?.sessionIdPrefix ?? 'intake', picked.workspace.path)
      try {
        const created = await createSession({ sessionId: wanted, cwd: picked.workspace.path })
        session = { sessionId: created?.sessionId ?? wanted, cwd: picked.workspace.path }
        log?.('target', `created intake session ${session.sessionId} for ${picked.workspace.path}`)
      } catch (error) {
        const message = redact?.(error?.message ?? String(error)) ?? String(error)
        return { sessionId: null, workspace: picked.workspace, via: picked.via, error: `建单会话失败：${message}` }
      }
    }
    if (!session) {
      return { sessionId: null, workspace: picked.workspace, via: picked.via, error: `工作区 ${picked.workspace.path} 没有单会话` }
    }
    return { sessionId: session.sessionId, workspace: picked.workspace, via: picked.via }
  }

  return { resolve, workspaceSlug: (path) => slugOf(path) }
}
