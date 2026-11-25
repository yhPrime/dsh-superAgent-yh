import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRoles, roleSessionIdOf } from '../../lib/roles.js'

function harness({ maxRoles = 6, sessions = [], createError, archiveError } = {}) {
  const calls = { create: [], prompts: [], archived: [], journal: [] }
  const state = {}
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-ws-'))
  const ctx = {
    sessionController: {
      list: async () => ({ items: sessions }),
      create: async (request) => {
        if (createError) throw createError
        calls.create.push(request)
        return { sessionId: request.sessionId, agentPreset: request.agentPreset }
      },
      resolveAgent: async () => ({}),
      prompt: async (request) => { calls.prompts.push(request) },
      state: async () => ({ running: false }),
      events: async () => ({ records: [] }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', path: workspacePath }],
      archiveSession: async (sessionId) => {
        if (archiveError) throw archiveError
        calls.archived.push(sessionId)
      },
    },
  }
  const config = { workerPreset: 'worker-x', singleSession: { maxRoles } }
  const store = { state, save() {} }
  const roles = createRoles({ ctx, config, store, log: () => {}, deps: { notify: async () => {} } })
  return { roles, calls, state, workspacePath, ctx, config, store }
}

test('roles：第一次派活按需建独立会话，带工作区与 worker preset', async () => {
  const h = harness()
  const result = await h.roles.ensure('plugin-engineer', { workspaceId: 'w1' })
  assert.equal(result.created, true)
  assert.equal(h.calls.create.length, 1)
  assert.deepEqual(h.calls.create[0].workspaceId, 'w1')
  assert.equal(h.calls.create[0].agentPreset, 'worker-x')
  assert.match(result.entry.sessionId, /^role-plugin-engineer-/)
  assert.equal(h.state.roles['plugin-engineer'].sessionId, result.entry.sessionId)
})

test('roles：同名角色第二次复用同一会话，不再新建', async () => {
  const h = harness()
  const first = await h.roles.ensure('qa', { workspaceId: 'w1' })
  const second = await h.roles.ensure('qa', { workspaceId: 'w1' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.entry.sessionId, first.entry.sessionId)
  assert.equal(h.calls.create.length, 1)
})

test('roles：超过 maxRoles 拒绝新建', async () => {
  const h = harness({ maxRoles: 1 })
  await h.roles.ensure('qa', { workspaceId: 'w1' })
  await assert.rejects(() => h.roles.ensure('designer', { workspaceId: 'w1' }), (error) => {
    assert.equal(error.code, 'role-limit')
    return true
  })
})

test('roles：没有工作区拒绝新建', async () => {
  const h = harness()
  await assert.rejects(() => h.roles.ensure('qa', {}), (error) => error.code === 'role-no-workspace')
})

test('roles：跨工作区复用同名角色被拒', async () => {
  const h = harness()
  await h.roles.ensure('qa', { workspaceId: 'w1' })
  await assert.rejects(() => h.roles.ensure('qa', { workspaceId: 'w2' }), (error) => error.code === 'role-other-workspace')
})

test('roles：dispatch 投 prompt 并写日记；快照合并运行态', async () => {
  const h = harness({ sessions: [] })
  const result = await h.roles.dispatch('qa', '跑一轮单测', { workspaceId: 'w1', intakeSessionId: 'intake-1' })
  assert.equal(result.created, true)
  assert.equal(h.calls.prompts.length, 1)
  assert.equal(h.calls.prompts[0].sessionId, result.sessionId)
  assert.match(h.calls.prompts[0].content[0].text, /跑一轮单测/)
  const journal = path.join(h.workspacePath, 'docs', '角色笔记', 'qa', '日记.md')
  assert.match(fs.readFileSync(journal, 'utf8'), /派活：跑一轮单测/)
  const snapshot = await h.roles.snapshot()
  assert.equal(snapshot[0].role, 'qa')
  assert.equal(snapshot[0].running, false)
  h.roles.dispose()
})

test('roles：解除角色先归档再删注册表；归档失败保留注册', async () => {
  const h = harness({ archiveError: new Error('boom') })
  await h.roles.ensure('qa', { workspaceId: 'w1' })
  await assert.rejects(() => h.roles.remove('qa'), (error) => error.code === 'role-archive-failed')
  assert.ok(h.state.roles.qa)
  const ok = harness()
  await ok.roles.ensure('qa', { workspaceId: 'w1' })
  assert.deepEqual(await ok.roles.remove('qa'), { ok: true })
  assert.deepEqual(ok.calls.archived.length, 1)
  assert.equal(ok.state.roles.qa, undefined)
})

test('roleSessionIdOf：名字安全化并带随机后缀', () => {
  const id = roleSessionIdOf('Plugin Engineer!!')
  assert.match(id, /^role-plugin-engineer-[0-9a-f]{8}$/)
  assert.notEqual(id, roleSessionIdOf('Plugin Engineer!!'))
})
