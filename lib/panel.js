/**
 * 控制台 host 侧：状态/日志/工单操作/源配置写回。
 * 独立网页（/dsh-superagent-yh）与应用内 client（client.js）共用这些路由。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ticketStats, markQueued, markFailed, TICKET_STATUS } from './ticket.js'
import { normalizeConfig } from './config.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const PAGE = (payload) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-superAgent-yh</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:var(--dsw-alias-bg-base,#f6f7f9);color:var(--dsw-alias-label-primary,#1f2329)}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--dsw-alias-label-secondary,#646a73);margin-bottom:20px}
section{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:10px;padding:16px 18px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 12px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f1f3);vertical-align:top}
th{color:var(--dsw-alias-label-secondary,#646a73);font-weight:500;font-size:12px}
code{font-size:12px}
.badge{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px}
.queued{background:#fff4e6;color:#ad6800}.running{background:#e8f3ff;color:#0050b3}
.waiting{background:#fff7e6;color:#ad4e00}.done{background:#e8ffea;color:#237804}.failed{background:#fff1f0;color:#a8071a}
.err{color:var(--dsw-alias-state-error-primary,#a8071a);font-size:12px;word-break:break-all}
form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}
input{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#d0d3d9);border-radius:6px;font:inherit}
button{padding:7px 14px;border:0;border-radius:6px;background:var(--dsw-alias-brand-primary,#1664ff);color:#fff;font:inherit;cursor:pointer}
#msg{margin-left:8px;font-size:12px;color:var(--dsw-alias-state-success-primary,#237804)}
.muted{color:var(--dsw-alias-label-secondary,#8a8f99)}
.ws{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f1f3)}
.ws:last-child{border-bottom:0}
.bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,#f0f1f3);overflow:hidden;margin-top:6px;max-width:260px}
.bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#1664ff)}
</style></head><body>
<h1>dsh-superAgent-yh <span class="muted">v${VERSION}</span></h1>
<div class="sub">只读兜底页。完整控制台在 DSH 应用内左侧栏「Superagent」图标里（右栏也有同名页签）。页面每 5 秒自动刷新。</div>
${payload.sections}
${payload.singleSection}
<section>
  <h2>设置（保存后由 DSH 配置系统应用）</h2>
  <form id="f">
    <label>dryRun<input id="dryRun" type="checkbox" ${payload.config.dryRun ? 'checked' : ''}></label>
    <label>主线会话 ID<input id="mainSessionId" value="${escapeHtml(payload.config.mainSessionId)}" placeholder="留空=只记状态不投递"></label>
    <label>轮询间隔(ms)<input id="pollIntervalMs" type="number" min="1000" step="1000" value="${payload.config.pollIntervalMs}"></label>
    <button type="submit">保存</button><span id="msg"></span>
  </form>
</section>
<script>
const f=document.getElementById('f'),msg=document.getElementById('msg');
f.addEventListener('submit',async(e)=>{e.preventDefault();msg.textContent='保存中…';
 const body={dryRun:document.getElementById('dryRun').checked,mainSessionId:document.getElementById('mainSessionId').value.trim(),pollIntervalMs:Number(document.getElementById('pollIntervalMs').value)};
 try{const r=await fetch(location.pathname+'/settings',{method:'POST',headers:{'content-type':'application/json','x-superagent':'1'},body:JSON.stringify(body)});
 const j=await r.json();msg.textContent=j.ok?'已保存（插件会重载）':('失败：'+(j.error||r.status));}catch(err){msg.textContent='失败：'+err.message;}});
</script></body></html>`

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

function renderTicket(ticket) {
  return `<tr><td><code>${escapeHtml(ticket.id)}</code></td><td>${escapeHtml(ticket.title)}</td><td><span class="badge ${ticket.status}">${ticket.status}</span></td><td>${ticket.attempts ?? 0}</td><td>${ticket.lastError ? `<div class="err">${escapeHtml(ticket.lastError)}</div>` : '<span class="muted">—</span>'}</td></tr>`
}

/** 给 UI 的配置视图：token 只回 hasToken，不回明文。 */
export function configView(config) {
  return {
    version: VERSION,
    dryRun: config.dryRun,
    mainSessionId: config.mainSessionId,
    pollIntervalMs: config.pollIntervalMs,
    workerPreset: config.workerPreset,
    repoPath: config.repoPath,
    singleSession: { ...config.singleSession },
    sources: {
      github: {
        enabled: config.sources.github.enabled,
        repo: config.sources.github.repo,
        labels: config.sources.github.labels,
        authors: config.sources.github.authors,
        apiBase: config.sources.github.apiBase,
        confirmWrites: config.sources.github.confirmWrites,
        hasToken: Boolean(config.sources.github.token),
      },
      feishu: {
        enabled: config.sources.feishu.enabled,
        appId: config.sources.feishu.appId,
        chatIds: config.sources.feishu.chatIds,
        authors: config.sources.feishu.authors,
        requireMention: config.sources.feishu.requireMention,
        confirmWrites: config.sources.feishu.confirmWrites,
        hasSecret: Boolean(config.sources.feishu.appSecret),
      },
      qq: {
        enabled: config.sources.qq.enabled,
        mode: config.sources.qq.mode,
        requireAt: config.sources.qq.requireAt,
        authors: config.sources.qq.authors,
        allowedGroups: config.sources.qq.allowedGroups,
        confirmWrites: config.sources.qq.confirmWrites,
        personal: {
          httpUrl: config.sources.qq.personal.httpUrl,
          wsUrl: config.sources.qq.personal.wsUrl,
          selfId: config.sources.qq.personal.selfId,
          snowLumaDir: config.sources.qq.personal.snowLumaDir,
          hasHttpToken: Boolean(config.sources.qq.personal.httpToken),
          hasWsToken: Boolean(config.sources.qq.personal.wsToken),
        },
        official: {
          host: config.sources.qq.official.host,
          port: config.sources.qq.official.port,
          hasToken: Boolean(config.sources.qq.official.token),
        },
      },
    },
  }
}

