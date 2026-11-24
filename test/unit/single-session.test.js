import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugOf, intakeIdOf, shouldCompact, regionEndOf, createSingleSessionMaintainer } from '../../lib/single-session.js'
import { normalizeConfig } from '../../lib/config.js'

const base = { running: false, queued: false, pendingInput: false, idleForMs: 0, pressureTokens: 0, contextWindow: 1000, idleMinutes: 30, pressureRatio: 0.5 }

test('slug 稳定且不同目录不撞', () => {
  assert.equal(slugOf('C:\\a\\b'), slugOf('C:/a/b/'))
  assert.notEqual(slugOf('C:/a/b'), slugOf('C:/a/c'))
  assert.match(intakeIdOf('intake', 'C:/x/y', 'abcdef12-3456'), /^intake-abcdef12-/)
})

test('shouldCompact：运行中/排队/等人一律不压；压力与空闲两条触发', () => {
  assert.equal(shouldCompact({ ...base, running: true, idleForMs: 9e9 }).need, false)
  assert.equal(shouldCompact({ ...base, queued: true, idleForMs: 9e9 }).need, false)
  assert.equal(shouldCompact({ ...base, pendingInput: true, pressureTokens: 999 }).need, false)
  assert.deepEqual(shouldCompact({ ...base, pressureTokens: 500 }), { need: true, reason: 'pressure' })
  assert.deepEqual(shouldCompact({ ...base, idleForMs: 30 * 60_000 }), { need: true, reason: 'idle' })
  assert.equal(shouldCompact({ ...base, pressureTokens: 100, idleForMs: 1000 }).need, false)
})

test('regionEndOf：保留最近 N 轮', () => {
  const records = [1, 5, 9, 13].map((seq) => ({ event: { type: 'turn/start', seq } }))
  assert.equal(regionEndOf(records, 2), 8)
  assert.equal(regionEndOf(records, 1), 12)
  assert.equal(regionEndOf(records, 0), 13)
  assert.equal(regionEndOf(records, 4), null)
})

function harness({ enabled = true, sessions = [{ sessionId: 's1', workspaceId: 'w1', cwd: 'C:/repo' }], workspaces = [{ id: 'w1', path: 'C:/repo', title: 'repo' }], state = { running: false, queue: [], pendingInput: [], cursor: 7 }, pressure = { pressureTokens: 100, contextWindow: 1000 } } = {}) {
  const calls = { pin: 0, unpin: 0, archive: 0, compact: 0, selected: [] }
  const store = { state: { singleSessions: {}, singleSession: {}, lastError: null }, save() {} }
  const config = normalizeConfig({ singleSession: { enabled, idleMinutes: 30, pressureRatio: 0.5 } })
  const agent = { session: {} }
  const maintainer = createSingleSessionMaintainer({
    ctx: {}, config, store, log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => workspaces,
      listSessions: async () => sessions,
      getState: async () => state,
      getAgent: () => agent,
      getPressure: () => pressure,
      getCompaction: () => ({ compactNow: async () => { calls.compact += 1; return { ok: true } }, compactRegion: async () => ({ ok: true }) }),
      readEvents: async () => [],
      pinSession: async () => { calls.pin += 1 },
      unpinSession: async () => { calls.unpin += 1 },
      archiveSession: async () => { calls.archive += 1 },
      resolveByPath: async () => workspaces[0],
      resolveAgent: async () => ({ agent }),
      presetOf: () => 'standard',
      selectPreset: async (_a, preset) => { calls.selected.push(preset) },
    },
  })
  return { maintainer, store, calls, config }
}

test('register：未开启 / 会话不存在 / 无工作区 / 工作区已占用 都拒绝', async () => {
  const off = harness({ enabled: false })
  await assert.rejects(() => off.maintainer.register('s1'), (e) => e.code === 'not-enabled')

  const missing = harness({ sessions: [] })
  await assert.rejects(() => missing.maintainer.register('s1'), (e) => e.code === 'not-found')

  const noWs = harness({ sessions: [{ sessionId: 's1' }] })
  await assert.rejects(() => noWs.maintainer.register('s1'), (e) => e.code === 'no-workspace')

  const occupied = harness({ sessions: [{ sessionId: 's1', workspaceId: 'w1' }, { sessionId: 's2', workspaceId: 'w1' }] })
  occupied.store.state.singleSessions.w1 = 's1'
  await assert.rejects(() => occupied.maintainer.register('s2'), (e) => e.code === 'workspace-occupied')
})

