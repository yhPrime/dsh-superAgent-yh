/**
 * resolveTarget：把工单落到「某个工作区的那个单会话」。
 * 顺序固定：工单确定性线索 → QQ 研判给的 workspace → 默认工作区。
 * 只认工作区候选清单里的 id/path，模型幻觉一律丢弃（与 assessment.matchWorkspace 同口径）。
 */
import { intakeIdOf, slugOf } from './single-session.js'

const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const looksLikePath = (value) => /^[a-zA-Z]:[\\/]/.test(String(value ?? '')) || /[\\/]/.test(String(value ?? ''))

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
    // 仓库路径可能没有注册成工作区：显式路径线索直接采用（只对路径形态生效，防止把 id 当路径）。
    if (looksLikePath(hint)) {
      return { workspace: { id: `path:${norm(hint)}`, path: String(hint), synthetic: true }, via: 'hint' }
    }
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

/** 在该工作区的会话里找单会话：优先 workspaceId，其次 intake-<slug>，再次同 cwd 的 intake- 会话。 */
export function pickSession(workspace, sessions, prefix = 'intake') {
  if (!workspace) return null
  const wanted = intakeIdOf(prefix, workspace.path ?? workspace.cwd ?? '', workspace.id)
  const list = Array.isArray(sessions) ? sessions : []
  const byWorkspace = workspace.id ? list.find((item) => item.workspaceId && item.workspaceId === workspace.id) : null
  if (byWorkspace) return byWorkspace
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
  const resolveByPath = deps.resolveByPath ?? ((path) => ctx?.workspaceRegistry?.resolveByPath?.(path))
  const createWorkspace = deps.createWorkspace ?? ((path) => ctx?.workspaceRegistry?.create?.(path))
  const pinSession = deps.pinSession ?? ((id) => ctx?.workspaceRegistry?.pinSession?.(id))

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
    // 单会话必须真的挂在工作区上，否则 UI 里显示成「无工作区的新会话」。
    let workspaceId = picked.workspace.synthetic ? null : picked.workspace.id
    if (!workspaceId && picked.workspace.path) {
      try {
        const found = await resolveByPath(picked.workspace.path)
        if (found?.id) workspaceId = found.id
        else if (config?.singleSession?.autoCreate !== false) {
          const created = await createWorkspace(picked.workspace.path)
          if (created?.id) workspaceId = created.id
          log?.('target', `registered workspace ${created?.id} for ${picked.workspace.path}`)
        }
      } catch (error) {
        log?.('target', `workspace resolve/create failed: ${error?.message ?? error}`)
      }
    }
    if (!session && config?.singleSession?.autoCreate !== false) {
      const wanted = intakeIdOf(config?.singleSession?.sessionIdPrefix ?? 'intake', picked.workspace.path, workspaceId)
      try {
        const request = workspaceId
          ? { sessionId: wanted, workspaceId }
          : { sessionId: wanted, cwd: picked.workspace.path }
        const created = await createSession(request)
        session = { sessionId: created?.sessionId ?? wanted, workspaceId, cwd: picked.workspace.path }
        log?.('target', `created intake session ${session.sessionId} for ${picked.workspace.path}${workspaceId ? ` (workspace ${workspaceId})` : ''}`)
      } catch (error) {
        const message = redact?.(error?.message ?? String(error)) ?? String(error)
        return { sessionId: null, workspace: picked.workspace, via: picked.via, error: `建单会话失败：${message}` }
      }
    }
    if (!session) {
      return { sessionId: null, workspace: picked.workspace, via: picked.via, error: `工作区 ${picked.workspace.path} 没有单会话` }
    }
    // 单会话在工作区列表顶置（D25）；maintainer 每轮也会补，这里是即时生效。
    try {
      await pinSession(session.sessionId)
    } catch (error) {
      log?.('target', `pin failed ${session.sessionId}: ${error?.message ?? error}`)
    }
    return { sessionId: session.sessionId, workspace: picked.workspace, via: picked.via }
  }

  return { resolve, workspaceSlug: (path) => slugOf(path) }
}
