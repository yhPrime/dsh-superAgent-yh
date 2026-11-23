/**
 * 面板：只读列表（按源分组、三态 + 最后错误）+ 设置表单。
 * 单独页面（/dsh-superagent-yh），不嵌 iframe、不依赖前端构建。
 */
import { ticketStats } from './ticket.js'

const PAGE = (payload) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-superAgent-yh</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1f2329}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#646a73;margin-bottom:20px}
section{background:#fff;border:1px solid #e5e6eb;border-radius:10px;padding:16px 18px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 12px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #f0f1f3;vertical-align:top}
th{color:#646a73;font-weight:500;font-size:12px}
code{font-size:12px}
.badge{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px}
.queued{background:#fff4e6;color:#ad6800}.running{background:#e8f3ff;color:#0050b3}
.waiting{background:#fff7e6;color:#ad4e00}.done{background:#e8ffea;color:#237804}.failed{background:#fff1f0;color:#a8071a}
.err{color:#a8071a;font-size:12px;word-break:break-all}
form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#646a73}
input{padding:6px 8px;border:1px solid #d0d3d9;border-radius:6px;font:inherit}
button{padding:7px 14px;border:0;border-radius:6px;background:#1664ff;color:#fff;font:inherit;cursor:pointer}
#msg{margin-left:8px;font-size:12px;color:#237804}
.muted{color:#8a8f99}
</style></head><body>
<h1>dsh-superAgent-yh</h1>
<div class="sub">每个工单在独立会话与独立目录执行；主线只收三条短消息。页面每 5 秒自动刷新。</div>
${payload.sections}
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

export function registerPanel({ ctx, store, config, redact }) {
  const origin = ctx.webServer.getOrigin()
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const statusHandler = (_req, res) => {
    const payload = renderPayload({ store, config })
    json(res, 200, {
      dryRun: payload.dryRun,
      mainSessionId: payload.mainSessionId,
      pollIntervalMs: payload.pollIntervalMs,
      stats: payload.stats,
      lastError: payload.lastError,
      sources: payload.sources,
      tickets: Object.values(store.state.tickets).slice(-100).map((ticket) => ({
        id: ticket.id,
        source: ticket.source,
        title: ticket.title,
        status: ticket.status,
        attempts: ticket.attempts,
        lastError: ticket.lastError ? redact(ticket.lastError) : null,
        question: ticket.report?.question ?? null,
        sessionId: ticket.sessionId,
        workdir: ticket.workdir,
      })),
    })
  }

  const pageHandler = (_req, res) => {
    const payload = renderPayload({ store, config })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE(payload))
  }

  const settingsHandler = async (req, res) => {
    if (String(req.headers.origin ?? '') !== origin) return json(res, 403, { ok: false, error: 'origin 不匹配' })
    let body = ''
    for await (const chunk of req) body += chunk
    if (body.length > 8_000) return json(res, 413, { ok: false, error: '请求体过大' })
    let patch
    try {
      patch = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'JSON 解析失败' })
    }
    if (typeof patch !== 'object' || patch === null) return json(res, 400, { ok: false, error: '需要对象' })
    const update = {}
    if (typeof patch.dryRun === 'boolean') update.dryRun = patch.dryRun
    if (typeof patch.mainSessionId === 'string') update.mainSessionId = patch.mainSessionId.slice(0, 200)
    if (Number.isFinite(patch.pollIntervalMs)) update.pollIntervalMs = Math.max(1000, Math.trunc(patch.pollIntervalMs))

    const editor = ctx.get('configEditor')
    if (!editor) return json(res, 501, { ok: false, error: '宿主没有 configEditor，面板只能只读' })
    const entries = editor.entries()
    const bareId = (item) => String(item.id).replace(/^include:/, '').replace(/^[^-]+:/, '')
    const entry = entries.find((item) => bareId(item) === 'dsh-superagent-yh' || item.name === 'dsh-superagent-yh')
    if (!entry) {
      return json(res, 404, { ok: false, error: '找不到 dsh-superagent-yh 配置行', entries: entries.slice(0, 80).map((item) => ({ id: item.id, name: item.name })) })
    }
    try {
      await editor.edit(entry, (current) => ({ ...(current ?? {}), ...update }))
      return json(res, 200, { ok: true, updated: Object.keys(update) })
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh', handler: pageHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh/status', handler: statusHandler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-superagent-yh/settings', handler: settingsHandler }))
  return origin
}