const asList = (value) => Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter(Boolean) : []

function mergeSource(current, incoming, kind) {
  const next = { ...(current ?? {}) }
  const bool = (key) => { if (typeof incoming[key] === 'boolean') next[key] = incoming[key] }
  const str = (key, max = 300) => { if (typeof incoming[key] === 'string') next[key] = incoming[key].trim().slice(0, max) }
  const list = (key) => { if (incoming[key] !== undefined) next[key] = asList(incoming[key]) }
  bool('enabled')
  bool('confirmWrites')
  if (kind === 'github') {
    str('repo'); str('apiBase'); str('assignee'); list('labels'); list('authors')
    if (typeof incoming.token === 'string' && incoming.token !== '') next.token = incoming.token
  } else if (kind === 'feishu') {
    str('appId'); bool('requireMention'); list('chatIds'); list('authors')
    if (typeof incoming.appSecret === 'string' && incoming.appSecret !== '') next.appSecret = incoming.appSecret
  } else if (kind === 'qq') {
    str('mode'); bool('requireAt'); list('authors'); list('allowedGroups')
    if (incoming.personal && typeof incoming.personal === 'object') {
      next.personal = { ...(next.personal ?? {}) }
      for (const key of ['httpUrl', 'wsUrl', 'selfId', 'snowLumaDir']) {
        if (typeof incoming.personal[key] === 'string') next.personal[key] = incoming.personal[key].trim()
      }
      for (const key of ['httpToken', 'wsToken']) {
        if (typeof incoming.personal[key] === 'string' && incoming.personal[key] !== '') next.personal[key] = incoming.personal[key]
      }
    }
    if (incoming.official && typeof incoming.official === 'object') {
      next.official = { ...(next.official ?? {}) }
      if (typeof incoming.official.host === 'string') next.official.host = incoming.official.host.trim()
      if (Number.isFinite(incoming.official.port)) next.official.port = Math.trunc(incoming.official.port)
      if (typeof incoming.official.token === 'string' && incoming.official.token !== '') next.official.token = incoming.official.token
    }
  }
  return next
}

