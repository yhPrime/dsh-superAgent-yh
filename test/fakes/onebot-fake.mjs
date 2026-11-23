/**
 * 假 OneBot v11 网关：HTTP 动作接口 + 最小 WS 通道（只发事件，够插件收消息）。
 * 用法：node test/fakes/onebot-fake.mjs <port> <logFile> [group] [user] [selfId]
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 59613)
const logFile = process.argv[3] ?? 'test/tmp/m3-onebot.log'
const groupId = Number(process.argv[4] ?? 100)
const userId = Number(process.argv[5] ?? 123)
const selfId = String(process.argv[6] ?? 999)
const task = process.env.FAKE_ONEBOT_TASK ?? '在仓库根目录创建 qq.txt，内容一行：M3-OK。完成后调用 ticket_report，status=done，summary=已创建 qq.txt。'

const record = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
const event = {
  post_type: 'message',
  message_type: 'group',
  self_id: Number(selfId),
  group_id: groupId,
  user_id: userId,
  message_id: 9001,
  time: Math.floor(Date.now() / 1000),
  raw_message: `[CQ:at,qq=${selfId}] ${task}`,
  message: [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: ` ${task}` } }],
  sender: { user_id: userId, nickname: 'tester' },
}

function wsSend(socket, text) {
  const payload = Buffer.from(text, 'utf8')
  const head = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  socket.write(Buffer.concat([head, payload]))
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1')
    record(`${req.method} ${url.pathname} ${body.slice(0, 300)}`)
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && url.pathname === '/get_login_info') return send(200, { status: 'ok', retcode: 0, data: { user_id: Number(selfId), nickname: 'bot' } })
    if (req.method === 'POST' && (url.pathname === '/send_group_msg' || url.pathname === '/send_private_msg')) {
      return send(200, { status: 'ok', retcode: 0, data: { message_id: 10001 } })
    }
    if (url.pathname === '/health') return send(200, { ok: true })
    send(404, { status: 'failed', retcode: 404, message: 'not found' })
  })
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))
  record('WS connected')
  setTimeout(() => {
    try {
      wsSend(socket, JSON.stringify(event))
      record(`WS event message_id=${event.message_id}`)
    } catch (error) {
      record(`WS send failed: ${error.message}`)
    }
  }, 300)
  socket.on('data', () => {})
  socket.on('error', () => {})
})

server.listen(port, '127.0.0.1', () => {
  record(`listening on ${port}`)
  console.log(`fake onebot listening on http://127.0.0.1:${port}`)
})
