/**
 * resolveTarget：把工单落到「某个工作区已登记的那个单会话」。
 * 单会话是人工登记的（v2.7），这里不再自动建会话。
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
    if (looksLikePath(hint)) {
      return { workspace: { id: null, path: String(hint), synthetic: true }, via: 'hint' }
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

/** 只认已登记的单会话（不再按 id 前缀猜）。 */
export function pickSession(workspace, registeredSessionId) {
  if (!workspace?.id || !registeredSessionId) return null
  return { sessionId: registeredSessionId, workspaceId: workspace.id, cwd: workspace.path }
}

export function createTargetResolver({ ctx, config, log, redact, deps = {} }) {
  const listWorkspaces = deps.listWorkspaces ?? (() => ctx?.workspaceRegistry?.list?.() ?? [])
  const registeredSession = deps.registeredSession ?? (() => null)

  async function resolve(ticket, assessment) {
    const workspaces = (listWorkspaces() ?? []).map((item) => ({
      id: item.id ?? item.workspaceId,
      path: item.path ?? item.cwd,
      name: item.name,
    }))
    const picked = pickWorkspace({ ticket, assessment, workspaces, defaultWorkspaceId: config?.singleSession?.defaultWorkspaceId })
    if (!picked.workspace) {
      return { sessionId: null, workspace: null, via: picked.via, error: '找不到工单对应的工作区' }
    }
    if (picked.workspace.synthetic) {
      return {
        sessionId: null,
        workspace: picked.workspace,
        via: picked.via,
        error: `目录 ${picked.workspace.path} 还不是 DSH 工作区：请把它建成工作区并在其中登记一个单会话`,
      }
    }
    const sessionId = await registeredSession(picked.workspace.id)
    if (!sessionId) {
      return {
        sessionId: null,
        workspace: picked.workspace,
        via: picked.via,
        error: `工作区 ${picked.workspace.path} 没有登记单会话（在该工作区新建会话并点亮「超级智能体」胶囊）`,
      }
    }
    log?.('target', `resolved ${ticket.id} → ${sessionId} (workspace ${picked.workspace.id})`)
    return { sessionId, workspace: picked.workspace, via: picked.via }
  }

  return { resolve, workspaceSlug: (path) => slugOf(path), intakeIdOf }
}