test('register：登记成功 + pin；重复登记幂等', async () => {
  const h = harness()
  const out = await h.maintainer.register('s1')
  assert.equal(out.workspaceId, 'w1')
  assert.equal(h.store.state.singleSessions.w1, 's1')
  assert.equal(h.calls.pin, 1)
  const again = await h.maintainer.register('s1')
  assert.equal(again.already, true)
  assert.equal(h.calls.pin, 1)
})

test('unregister：撤销登记 + unpin；removeSingle：先注销再归档', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  const out = await h.maintainer.unregister('s1')
  assert.equal(out.workspaceId, 'w1')
  assert.equal(h.store.state.singleSessions.w1, undefined)
  assert.equal(h.calls.unpin, 1)

  await h.maintainer.register('s1')
  const removed = await h.maintainer.removeSingle('s1')
  assert.equal(removed.workspaceId, 'w1')
  assert.equal(h.store.state.singleSessions.w1, undefined)
  assert.equal(h.calls.archive, 1)
})

test('register：切到调度者 preset 并记住原 preset；解除时切回', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  assert.deepEqual(h.calls.selected, ['dsh-superagent-yh-orchestrator'])
  assert.equal(h.store.state.singleSessionPrevPreset.w1, 'standard')

  await h.maintainer.unregister('s1')
  assert.deepEqual(h.calls.selected, ['dsh-superagent-yh-orchestrator', 'standard'])
  assert.equal(h.store.state.singleSessionPrevPreset.w1, undefined)
})

test('list / snapshot：只列已登记的工作区', async () => {
  const h = harness()
  assert.deepEqual(await h.maintainer.list(), [])
  await h.maintainer.register('s1')
  const list = await h.maintainer.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].workspaceId, 'w1')
  const snap = await h.maintainer.snapshot()
  assert.equal(snap.workspaces.length, 1)
})

test('maintain：无登记时不压缩；登记后按压力压缩；运行中不压', async () => {
  const idle = harness({ pressure: { pressureTokens: 900, contextWindow: 1000 } })
  assert.equal((await idle.maintainer.maintain()).workspaces.length, 0)
  await idle.maintainer.register('s1')
  const out = await idle.maintainer.maintain()
  assert.equal(out.workspaces.length, 1)
  assert.equal(idle.calls.compact, 1)

  const busy = harness({ state: { running: true, queue: [], pendingInput: [], cursor: 1 }, pressure: { pressureTokens: 900, contextWindow: 1000 } })
  await busy.maintainer.register('s1')
  await busy.maintainer.maintain()
  assert.equal(busy.calls.compact, 0)
})

test('stateOf：未登记 / 已被别的会话占用', async () => {
  const h = harness({ sessions: [{ sessionId: 's1', workspaceId: 'w1' }, { sessionId: 's2', workspaceId: 'w1' }] })
  let st = await h.maintainer.stateOf('s2')
  assert.equal(st.registered, false)
  assert.equal(st.workspaceOccupied, false)
  await h.maintainer.register('s1')
  st = await h.maintainer.stateOf('s2')
  assert.equal(st.workspaceOccupied, true)
  assert.equal(st.occupant, 's1')
  const own = await h.maintainer.stateOf('s1')
  assert.equal(own.registered, true)
  assert.equal(own.workspaceOccupied, false)
})

test('开关关闭：maintain / snapshot / list 都是空', async () => {
  const off = harness({ enabled: false })
  assert.equal((await off.maintainer.maintain()).enabled, false)
  assert.deepEqual(await off.maintainer.list(), [])
  assert.equal((await off.maintainer.snapshot()).enabled, false)
})
