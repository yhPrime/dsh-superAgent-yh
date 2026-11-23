/**
 * 假 roost-host/1：GET /events（SSE 推 message）+ POST /rpc（system.capabilities / msg.send）。
 * 用法：node test/fakes/roost-host-fake.mjs <port> <token> <logFile>
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 59614)
const token = String(process.argv[3] ?? 'test-token')
const logFile = process.argv[4] ?? 'test/tmp/m3-roost.log'
const task = process.env.FAKE_ROOST_TASK ?? '在仓库根目录创建 qq2.txt，内容一行：M3-OFFICIAL。完成后调用 ticket_report，status=done，summary=已创建 qq2.txt。'

const record = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')

const messageFrame = {
  type: 'message',
  seq: 42,
  at: Date.now(),
  data: {
    chat: { kind: 'group', chatId: 'g1', groupUin: '100' },
    sender: { openid: 'u1', uin: '123', name: 'tester' },
    content: task,
    eventId: 'e1',
    msgId: 'm0',
    addressed: true,
    mentioned: true,
    event: 'GROUP_AT_MESSAGE_CREATE',
  },
}

const authorized = (req) => req.headers.authorization === `Bearer ${token}`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true }))
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 'UNAUTHORIZED' }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
    const send = (frame) => res.write(`id: ${frame.seq ?? 0}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
    send({ type: 'welcome', seq: 41, protocol: 'roost-host/1', bot: { id: 'bot-1' } })
    setTimeout(() => send(messageFrame), 300)
    const keep = setInterval(() => {
      try { res.write(': heartbeat\n\n') } catch { clearInterval(keep) }
    }, 5000)
    req.on('close', () => clearInterval(keep))
    return
  }
  if (req.method === 'POST' && url.pathname === '/rpc') {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } }))
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      record(`RPC ${body.slice(0, 500)}`)
      let request
      try { request = JSON.parse(body) } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST' } }))
      }
      const reply = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: request.id ?? '', ok: true, data }))
      }
      if (request.method === 'system.capabilities') {
        return reply({ methods: { 'msg.send': { scope: 'message' }, 'system.capabilities': { scope: 'read' } } })
      }
      if (request.method === 'msg.send') return reply({ id: 'sent-1' })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: request.id ?? '', ok: false, error: { code: 'NOT_FOUND', message: request.method } }))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 'NOT_FOUND' }))
})

server.listen(port, '127.0.0.1', () => {
  record(`listening on ${port}`)
  console.log(`fake roost-host listening on http://127.0.0.1:${port}`)
})
