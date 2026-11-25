import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTicket, canTransition, markRunning, markDone, markFailed, markWaiting, safeSessionId, ticketStats, hourlyCount, threadCoolingDown, pruneTickets, isRelayedTerminal } from '../../lib/ticket.js'

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

test('每小时上限只数最近 1 小时', () => {
  const now = Date.now()
  const tickets = {
    old: { createdAt: now - 3_600_001 },
    fresh1: { createdAt: now - 1000 },
    fresh2: { createdAt: now - 500 },
  }
  assert.equal(hourlyCount(tickets, now), 2)
})

test('同源同线程冷却窗口内返回既有工单', () => {
  const now = Date.now()
  const tickets = {
    'github:issue-1': { id: 'github:issue-1', source: 'github', thread: 'issue-1', createdAt: now - 10_000 },
  }
  assert.equal(threadCoolingDown(tickets, 'github', 'issue-1', 60_000, now)?.id, 'github:issue-1')
  assert.equal(threadCoolingDown(tickets, 'github', 'issue-1', 5_000, now), null)
  assert.equal(threadCoolingDown(tickets, 'feishu', 'issue-1', 60_000, now), null)
  assert.equal(threadCoolingDown(tickets, 'github', 'issue-1', 0, now), null)
})

test('pruneTickets：只裁已 relay 的终态到最近 20 条；未终态与未 relay 不裁', () => {
  const tickets = {}
  // 25 条已 relay 终态，updatedAt 递增（1..25）。
  for (let i = 0; i < 25; i += 1) {
    const terminal = i % 2 === 0 ? 'done' : 'failed'
    tickets[`old-${i}`] = {
      id: `old-${i}`,
      status: terminal,
      updatedAt: i + 1,
      relayed: { [terminal]: { at: i + 1, delivered: true } },
    }
  }
  // 2 条未终态：无论多老都不裁。
  tickets['active-running'] = { id: 'active-running', status: 'running', updatedAt: 0, relayed: {} }
  tickets['active-waiting'] = { id: 'active-waiting', status: 'waiting', updatedAt: 0, relayed: {} }
  // 1 条终态但还没 relay：绝不能裁（裁了就丢回写）。
  tickets['pending-relay'] = { id: 'pending-relay', status: 'done', updatedAt: 0, relayed: {} }
  assert.equal(isRelayedTerminal(tickets['pending-relay']), false)

  const out = pruneTickets({ tickets }, { keepTerminal: 20 })
  assert.equal(out.removed, 5)
  assert.equal(out.kept, 20)
  assert.equal(Object.keys(tickets).length, 23, '裁剪后 = 20 已 relay 终态 + 2 未终态 + 1 未 relay')
  assert.ok(tickets['active-running'])
  assert.ok(tickets['active-waiting'])
  assert.ok(tickets['pending-relay'], '未 relay 的终态必须保留')
  // 最近 20 条（updatedAt 6..25）保留，最老的 5 条被裁。
  for (let i = 0; i < 5; i += 1) assert.equal(tickets[`old-${i}`], undefined)
  for (let i = 5; i < 25; i += 1) assert.ok(tickets[`old-${i}`], `old-${i} 应保留`)
})

