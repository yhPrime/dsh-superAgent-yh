/**
 * M2 本地假飞书 API：tenant_access_token + 消息列表 + 发消息记录。
 * 用法：node test/fakes/feishu-fake.mjs <port> <logFile>
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 59612)
const logFile = process.argv[3] ?? 'test/tmp/m2/feishu-fake.log'
const now = Date.now()

const messages = [{
  message_id: 'om_m2_1',
  msg_type: 'text',
  create_time: String(now),
  sender: { id: 'ou_tester', sender_type: 'user' },
  body: { content: JSON.stringify({ text: '请创建 m2.txt，内容一行：M2-OK。完成后调用 ticket_report，status=done，summary=已创建 m2.txt。' }) },
  mentions: [],
}]

const record = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  record(`${req.method} ${url.pathname}`)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'POST' && url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
    return send(200, { code: 0, tenant_access_token: 'fake-tenant-token', expire: 7200 })
  }
  if (req.method === 'GET' && url.pathname === '/open-apis/im/v1/messages') {
    return send(200, { code: 0, data: { items: messages, has_more: false, page_token: '' } })
  }
  if (req.method === 'POST' && url.pathname === '/open-apis/im/v1/messages') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      record(`BODY ${body}`)
      send(200, { code: 0, data: { message_id: 'om_sent' } })
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true })
  send(404, { code: 404, msg: 'not found' })
})

server.listen(port, '127.0.0.1', () => {
  record(`listening on ${port}`)
  console.log(`fake feishu listening on http://127.0.0.1:${port}`)
})
