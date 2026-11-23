import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTicket, canTransition, markRunning, markDone, markFailed, markWaiting, safeSessionId, ticketStats } from '../../lib/ticket.js'

const trigger = {
  id: 'issue-1',
  thread: 'issue-1',
  actor: 'tester',
  title: '修复登录',
  body: '正文',
  url: 'https://example/1',
  at: '2026-01-01T00:00:00.000Z',
  kind: 'issue',
}

test('新工单默认 queued，id 带源前缀', () => {
  const ticket = createTicket(trigger, { source: 'github' })
  assert.equal(ticket.id, 'github:issue-1')
  assert.equal(ticket.status, 'queued')
})

test('合法迁移与非法迁移', () => {
  const ticket = createTicket(trigger, { source: 'github' })
  assert.equal(canTransition('queued', 'running'), true)
  assert.equal(canTransition('done', 'running'), false)
  markRunning(ticket, { sessionId: 'worker-1' })
  assert.equal(ticket.status, 'running')
  assert.equal(ticket.attempts, 1)
  markWaiting(ticket, { summary: '要权限' })
  assert.equal(ticket.status, 'waiting')
  markDone(ticket, { summary: '好了' })
  assert.equal(ticket.status, 'done')
  assert.throws(() => markRunning(ticket, {}), /非法状态迁移/)
})

test('失败记录 lastError，且可从 failed 重排', () => {
  const ticket = createTicket(trigger, { source: 'github' })
  markRunning(ticket, {})
  markFailed(ticket, new Error('网络断了'))
  assert.equal(ticket.status, 'failed')
  assert.equal(ticket.lastError, '网络断了')
  assert.equal(canTransition('failed', 'queued'), true)
})

test('session id 安全化且不超 64', () => {
  const id = safeSessionId('github:issue-1/奇怪 标题')
  assert.match(id, /^worker-[A-Za-z0-9._-]+$/)
  assert.ok(id.length <= 64)
  assert.ok(safeSessionId('x'.repeat(200)).length <= 64)
})

test('统计按状态计数', () => {
  const stats = ticketStats({ a: { status: 'queued' }, b: { status: 'done' }, c: { status: 'done' } })
  assert.equal(stats.queued, 1)
  assert.equal(stats.done, 2)
  assert.equal(stats.failed, 0)
})