/** 合并设置；纯函数，供单测与路由共用。 */
export function mergeSettings(current, patch) {
  const next = structuredClone(current ?? {})
  if (typeof patch.dryRun === 'boolean') next.dryRun = patch.dryRun
  if (typeof patch.mainSessionId === 'string') next.mainSessionId = patch.mainSessionId.slice(0, 200)
  if (typeof patch.repoPath === 'string') next.repoPath = patch.repoPath.trim()
  if (Number.isFinite(patch.pollIntervalMs)) next.pollIntervalMs = Math.max(1000, Math.trunc(patch.pollIntervalMs))
  if (typeof patch.workerPreset === 'string' && patch.workerPreset.trim()) next.workerPreset = patch.workerPreset.trim()
  if (patch.singleSession && typeof patch.singleSession === 'object') {
    const incoming = patch.singleSession
    const target = { ...(next.singleSession ?? {}) }
    for (const key of ['enabled', 'aggressive', 'autoCreate']) {
      if (typeof incoming[key] === 'boolean') target[key] = incoming[key]
    }
    for (const key of ['idleMinutes', 'keepRecentTurns']) {
      if (Number.isFinite(incoming[key])) target[key] = Math.trunc(incoming[key])
    }
    if (Number.isFinite(incoming.pressureRatio)) target.pressureRatio = incoming.pressureRatio
    if (typeof incoming.sessionIdPrefix === 'string' && incoming.sessionIdPrefix.trim()) target.sessionIdPrefix = incoming.sessionIdPrefix.trim()
    next.singleSession = target
  }
  if (patch.sources && typeof patch.sources === 'object') {
    next.sources = { ...(next.sources ?? {}) }
    for (const kind of ['github', 'feishu', 'qq']) {
      const incoming = patch.sources[kind]
      if (incoming && typeof incoming === 'object') next.sources[kind] = mergeSource(next.sources[kind], incoming, kind)
    }
  }
  return next
}

export function renderPayload({ store, config }) {
  const tickets = Object.values(store.state.tickets)
  const stats = ticketStats(tickets)
  const groups = new Map()
  for (const ticket of tickets) {
    if (!groups.has(ticket.source)) groups.set(ticket.source, [])
    groups.get(ticket.source).push(ticket)
  }
  const sections = [`<section><h2>总览</h2><div>待处理 <b>${stats.queued}</b>／进行中 <b>${stats.running}</b>／等进行人 <b>${stats.waiting}</b>／完成 <b>${stats.done}</b>／失败 <b>${stats.failed}</b>　<span class="muted">dryRun=${config.dryRun} · 主线 ${config.mainSessionId || '（未配置）'} · 轮询 ${config.pollIntervalMs}ms</span>${store.state.lastError ? `<div class="err">最后错误：${escapeHtml(store.state.lastError)}</div>` : ''}</div></section>`]
  for (const [source, list] of [...groups.entries()].sort()) {
    const status = store.state.sourceStatus[source]
    sections.push(`<section><h2>${escapeHtml(source)} <span class="muted">（${list.length} 个工单）</span></h2>${status && !status.ok ? `<div class="err">轮询失败：${escapeHtml(status.lastError)}</div>` : ''}<table><thead><tr><th>工单</th><th>标题</th><th>状态</th><th>尝试</th><th>最后错误</th></tr></thead><tbody>${list.slice(-100).reverse().map(renderTicket).join('')}</tbody></table></section>`)
  }
  if (tickets.length === 0) sections.push('<section><div class="muted">还没有工单。启用一个源并等一个轮询周期。</div></section>')
  return {
    dryRun: config.dryRun,
    mainSessionId: config.mainSessionId,
    pollIntervalMs: config.pollIntervalMs,
    stats,
    lastError: store.state.lastError,
    sources: store.state.sourceStatus,
    config: { dryRun: config.dryRun, mainSessionId: config.mainSessionId, pollIntervalMs: config.pollIntervalMs },
    sections: sections.join('\n'),
  }
}

