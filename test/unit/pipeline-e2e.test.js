import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../../lib/store.js'
import { createTicket } from '../../lib/ticket.js'
import { createFileLogger, createExecutor } from '../../lib/executor.js'
import { createAssessment } from '../../lib/assessment.js'
import { createOrchestrator } from '../../lib/orchestrator.js'
import { createTargetResolver } from '../../lib/target.js'
import { createRedactor } from '../../lib/redact.js'
import { normalizeConfig } from '../../lib/config.js'

/** 真实使用模拟：真实 store/ticket/assessment/orchestrator/target + 假子智能体，跑完整生命周期。 */
test('e2e：工单 queued → 研判 → 定位 → 路由 → 子智能体 → done → 回写 → 落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syh-e2e-'))
  const config = normalizeConfig({ dryRun: false, stateDir: dir, singleSession: { enabled: true }, pollIntervalMs: 1000 })
  const store = openStore({ dir })
  const redact = createRedactor([])
  const log = createFileLogger(store, redact)
  const relayEvents = []
  const sent = []

  const trigger = { id: 'issue-7', thread: 'issue-7', actor: 'yh', title: '修构建脚本', body: 'npm run build 挂了', url: 'https://example/7', at: new Date().toISOString(), kind: 'issue' }
  const ticket = createTicket(trigger, { source: 'github' })
  ticket.dryRun = false
  ticket.workspaceHint = 'C:/repo'
  store.state.tickets[ticket.id] = ticket
  store.save()

  const agent = { session: {}, ctx: { tools: { register: () => () => {} } } }
  let archived = 0
  const ctx = {
    sessionController: {
      resolveAgent: async () => ({ agent }),
      list: async () => ({ items: [{ sessionId: 'intake-repo', cwd: 'C:/repo' }] }),
      create: async (req) => ({ sessionId: req.sessionId }),
    },
    permissionPresets: { set: () => {} },
    agents: { get: () => agent },
    tools: { register: () => () => {} },
    workspaceRegistry: { list: () => [{ id: 'w1', path: 'C:/repo' }] },
  }
  let disposed = 0
  const subagents = {
    startActivation: async (spec) => ({
      childId: 'child-9',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"status":"done","summary":"修好了","link":"https://example/pr/1"}' }] }),
      dispose: async () => { disposed += 1 },
    }),
  }

  const assessment = createAssessment({ ctx, config, log, redact })
  const targetResolver = createTargetResolver({ ctx, config, log, redact, deps: { listWorkspaces: () => [{ id: 'w1', path: 'C:/repo' }], registeredSession: async () => 'intake-repo' } })
  const orchestrator = createOrchestrator({ ctx, config, store, log, redact })
  const executor = createExecutor({
    ctx, config, store, log, redact,
    relay: { send: async (_t, kind) => { relayEvents.push(kind) } },
    sources: { github: { send: async (thread, text) => { sent.push({ thread, text }) } } },
    assessment, orchestrator, targetResolver,
    getSubagents: () => subagents,
    archiveSession: async () => { archived += 1 },
  })

  const out = await executor.runTicket(ticket.id)
  assert.equal(out.status, 'done')

  const saved = store.state.tickets[ticket.id]
  assert.equal(saved.status, 'done')
  assert.equal(saved.mode, 'team')
  assert.equal(saved.workspace, 'C:/repo')
  assert.equal(saved.targetSessionId, 'intake-repo')
  assert.equal(saved.childSessionId, 'child-9')
  assert.equal(saved.report.summary, '修好了')
  assert.equal(disposed, 1, '完工必须 dispose 子智能体')
  assert.deepEqual(relayEvents, ['started', 'done'])
  assert.equal(sent.length, 1, '默认回写来源一次')
  assert.match(sent[0].text, /完成|done|修好了/)

  // 落盘：重新打开仍是 done
  store.close()
  const reopened = openStore({ dir })
  assert.equal(reopened.state.tickets[ticket.id].status, 'done')
  reopened.close()
  assert.equal(archived, 1, '完工必须归档子会话')
})

/** 健壮性：dispose 抛错也必须归档、工单仍落地。 */
test('e2e 健壮性：子智能体 dispose 失败不吞结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syh-e2e2-'))
  const config = normalizeConfig({ dryRun: false, stateDir: dir, singleSession: { enabled: true }, pollIntervalMs: 1000 })
  const store = openStore({ dir })
  const redact = createRedactor([])
  const log = createFileLogger(store, redact)
  const trigger = { id: 'issue-8', thread: 'issue-8', actor: 'yh', title: 't', body: 'b', url: '', at: new Date().toISOString(), kind: 'issue' }
  const ticket = createTicket(trigger, { source: 'github' })
  ticket.dryRun = false
  ticket.workspaceHint = 'C:/repo'
  store.state.tickets[ticket.id] = ticket
  let archived = 0
  const agent = { session: {}, ctx: { tools: { register: () => () => {} } } }
  const ctx = {
    sessionController: {
      resolveAgent: async () => ({ agent }),
      list: async () => ({ items: [{ sessionId: 'intake-repo', cwd: 'C:/repo' }] }),
      create: async (req) => ({ sessionId: req.sessionId }),
    },
    permissionPresets: { set: () => {} },
    agents: { get: () => agent },
    tools: { register: () => () => {} },
    workspaceRegistry: { list: () => [{ id: 'w1', path: 'C:/repo' }] },
  }
  const executor = createExecutor({
    ctx, config, store, log, redact,
    relay: { send: async () => {} },
    sources: {},
    assessment: { assess: async () => ({ verdict: 'accept' }) },
    targetResolver: createTargetResolver({ ctx, config, log, redact, deps: { listWorkspaces: () => [{ id: 'w1', path: 'C:/repo' }], registeredSession: async () => 'intake-repo' } }),
    orchestrator: { route: async () => ({ verdict: 'accept' }) },
    archiveSession: async () => { archived += 1 },
    getSubagents: () => ({
      startActivation: async () => ({
        childId: 'child-10',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"status":"done","summary":"ok"}' }] }),
        dispose: async () => { throw new Error('dispose boom') },
      }),
    }),
  })
  const out = await executor.runTicket(ticket.id)
  assert.equal(out.status, 'done')
  assert.equal(archived, 1, 'dispose 失败仍要归档')
  assert.equal(store.state.tickets[ticket.id].status, 'done')
  store.close()
})
