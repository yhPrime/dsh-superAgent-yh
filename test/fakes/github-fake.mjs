/**
 * M1 本地假 GitHub API：只实现轮询需要的一个 issue 和回写记录，供集成测试用。
 * 用法：node test/fakes/github-fake.mjs <port> <logFile>
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 59611)
const logFile = process.argv[3] ?? 'test/tmp/m1/github-fake.log'
const mode = process.env.FAKE_GITHUB_MODE ?? ''
const taskBody = process.env.FAKE_ISSUE_BODY
const taskTitle = process.env.FAKE_ISSUE_TITLE

const updatedAt = new Date().toISOString()
const issue = {
  number: 1,
  title: taskTitle ?? '创建 hello.txt',
  body: taskBody ?? [
    '在仓库根目录创建 hello.txt，内容一行：M1-OK',
    '完成后调用 ticket_report 工具：status=done，summary=已创建 hello.txt。',
  ].join('\n'),
  state: 'open',
  updated_at: updatedAt,
  html_url: 'https://github.com/test/repo/issues/1',
  user: { login: 'tester' },
  labels: [{ name: 'superagent' }],
  assignees: [{ login: 'tester' }],
}

// 第二个工单：不动手，只验证「需要人」这条主线消息与 waiting 状态。
const issue2 = {
  number: 2,
  title: '需要人确认的工单',
  body: [
    '先不要改任何文件。',
    '直接调用 ticket_report：status=waiting，question=需要人确认是否创建 second.txt。',
  ].join('\n'),
  state: 'open',
  updated_at: updatedAt,
  html_url: 'https://github.com/test/repo/issues/2',
  user: { login: 'tester' },
  labels: [{ name: 'superagent' }],
  assignees: [{ login: 'tester' }],
}

const record = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  record(`${req.method} ${url.pathname}${url.search}`)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && url.pathname === '/repos/test/repo/issues') {
    if (mode === '401') return send(401, { message: 'Bad credentials' })
    if (mode === '500') return send(500, { message: 'boom' })
    return send(200, [issue, issue2])
  }
  if (req.method === 'POST' && /^\/repos\/test\/repo\/issues\/\d+\/(comments|labels)$/.test(url.pathname)) {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      record(`BODY ${body}`)
      send(200, { ok: true })
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, updatedAt })
  send(404, { message: 'not found' })
})

server.listen(port, '127.0.0.1', () => {
  record(`listening on ${port}`)
  console.log(`fake github listening on http://127.0.0.1:${port}`)
})
