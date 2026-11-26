import assert from 'node:assert/strict'
import test from 'node:test'

import { createDelegate } from '../../lib/delegate.js'
import { archiveChildSession } from '../../lib/child-archive.js'

test('D52：归档幂等——已经归档过的子会话不再重复打宿主、不重复刷日志', async () => {
  const calls = { archives: 0, logs: [] }
  const state = {}
  const save = () => { calls.saved = (calls.saved ?? 0) + 1 }
  const archive = async () => { calls.archives += 1 }
  const deps = { state, save, archive, log: (line) => calls.logs.push(line) }
  assert.equal(await archiveChildSession(deps, 'child-9', 'idle'), true)
  assert.equal(await archiveChildSession(deps, 'child-9', 'idle'), true)
  assert.equal(calls.archives, 1)
  assert.equal(calls.logs.length, 1)
  assert.equal(state.singleSessionChildArchived['child-9'] > 0, true)
})

function harness({ childId = 'child-1', archiveError = null, config: configPatch = {}, roles = undefined } = {}) {
  const calls = { activations: [], archives: [], logs: [] }
  const liveChildren = []
  const ctx = {
    sessionController: {
      list: async () => ({ items: liveChildren }),
    },
    agents: { get: () => null },
    permissionPresets: { set: () => {} },
  }
  const config = { workerPreset: 'worker-x', singleSession: { maxSubagents: 6, ...configPatch } }
  const store = { state: {}, save() {} }
  const delegate = createDelegate({
    ctx,
    config,
    store,
    log: (ns, message) => calls.logs.push(`${ns}: ${message}`),
    redact: (value) => value,
    roles: roles ?? { dispatch: async () => ({ role: 'qa', sessionId: 'role-1' }) },
    getSubagents: () => ({
      startActivation: async (spec) => {
        calls.activations.push(spec)
        liveChildren.push({
          sessionId: childId,
          parentSessionId: spec.parent?.id ?? 'intake-1',
          origin: 'subagent',
          running: true,
        })
        return { childId, dispose: async () => {} }
      },
    }),
    archiveSession: async (id, options) => {
      calls.archives.push({ id, options })
      if (archiveError) throw new Error(archiveError)
    },
    workspaceOf: () => 'w1',
  })
  return { delegate, calls, store, liveChildren }
}

const exec = (id = 'intake-1') => ({ agent: { id, session: { id } } })

async function settle(h, childId = 'child-1') {
  const child = h.liveChildren.find((item) => item.sessionId === childId)
  if (child) child.running = false
  await h.delegate.onChildSettled(childId)
}

test('D51：worker 结算即归档，带 stopActivity:true', async () => {
  const h = harness()
  await h.delegate.tool.execute({ prompt: '跑单测', title: '单测' }, exec())
  assert.equal(h.calls.archives.length, 0, '结算前不归档')
  await settle(h)
  assert.deepEqual(h.calls.archives, [{ id: 'child-1', options: { stopActivity: true } }])
  assert.ok(h.calls.logs.some((line) => line.includes('archived child child-1 (settled)')))
  h.delegate.dispose()
})

test('D51：workerArchive:false 时保持旧行为，不归档', async () => {
  const h = harness({ config: { workerArchive: false } })
  await h.delegate.tool.execute({ prompt: '跑单测' }, exec())
  await settle(h)
  assert.equal(h.calls.archives.length, 0)
  h.delegate.dispose()
})

test('D51：role- 前缀的常驻角色会话永不被结算归档', async () => {
  const h = harness({ childId: 'role-qa-1' })
  await h.delegate.tool.execute({ prompt: '巡检' }, exec())
  await settle(h, 'role-qa-1')
  assert.equal(h.calls.archives.length, 0)
  assert.ok(h.calls.logs.some((line) => line.includes('skip archive role-qa-1')))
  h.delegate.dispose()
})

test('D51：登记在 state.roles 里的角色会话永不被结算归档', async () => {
  const h = harness()
  await h.delegate.tool.execute({ prompt: '跑单测' }, exec())
  h.store.state.roles = { qa: 'child-1' }
  await settle(h)
  assert.equal(h.calls.archives.length, 0)
  assert.ok(h.calls.logs.some((line) => line.includes('skip archive child-1')))
  h.delegate.dispose()
})

test('D51：非 delegate 派出的子会话（不在 inflight）不归档', async () => {
  const h = harness()
  await h.delegate.onChildSettled('host-subagent-tool-child')
  assert.equal(h.calls.archives.length, 0)
  h.delegate.dispose()
})

test('D51：归档失败不抛、写退避记录与 lastError；退避窗口内不重复打宿主', async () => {
  const h = harness({ archiveError: 'archive boom' })
  await h.delegate.tool.execute({ prompt: '跑单测' }, exec())
  await settle(h)
  assert.equal(h.calls.archives.length, 1)
  assert.equal(h.store.state.singleSessionChildArchive['child-1'].attempts, 1)
  assert.match(h.store.state.lastError, /子会话归档失败（child-1）：archive boom/)

  // 已累计 3 次失败：10 分钟窗口内直接退避，不再打宿主。
  h.store.state.singleSessionChildArchive['child-1'] = { attempts: 3, at: Date.now() }
  await h.delegate.tool.execute({ prompt: '再跑一次' }, exec())
  await settle(h)
  assert.equal(h.calls.archives.length, 1)
  h.delegate.dispose()
})
