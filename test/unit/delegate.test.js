import assert from 'node:assert/strict'
import test from 'node:test'

import { createDelegate } from '../../lib/delegate.js'

function harness({ children = [], roles, limit = 2, activationError, activationDelay = false } = {}) {
  const calls = { activations: [], roleDispatches: [], missing: 0 }
  let liveChildren = [...children]
  const ctx = {
    sessionController: {
      list: async () => ({ items: liveChildren }),
    },
    agents: { get: () => null },
    permissionPresets: { set: () => {} },
  }
  const config = { workerPreset: 'worker-x', singleSession: { maxSubagents: limit } }
  const store = { state: {}, save() {} }
  const delegate = createDelegate({
    ctx,
    config,
    store,
    log: () => {},
    roles: roles ?? {
      dispatch: async (role, task) => {
        calls.roleDispatches.push({ role, task })
        return { role, sessionId: 'role-1', created: true }
      },
    },
    getSubagents: () => ({
      startActivation: async (spec) => {
        if (activationError) throw activationError
        calls.activations.push(spec)
        liveChildren.push({ sessionId: `child-${calls.activations.length}`, parentSessionId: spec.parent?.id ?? 'intake-1', running: true })
        return { childId: `child-${calls.activations.length}`, dispose: async () => {} }
      },
    }),
    archiveSession: async () => {},
    workspaceOf: () => 'w1',
  })
  return { delegate, calls, config, store, ctx, liveChildren }
}

const exec = (id = 'intake-1') => ({ agent: { id, session: { id } } })

test('delegate：不带 role 走临时子智能体，带 worker preset', async () => {
  const h = harness({ limit: 3 })
  const result = await h.delegate.tool.execute({ prompt: '跑单测', title: '单测' }, exec())
  assert.equal(result.mode, 'worker')
  assert.equal(result.status, 'started')
  assert.equal(h.calls.activations.length, 1)
  assert.equal(h.calls.activations[0].provider, 'spawn')
  assert.equal(h.calls.activations[0].agentPreset, 'worker-x')
  h.delegate.dispose()
})

test('delegate：带 role 交给常驻角色，不占子智能体名额', async () => {
  const h = harness({ limit: 0 })
  const result = await h.delegate.tool.execute({ prompt: '巡检', role: 'qa' }, exec())
  assert.equal(result.mode, 'role')
  assert.equal(h.calls.roleDispatches.length, 1)
  assert.equal(h.calls.roleDispatches[0].role, 'qa')
  h.delegate.dispose()
})

test('delegate：并发到上限时排队，不调 startActivation', async () => {
  const h = harness({ limit: 1, children: [{ sessionId: 'c1', parentSessionId: 'intake-1', running: true }] })
  const result = await h.delegate.tool.execute({ prompt: '第二个', title: '排队' }, exec())
  assert.equal(result.status, 'queued')
  assert.equal(result.position, 1)
  assert.equal(h.calls.activations.length, 0)
  assert.equal(h.delegate.snapshot().pending, 1)
  h.delegate.dispose()
})

test('delegate：宿主抛 ACTIVATION_LIMIT_REACHED 也转排队而不是报错', async () => {
  const error = Object.assign(new Error('subagent limit reached (active child limit: 2)'), { code: 'ACTIVATION_LIMIT_REACHED' })
  const h = harness({ limit: 5, activationError: error })
  const result = await h.delegate.tool.execute({ prompt: '撞限' }, exec())
  assert.equal(result.status, 'queued')
  assert.equal(h.delegate.snapshot().pending, 1)
  h.delegate.dispose()
})

test('delegate：flush 在有名额时放行排队项', async () => {
  const h = harness({ limit: 1, children: [{ sessionId: 'c1', parentSessionId: 'intake-1', running: true }] })
  await h.delegate.tool.execute({ prompt: '排队项', title: '排' }, exec())
  assert.equal(h.delegate.snapshot().pending, 1)
  h.liveChildren[0].running = false
  await h.delegate.flush()
  assert.equal(h.delegate.snapshot().pending, 0)
  assert.equal(h.calls.activations.length, 1)
  h.delegate.dispose()
})

test('delegate：空 prompt 直接报错', async () => {
  const h = harness()
  await assert.rejects(() => h.delegate.tool.execute({ prompt: '   ' }, exec()), /prompt 不能为空/)
  h.delegate.dispose()
})