export function registerPanel({ ctx, store, config, redact, log, getSingleSession }) {
  const origin = ctx.webServer.getOrigin()
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const ticketView = (ticket) => ({
    id: ticket.id,
    source: ticket.source,
    title: ticket.title,
    status: ticket.status,
    attempts: ticket.attempts,
    lastError: ticket.lastError ? redact(ticket.lastError) : null,
    question: ticket.report?.question ? redact(ticket.report.question) : null,
    summary: ticket.report?.summary ? redact(ticket.report.summary) : null,
    sessionId: ticket.sessionId,
    workdir: ticket.workdir,
    at: ticket.at,
    createdAt: ticket.createdAt,
  })

  const statusHandler = async (_req, res) => {
    const payload = renderPayload({ store, config })
    let singleSession = { enabled: config.singleSession.enabled, config: config.singleSession, workspaces: [] }
    const maintainer = getSingleSession?.()
    if (maintainer) {
      try {
        singleSession = await maintainer.snapshot()
      } catch (error) {
        singleSession = { ...singleSession, error: redact(error?.message ?? String(error)) }
      }
    }
    json(res, 200, {
      ...payload,
      config: configView(config),
      singleSession,
      tickets: Object.values(store.state.tickets).slice(-100).map(ticketView),
    })
  }

  const pageHandler = async (_req, res) => {
    const payload = renderPayload({ store, config })
    let single = { enabled: config.singleSession.enabled, workspaces: [] }
    const maintainer = getSingleSession?.()
    if (maintainer) {
      try {
        single = await maintainer.snapshot()
      } catch {
        /* 快照失败不影响页面 */
      }
    }
    const rows = single.enabled
      ? (single.workspaces ?? []).length === 0
        ? '<div class="muted">还没有工作空间。</div>'
        : single.workspaces.map((workspace) => `<div class="ws"><div><div>${escapeHtml(workspace.path)}</div><div class="muted" style="font-size:12px">${escapeHtml(workspace.sessionId || '无接单会话')}${workspace.lastCompact ? ` · 上次压缩 ${new Date(workspace.lastCompact.at).toLocaleString()}` : ''}</div>${workspace.sessionId ? `<div class="bar"><i style="width:${Math.min(100, Math.round((workspace.ratio || 0) * 100))}%"></i></div>` : ''}</div><div class="muted">${workspace.missing ? '缺失' : `${workspace.pressureTokens || 0}/${workspace.contextWindow || '?'} (${Math.round((workspace.ratio || 0) * 100)}%)`}</div></div>`).join('')
      : '<div class="muted">单会话模式未开启。</div>'
    const singleSection = `<section><h2>单会话模式 <span class="muted">（${single.enabled ? '已开启' : '已关闭'}）</span></h2>${rows}</section>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE({ ...payload, singleSection }))
  }

  const logHandler = (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const ticketId = String(url.searchParams.get('ticketId') ?? '')
    if (!ticketId) return json(res, 400, { ok: false, error: '缺少 ticketId' })
    const file = join(store.logsDir, `${ticketId.replace(/[^A-Za-z0-9._-]+/g, '-')}.log`)
    if (!existsSync(file)) return json(res, 404, { ok: false, error: '没有这个工单的日志' })
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    json(res, 200, { ok: true, ticketId, truncated: lines.length > 200, text: redact(lines.slice(-200).join('\n')) })
  }

  const actionHandler = async (req, res) => {
    if (String(req.headers.origin ?? '') !== origin) return json(res, 403, { ok: false, error: 'origin 不匹配' })
    let body = ''
    for await (const chunk of req) body += chunk
    if (body.length > 8_000) return json(res, 413, { ok: false, error: '请求体过大' })
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'JSON 解析失败' })
    }
    if (payload?.action === 'compact') {
      const maintainer = getSingleSession?.()
      if (!maintainer) return json(res, 501, { ok: false, error: '宿主没有 tokenMeter/workspaceRegistry，单会话功能不可用' })
      const sessionId = String(payload.sessionId ?? '')
      if (!sessionId) return json(res, 400, { ok: false, error: '缺少 sessionId' })
      try {
        const result = await maintainer.compactManual(sessionId)
        log?.('single-session', `manual compact ${sessionId}: ${JSON.stringify(result)}`)
        return json(res, 200, { ok: true, ...result })
      } catch (error) {
        const status = error?.code === 'busy' ? 409 : error?.code === 'not-found' ? 404 : error?.code === 'not-enabled' ? 409 : 500
        return json(res, status, { ok: false, error: redact(error?.message ?? String(error)) })
      }
    }
    const ticket = store.state.tickets[payload?.ticketId]
    if (!ticket) return json(res, 404, { ok: false, error: '工单不存在' })
    try {
      if (payload.action === 'retry') {
        if (ticket.status !== TICKET_STATUS.FAILED) return json(res, 409, { ok: false, error: `当前状态 ${ticket.status} 不能重试` })
        markQueued(ticket)
        ticket.report = null
        store.save()
        log(ticket.id, 'manual retry')
        return json(res, 200, { ok: true, status: ticket.status })
      }
      if (payload.action === 'cancel') {
        if (ticket.status !== TICKET_STATUS.RUNNING && ticket.status !== TICKET_STATUS.WAITING) {
          return json(res, 409, { ok: false, error: `当前状态 ${ticket.status} 不能取消` })
        }
        if (ticket.sessionId) {
          try {
            ctx.sessionController.cancel({ sessionId: ticket.sessionId })
          } catch {
            /* 会话已空闲 */
          }
        }
        markFailed(ticket, '人工取消')
        store.save()
        log(ticket.id, 'manual cancel')
        return json(res, 200, { ok: true, status: ticket.status })
      }
      return json(res, 400, { ok: false, error: 'action 只能是 retry / cancel / compact' })
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  const settingsHandler = async (req, res) => {
    if (String(req.headers.origin ?? '') !== origin) return json(res, 403, { ok: false, error: 'origin 不匹配' })
    let body = ''
    for await (const chunk of req) body += chunk
    if (body.length > 32_000) return json(res, 413, { ok: false, error: '请求体过大' })
    let patch
    try {
      patch = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'JSON 解析失败' })
    }
    if (typeof patch !== 'object' || patch === null) return json(res, 400, { ok: false, error: '需要对象' })
    const editor = ctx.get('configEditor')
    if (!editor) return json(res, 501, { ok: false, error: '宿主没有 configEditor，面板只能只读' })
    const entries = editor.entries()
    const bareId = (item) => String(item.id).replace(/^include:/, '').replace(/^[^-]+:/, '')
    const entry = entries.find((item) => bareId(item) === 'dsh-superagent-yh' || item.name === 'dsh-superagent-yh')
    if (!entry) {
      return json(res, 404, { ok: false, error: '找不到 dsh-superagent-yh 配置行', entries: entries.slice(0, 80).map((item) => ({ id: item.id, name: item.name })) })
    }
    try {
      await editor.edit(entry, (current) => {
        const next = mergeSettings(current ?? {}, patch)
        normalizeConfig(next)
        return next
      })
      return json(res, 200, { ok: true, updated: Object.keys(patch) })
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh', handler: pageHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh/status', handler: statusHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh/log', handler: logHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh/action', handler: actionHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh/settings', handler: settingsHandler }))
  return origin
}
