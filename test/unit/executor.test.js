import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor, parseReport } from '../../lib/executor.js'
import { normalizeConfig } from '../../lib/config.js'

const text = (t) => [{ type: 'text', text: t }]

test('parseReport：JSON 回报 / 无 JSON 按 stopReason 兜底', () => {
  assert.equal(parseReport(text('做完了\n{"status":"done","summary":"修好了","link":"x"}'), 'completed').status, 'done')
  assert.equal(parseReport(text('{"status":"waiting","summary":"待定","question":"选 A 还是 B"}'), 'completed').question, '选 A 还是 B')
  assert.equal(parseReport(text('{"status":"failed","summary":"做不了"}'), 'completed').status, 'failed')
  const fallback = parseReport(text('我改好了'), 'completed')
  assert.equal(fallback.status, 'done')
  assert.equal(fallback.summary, '我改好了')
  assert.equal(parseReport([], 'error').status, 'failed')
})

function ticket(over = {}) {
  return {
    id: 'qq:msg-1', source: 'qq', thread: 'group:1', actor: 'u1', title: '修个 bug', body: 'x', url: '',
    at: new Date().toISOString(), status: 'queued', attempts: 0, relayed: {}, dryRun: false, ...over,
  }
}

function harness({ single = true, assessmentOut = { verdict: 'accept' }, targetOut = { sessionId: 'intake-x', workspace: { path: 'C:/repo' } }, routeOut = { verdict: 'accept' }, subagentOut = { output: text('{"status":"done","summary":"ok"}'), stopReason: 'completed' }, resolveAgentError = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'syh-exec-'))
  const config = normalizeConfig({ dryRun: false, stateDir: dir, singleSession: { enabled: single }, pollIntervalMs: 1000 })
  const t = ticket()
  const store = { state: { tickets: { [t.id]: t }, lastError: null }, save() {} }
  const calls = { spawn: 0, dispose: 0, archive: 0, createSession: 0, prompt: 0, relay: [], notify: [] }
  const agent = { session: {}, ctx: { tools: { register: () => () => {} } } }
  let created = false
  const ctx = {
    sessionController: {
      resolveAgent: async () => {
        if (resolveAgentError) return { error: { code: 'x' } }
        if (!single && !created) return { error: { code: 'session/not-found' } }
        return { agent }
      },
      create: async (req) => { calls.createSession += 1; created = true; return { sessionId: req.sessionId } },
      prompt: async () => { calls.prompt += 1 },
      wait: async () => ({ reason: 'idle', output: { records: [] } }),
      cancel: () => {},
    },
    permissionPresets: { set: () => {} },
    agents: { get: () => agent },
    tools: { register: () => () => {} },
  }
  const subagents = {
    startActivation: async (spec) => {
      calls.spawn += 1
      calls.spec = spec
      return {
        childId: 'child-1',
        result: Promise.resolve(subagentOut),
        dispose: async () => { calls.dispose += 1 },
      }
    },
  }
  const executor = createExecutor({
    ctx, config, store,
    relay: { send: async (tk, kind) => { calls.relay.push(kind) } },
    redact: (x) => x, log: () => {},
    sources: { qq: { send: async (thread, text) => { calls.notify.push(text) } } },
    assessment: { assess: async () => assessmentOut },
    targetResolver: { resolve: async () => targetOut },
    orchestrator: { route: async () => routeOut },
    getSubagents: () => subagents,
    archiveSession: async (id) => { calls.archive += 1; t.archived = id },
  })
  return { executor, store, ticket: t, calls, config }
}

test('单会话：走子智能体，完工 dispose+archive，工单 done', async () => {
  const h = harness()
  const out = await h.executor.runTicket(h.ticket.id)
  assert.equal(out.status, 'done')
  assert.equal(h.calls.spawn, 1)
  assert.equal(h.calls.dispose, 1)
  assert.equal(h.calls.archive, 1)
  assert.equal(h.store.state.tickets[h.ticket.id].status, 'done')
  assert.equal(h.store.state.tickets[h.ticket.id].mode, 'team')
  assert.equal(h.calls.spec.provider, 'spawn')
  assert.equal(h.calls.spec.agentPreset, h.config.workerPreset)
  assert.ok(h.calls.spec.cwd)
})

test('研判 ignore：不派工、工单 failed', async () => {
  const h = harness({ assessmentOut: { verdict: 'ignore', reason: '闲聊' } })
  const out = await h.executor.runTicket(h.ticket.id)
  assert.equal(out.skipped, 'ignore')
  assert.equal(h.calls.spawn, 0)
  assert.match(h.store.state.tickets[h.ticket.id].lastError, /无关消息/)
})

test('找不到目标单会话：不派工、写明原因', async () => {
  const h = harness({ targetOut: { sessionId: null, error: '工作区 C:/x 没有单会话' } })
  const out = await h.executor.runTicket(h.ticket.id)
  assert.equal(out.skipped, 'no-target')
  assert.match(h.store.state.tickets[h.ticket.id].lastError, /没有单会话/)
})

test('调度判定 stop：不派工', async () => {
  const h = harness({ routeOut: { verdict: 'stop', reason: '人要求停' } })
  const out = await h.executor.runTicket(h.ticket.id)
  assert.equal(out.skipped, 'stop')
  assert.equal(h.calls.spawn, 0)
})

test('单会话关闭：回退顶层 worker 会话路径', async () => {
  const h = harness({ single: false })
  const out = await h.executor.runTicket(h.ticket.id)
  assert.equal(h.calls.spawn, 0)
  assert.equal(h.calls.createSession, 1)
  assert.equal(h.store.state.tickets[h.ticket.id].mode, 'worker')
  // 没有 ticket_report 的 wait → failed 且写明未回报
  assert.equal(out.status, 'failed')
  assert.match(h.store.state.tickets[h.ticket.id].lastError, /未调用 ticket_report/)
})

test('目标会话不可用：不派工', async () => {
  const h = harness({ resolveAgentError: true })
  const out = await h.executor.runTicket(h.ticket.id)
  assert.equal(out.skipped, 'no-agent')
  assert.equal(h.calls.spawn, 0)
})
