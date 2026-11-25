#!/usr/bin/env node
// 控制台五路由 mock 宿主：给 verify-v210.mjs --console 提供可重复的通过基线。
// 只实现冒烟用到的 5 个路由与最小 JSON 形状；不写磁盘、不发外部请求、不返回任何明文密钥。
//
// 单独跑（打印 MOCK_READY <port>，Ctrl+C 结束）：
//   node test/tools/console-mock-server.mjs [port]
// 作为库用：
//   import { startMockServer } from './console-mock-server.mjs'
//   const { port, close } = await startMockServer()
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const PREFIX = '/dsh-superagent-yh'
const VERSION = '0.9.6'
const DISPATCHER = 'dsh-superagent-yh-dispatcher'
const WORKER = 'dsh-superagent-yh-worker'

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function statusBody() {
  // 注意：字段名/值都不出现 token、appSecret 等敏感键，避免冒烟的明文扫描误报。
  return {
    ok: true,
    config: {
      version: VERSION,
      singleSession: { preset: DISPATCHER, idleMinutes: 30, enabled: true },
      workerPreset: WORKER,
      dryRun: false,
      github: { enabled: true, repo: 'mock/repo' },
      feishu: { enabled: false },
      qq: { enabled: false },
      autoCreate: false,
    },
    roles: [{ name: 'mock-role', preset: WORKER }],
    delegate: { limit: 6 },
    tickets: [{ id: 'mock-t1', subject: 'mock 工单', source: 'github', status: 'done', attempts: 1 }],
    singleSession: {
      workspaces: [{ id: 'mock-ws', sessionId: 'mock-session-1', path: 'C:/mock/ws', title: 'mock 工作区' }],
    },
    sources: [{ id: 'github', enabled: true, health: { ok: true } }],
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.pathname.startsWith(PREFIX)) return sendJson(res, 404, { ok: false, error: 'not found' })
  const route = url.pathname.slice(PREFIX.length)
  const method = req.method || 'GET'

  if (method === 'GET' && route === '/status') return sendJson(res, 200, statusBody())
  if (method === 'GET' && route === '/single') {
    const sessionId = url.searchParams.get('sessionId') || ''
    return sendJson(res, 200, {
      ok: true,
      sessionId,
      workspaces: statusBody().singleSession.workspaces,
      config: statusBody().config,
    })
  }
  if (method === 'GET' && route === '/log') {
    const ticketId = url.searchParams.get('ticketId') || ''
    return sendJson(res, 200, { ok: true, ticketId, text: 'mock 日志第 1 行\nmock 日志第 2 行' })
  }
  if (method === 'POST' && route === '/action') {
    const body = await readBody(req)
    // 空 payload 只验路由存活：返回 400 + ok=false，不制造写副作用。
    if (!body || !body.action) return sendJson(res, 400, { ok: false, error: '缺少 action' })
    if (body.action === 'remove-role' && !body.role) return sendJson(res, 400, { ok: false, error: '缺少 role' })
    return sendJson(res, 200, { ok: true })
  }
  if (method === 'POST' && route === '/settings') {
    const body = await readBody(req)
    const preset = body?.singleSession?.preset
    if (preset !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(String(preset))) {
      return sendJson(res, 400, { ok: false, error: '非法 preset' })
    }
    return sendJson(res, 200, { ok: true })
  }
  return sendJson(res, 404, { ok: false, error: 'not found' })
}

// 起 mock；port=0 时由系统分配。返回 { server, port, close }。
export function startMockServer(port = 0) {
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => sendJson(res, 500, { ok: false, error: String(error?.message || error) }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

// 直接运行时打印就绪行，供 shell / 聚合脚本等待。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const portArg = Number(process.argv[2] || 0)
  const { port } = await startMockServer(Number.isFinite(portArg) ? portArg : 0)
  console.log(`MOCK_READY ${port}`)
}
