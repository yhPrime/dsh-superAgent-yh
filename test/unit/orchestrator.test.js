import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeModeOf, parseRoute, lastAssistantText, createOrchestrator } from '../../lib/orchestrator.js'
import { normalizeConfig } from '../../lib/config.js'

const ticket = { id: 'github:issue-1', source: 'github', thread: 'issue-1', actor: 'yh', title: '修个 bug', body: '出错了', url: 'https://x/1', attempts: 0 }

function harness({ config = {}, records = [], promptThrows = false } = {}) {
  const store = { state: { tickets: { 'github:issue-0': { id: 'github:issue-0', thread: 'issue-1', status: 'running', title: '旧活' } }, lastError: null }, save() {} }
  const calls = { prompt: 0, wait: 0 }
  const orch = createOrchestrator({
    ctx: {}, config: normalizeConfig(config), store, log: () => {}, redact: (x) => x,
    deps: {
      prompt: async () => { calls.prompt += 1; if (promptThrows) throw new Error('prompt failed') },
      wait: async () => { calls.wait += 1; return { reason: 'idle', output: { records } } },
    },
  })
  return { orch, calls, store }
}

const assistant = (text) => ({ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } } })

test('routeModeOf：默认 agent，可切 rules', () => {
  assert.equal(routeModeOf(normalizeConfig({})), 'agent')
  assert.equal(routeModeOf(normalizeConfig({ orchestrator: 'rules' })), 'rules')
})

test('parseRoute：四种判定 + 非法', () => {
  assert.equal(parseRoute('{"verdict":"attach","ticketId":"github:1"}').verdict, 'attach')
  assert.equal(parseRoute('{"verdict":"stop","reason":"人要求停"}').verdict, 'stop')
  assert.equal(parseRoute('{"verdict":"bogus"}'), null)
  assert.equal(parseRoute('x'), null)
})

test('lastAssistantText：取最后一条 assistant 文本', () => {
  assert.equal(lastAssistantText([assistant('第一'), assistant('第二')]), '第二')
  assert.equal(lastAssistantText([{ event: { type: 'user/message' } }]), '')
})

test('rules 模式：不调模型，直接 accept + workerPreset', async () => {
  const { orch, calls } = harness({ config: { orchestrator: 'rules' } })
  const out = await orch.route(ticket, { sessionId: 'intake-x', agent: {} })
  assert.equal(out.verdict, 'accept')
  assert.equal(out.mode, 'rules')
  assert.equal(calls.prompt, 0)
  assert.ok(out.preset)
})

test('agent 模式：解析会话判定', async () => {
  const { orch, calls } = harness({ records: [assistant('{"verdict":"attach","ticketId":"github:issue-0","reason":"指向旧工单"}')] })
  const out = await orch.route(ticket, { sessionId: 'intake-x', agent: {} })
  assert.equal(out.verdict, 'attach')
  assert.equal(out.ticketId, 'github:issue-0')
  assert.equal(out.mode, 'agent')
  assert.equal(calls.prompt, 1)
})

test('agent 模式：不可解析 → 回退 rules 并记 lastError', async () => {
  const { orch, store } = harness({ records: [assistant('我看一下')] })
  const out = await orch.route(ticket, { sessionId: 'intake-x', agent: {} })
  assert.equal(out.verdict, 'accept')
  assert.equal(out.mode, 'rules')
  assert.equal(out.reason, 'fallback')
  assert.match(store.state.lastError, /orchestrator/)
  assert.equal(orch.stats().fallbacks, 1)
})

test('agent 模式：prompt 抛错 → 回退 rules，不炸', async () => {
  const { orch } = harness({ promptThrows: true })
  const out = await orch.route(ticket, { sessionId: 'intake-x', agent: {} })
  assert.equal(out.verdict, 'accept')
  assert.equal(out.mode, 'rules')
})

test('没有目标会话 → 直接 rules', async () => {
  const { orch, calls } = harness()
  const out = await orch.route(ticket, null)
  assert.equal(out.mode, 'rules')
  assert.equal(calls.prompt, 0)
})
