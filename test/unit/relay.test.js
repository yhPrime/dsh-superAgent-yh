import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRelay, textFor } from '../../lib/relay.js'

function harness({ targetSessionId = null, mainSessionId = '', resolve = () => ({ agent: {} }) } = {}) {
  const calls = { prompt: [], created: [], resolve: [] }
  const ctx = {
    sessionController: {
      resolveAgent: async (id) => {
        calls.resolve.push(id)
        return resolve(id)
      },
      create: async (req) => {
        calls.created.push(req)
        return { sessionId: req.sessionId }
      },
      prompt: async (req) => {
        calls.prompt.push(req)
      },
    },
  }
  const store = { state: { tickets: {} }, save() {} }
  const config = { mainSessionId, repoPath: 'C:/repo' }
  const relay = createRelay({ ctx, store, config, redact: (x) => x, log: () => {} })
  const ticket = { id: 'github:issue-1', title: 't', url: 'u', targetSessionId, relayed: {} }
  return { relay, ticket, calls }
}

test('textFor：四种短消息带前缀与 id', () => {
  const ticket = { id: 'github:issue-1', title: '修 bug', url: 'https://x/1', report: { summary: '好了' }, lastError: '炸了' }
  assert.match(textFor(ticket, 'started'), /^【superagent】开工 github:issue-1/)
  assert.match(textFor(ticket, 'needHuman'), /需要人/)
  assert.match(textFor(ticket, 'done'), /完成 github:issue-1｜好了/)
  assert.match(textFor(ticket, 'failed'), /失败 github:issue-1｜炸了/)
})

test('团队模式：优先投 targetSessionId，不动主线会话', async () => {
  const h = harness({ targetSessionId: 'session-target', mainSessionId: 'session-main' })
  const out = await h.relay.send(h.ticket, 'started')
  assert.equal(out.delivered, true)
  assert.equal(h.calls.prompt[0].sessionId, 'session-target')
  assert.deepEqual(h.calls.created, [])
})

test('团队模式：目标会话不存在 → 抛错、不静默投主线', async () => {
  const h = harness({ targetSessionId: 'session-gone', mainSessionId: 'session-main', resolve: () => ({ error: { code: 'session/not-found' } }) })
  await assert.rejects(() => h.relay.send(h.ticket, 'started'), /目标单会话不可用：session\/not-found/)
  assert.equal(h.calls.prompt.length, 0)
})

test('无目标会话：回退主线；主线也没配则只记账不投递', async () => {
  const h = harness({ mainSessionId: 'session-main' })
  await h.relay.send(h.ticket, 'started')
  assert.equal(h.calls.prompt[0].sessionId, 'session-main')

  const h2 = harness({ mainSessionId: '' })
  const out = await h2.relay.send(h2.ticket, 'done')
  assert.equal(out.delivered, false)
  assert.equal(h2.calls.prompt.length, 0)
})

test('同一 kind 只投一次', async () => {
  const h = harness({ mainSessionId: 'session-main' })
  await h.relay.send(h.ticket, 'started')
  const again = await h.relay.send(h.ticket, 'started')
  assert.equal(again.skipped, true)
  assert.equal(h.calls.prompt.length, 1)
})
