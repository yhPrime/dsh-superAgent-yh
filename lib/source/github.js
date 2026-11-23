/**
 * GitHub 源：轮询 issue → Trigger；回写（评论/打标签）默认关闭，必须 confirmWrites。
 * 走 REST API，不依赖 gh CLI（本机没有 gh）。
 */
import { SourceError, normalizeTrigger } from './contract.js'

const ACK_LABEL = 'superagent-ack'

export function createGithubSource(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const base = cfg.apiBase.replace(/\/+$/, '')
  const repo = cfg.repo
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-superagent-yh',
    'x-github-api-version': '2022-11-28',
  }
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`

  async function request(path, init = {}) {
    const response = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
    if (response.ok) return response
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const retryAfter = Number(response.headers.get('retry-after'))
    if (response.status === 403 || response.status === 429) {
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(reset) && reset > 0
          ? Math.max(1000, reset * 1000 - Date.now())
          : undefined
      throw new SourceError(`GitHub 限流（HTTP ${response.status}）${remaining === '0' ? '：配额已用尽' : ''}`, {
        status: response.status,
        retryAfterMs,
      })
    }
    const body = await response.text().catch(() => '')
    throw new SourceError(`GitHub API ${response.status} ${path} ${body.slice(0, 200)}`, { status: response.status })
  }

  function matches(issue) {
    const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name))
    if (cfg.labels.length > 0 && !cfg.labels.every((label) => labels.includes(label))) return false
    if (cfg.assignee) {
      const assignees = (issue.assignees ?? []).map((person) => person.login)
      const single = issue.assignee?.login
      if (!assignees.includes(cfg.assignee) && single !== cfg.assignee) return false
    }
    if (cfg.authors.length > 0 && !cfg.authors.includes(issue.user?.login)) return false
    return true
  }

  const source = {
    kind: 'github',
    capabilities: { write: true, comments: true, threads: true },
    async poll(since = null) {
      const query = new URLSearchParams({ state: 'open', sort: 'updated', direction: 'asc', per_page: '100' })
      if (since) query.set('since', since)
      const response = await request(`/repos/${repo}/issues?${query}`)
      const items = await response.json()
      const triggers = []
      let watermark = since
      for (const issue of items) {
        if (issue.pull_request) continue
        if (!matches(issue)) continue
        const at = issue.updated_at
        if (!at) continue
        if (since && new Date(at) <= new Date(since)) continue
        triggers.push(normalizeTrigger({
          id: `issue-${issue.number}`,
          thread: `issue-${issue.number}`,
          actor: issue.user?.login ?? 'unknown',
          title: issue.title ?? '',
          body: issue.body ?? '',
          url: issue.html_url ?? '',
          at,
          kind: 'issue',
        }, 'github'))
        if (!watermark || new Date(at) > new Date(watermark)) watermark = at
      }
      return { triggers, since: watermark }
    },
    async send(thread, text) {
      if (!cfg.confirmWrites) throw new SourceError('GitHub 回写未开启（sources.github.confirmWrites=false）')
      const number = String(thread).replace(/^issue-/, '')
      await request(`/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
    },
    async ack(ticket) {
      if (!cfg.confirmWrites) return { skipped: true, reason: 'confirmWrites=false' }
      const number = String(ticket.thread).replace(/^issue-/, '')
      try {
        await request(`/repos/${repo}/issues/${number}/labels`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labels: [ACK_LABEL] }),
        })
        return { skipped: false }
      } catch (error) {
        return { skipped: true, reason: error.message }
      }
    },
  }
  return source
}
