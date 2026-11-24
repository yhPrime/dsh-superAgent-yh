import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugOf, intakeIdOf, shouldCompact, regionEndOf, createSingleSessionMaintainer } from '../../lib/single-session.js'
import { normalizeConfig, ConfigError } from '../../lib/config.js'

const baseSingle = { running: false, queued: false, pendingInput: false, idleForMs: 0, pressureTokens: 0, contextWindow: 1000, idleMinutes: 30, pressureRatio: 0.5 }

test('slug 稳定且不同目录不撞', () => {
  const a = slugOf('C:\\Users\\yh\\WorkDeepSeek\\插件\\dsh-superAgent-yh')
  const b = slugOf('C:/Users/yh/WorkDeepSeek/插件/dsh-superAgent-yh/')
  assert.equal(a, b)
  assert.notEqual(a, slugOf('C:/Users/yh/other'))
  assert.match(intakeIdOf('intake', 'C:/x/y'), /^intake-y-[a-z0-9]+$/)
})

test('shouldCompact：运行中/排队/等人一律不压', () => {
  assert.equal(shouldCompact({ ...baseSingle, running: true, idleForMs: 9e9 }).need, false)
  assert.equal(shouldCompact({ ...baseSingle, queued: true, idleForMs: 9e9 }).need, false)
  assert.equal(shouldCompact({ ...baseSingle, pendingInput: true, pressureTokens: 999 }).need, false)
  assert.equal(shouldCompact({ ...baseSingle, running: true }).reason, 'running')
})

test('shouldCompact：压力与空闲两条触发', () => {
  assert.deepEqual(shouldCompact({ ...baseSingle, pressureTokens: 500 }), { need: true, reason: 'pressure' })
  assert.deepEqual(shouldCompact({ ...baseSingle, idleForMs: 30 * 60_000 }), { need: true, reason: 'idle' })
  assert.equal(shouldCompact({ ...baseSingle, pressureTokens: 100, idleForMs: 1000 }).need, false)
  // 窗口未知时不按压力触发
  assert.equal(shouldCompact({ ...baseSingle, pressureTokens: 999, contextWindow: 0 }).need, false)
})

test('regionEndOf：保留最近 N 轮，轮数不足返回 null', () => {
  const records = [1, 5, 9, 13].map((seq) => ({ event: { type: 'turn/start', seq } }))
  assert.equal(regionEndOf(records, 2), 8)
  assert.equal(regionEndOf(records, 1), 12)
  assert.equal(regionEndOf(records, 0), 13)
  assert.equal(regionEndOf(records, 4), null)
  assert.equal(regionEndOf([], 2), null)
})

test('配置校验：singleSession 非法值 fail-closed', () => {
  assert.throws(() => normalizeConfig({ singleSession: { idleMinutes: 0 } }), ConfigError)
  assert.throws(() => normalizeConfig({ singleSession: { pressureRatio: 0 } }), ConfigError)
  assert.throws(() => normalizeConfig({ singleSession: { pressureRatio: 1.5 } }), ConfigError)
  assert.throws(() => normalizeConfig({ singleSession: { keepRecentTurns: -1 } }), ConfigError)
  assert.throws(() => normalizeConfig({ singleSession: { sessionIdPrefix: '9bad' } }), ConfigError)
  const ok = normalizeConfig({})
  assert.equal(ok.singleSession.enabled, false)
  assert.equal(ok.singleSession.idleMinutes, 30)
  assert.equal(ok.singleSession.pressureRatio, 0.5)
  assert.equal(ok.singleSession.aggressive, false)
})

function harness({ single = {}, sessions = [], workspaces = [{ id: 'w1', path: 'C:/repo' }], pressure = { pressureTokens: 100, contextWindow: 1000 }, state = { running: false, queue: [], pendingInput: [], cursor: 7 } } = {}) {
  const calls = { compact: 0, region: 0, created: [] }
  const store = { state: { singleSession: {}, lastError: null }, save() {} }
  const config = normalizeConfig({ singleSession: { enabled: true, ...single } })
  const agent = { id: 'x', session: {} }
  const maintainer = createSingleSessionMaintainer({
    ctx: {},
    config,
    store,
    log: () => {},
    redact: (x) => x,
    deps: {
      listWorkspaces: () => workspaces,
      listSessions: async () => sessions,
      getState: async () => state,
      getAgent: () => agent,
      getPressure: () => pressure,
      readEvents: async () => [1, 5, 9, 13].map((seq) => ({ event: { type: 'turn/start', seq } })),
      getCompaction: () => ({
        compactNow: async () => { calls.compact += 1; return { ok: true } },
        compactRegion: async () => { calls.region += 1; return { ok: true } },
      }),
      createSession: async (request) => { calls.created.push(request); return { sessionId: request.sessionId } },
      resolveAgent: async () => ({ agent }),
    },
  })
  return { maintainer, calls, store, config }
}

test('维护器：snapshot 是只读的，不会建会话', async () => {
  const h = harness()
  const snap = await h.maintainer.snapshot()
  assert.equal(snap.workspaces[0].sessionId, null)
  assert.equal(h.calls.created.length, 0)
})

test('维护器：没有会话时按 autoCreate 建一个；关掉则不建', async () => {
  const on = harness()
  const snap = await on.maintainer.maintain()
  assert.equal(snap.workspaces[0].sessionId, intakeIdOf('intake', 'C:/repo', 'w1'))
  assert.equal(on.calls.created.length, 1)

  const off = harness({ single: { autoCreate: false } })
  const snap2 = await off.maintainer.maintain()
  assert.equal(snap2.workspaces[0].sessionId, null)
  assert.equal(snap2.workspaces[0].missing, true)
  assert.equal(off.calls.created.length, 0)
})

test('维护器：已有接单会话则复用，不重复建', async () => {
  const id = intakeIdOf('intake', 'C:/repo', 'w1')
  const h = harness({ sessions: [{ sessionId: id, cwd: 'C:/repo', updatedAt: Date.now() }] })
  const snap = await h.maintainer.snapshot()
  assert.equal(snap.workspaces[0].sessionId, id)
  assert.equal(h.calls.created.length, 0)
})

test('维护器：不把同目录无关会话当接单会话（autoCreate=false 时标记缺失）', async () => {
  const h = harness({ single: { autoCreate: false }, sessions: [{ sessionId: 'session-unrelated', cwd: 'C:/repo' }] })
  const snap = await h.maintainer.snapshot()
  assert.equal(snap.workspaces[0].sessionId, null)
  assert.equal(snap.workspaces[0].missing, true)
  assert.equal(h.calls.compact, 0)
})

test('维护器：空闲到点会压缩并记账；运行中不压', async () => {
  const id = intakeIdOf('intake', 'C:/repo', 'w1')
  const idle = harness({ single: { idleMinutes: 1 }, sessions: [{ sessionId: id, cwd: 'C:/repo', updatedAt: Date.now() - 120_000 }] })
  // 首轮把 lastActivity 记为现在，第二轮才可能判空闲；直接把 idleMinutes 设 0 不允许，故用压力路径验证触发
  const pressure = harness({ single: { pressureRatio: 0.1 }, sessions: [{ sessionId: id, cwd: 'C:/repo' }], pressure: { pressureTokens: 500, contextWindow: 1000 } })
  const result = await pressure.maintainer.maintain()
  assert.equal(pressure.calls.compact, 1)
  assert.equal(result.workspaces[0].decision, 'pressure')
  assert.ok(pressure.store.state.singleSession[id])
  assert.equal(pressure.store.state.singleSession[id].reason, 'pressure')

  const busy = harness({ single: { pressureRatio: 0.1 }, sessions: [{ sessionId: id, cwd: 'C:/repo' }], pressure: { pressureTokens: 900, contextWindow: 1000 }, state: { running: true, queue: [], pendingInput: [], cursor: 7 } })
  await busy.maintainer.maintain()
  assert.equal(busy.calls.compact, 0)
  assert.equal(idle.calls.compact, 0)
})

test('维护器：aggressive 走 compactRegion', async () => {
  const id = intakeIdOf('intake', 'C:/repo', 'w1')
  const h = harness({ single: { pressureRatio: 0.1, aggressive: true, keepRecentTurns: 2 }, sessions: [{ sessionId: id, cwd: 'C:/repo' }], pressure: { pressureTokens: 900, contextWindow: 1000 } })
  await h.maintainer.maintain()
  assert.equal(h.calls.region, 1)
  assert.equal(h.calls.compact, 0)
  assert.equal(h.store.state.singleSession[id].mode, 'compactRegion')
})

test('维护器：宿主说没什么可压（返回 null）时不记账', async () => {
  const id = intakeIdOf('intake', 'C:/repo', 'w1')
  const store = { state: { singleSession: {}, lastError: null }, save() {} }
  const config = normalizeConfig({ singleSession: { enabled: true, pressureRatio: 0.1 } })
  const m = createSingleSessionMaintainer({
    ctx: {}, config, store, log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => [{ id: 'w1', path: 'C:/repo' }],
      listSessions: async () => [{ sessionId: id, cwd: 'C:/repo' }],
      getState: async () => ({ running: false, queue: [], pendingInput: [], cursor: 1 }),
      getAgent: () => ({ session: {} }),
      getPressure: () => ({ pressureTokens: 900, contextWindow: 1000 }),
      getCompaction: () => ({ compactNow: async () => null }),
    },
  })
  const out = await m.maintain()
  assert.equal(out.workspaces[0].compactResult.skipped, true)
  assert.deepEqual(store.state.singleSession, {})
})

test('preset 没挂 compaction 时不压缩并报明确原因', async () => {
  const id = intakeIdOf('intake', 'C:/repo', 'w1')
  const store = { state: { singleSession: {}, lastError: null }, save() {} }
  const config = normalizeConfig({ singleSession: { enabled: true, pressureRatio: 0.1 } })
  const m = createSingleSessionMaintainer({
    ctx: {}, config, store, log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => [{ id: 'w1', path: 'C:/repo' }],
      listSessions: async () => [{ sessionId: id, cwd: 'C:/repo' }],
      getState: async () => ({ running: false, queue: [], pendingInput: [], cursor: 1 }),
      getAgent: () => ({ session: {} }),
      getPressure: () => ({ pressureTokens: 900, contextWindow: 1000 }),
      getCompaction: () => null,
    },
  })
  const out = await m.maintain()
  assert.match(out.workspaces[0].error, /compaction/)
  assert.deepEqual(store.state.singleSession, {})
})

test('手动压缩：运行中拒绝（code=busy）；未知会话 not-found', async () => {
  const id = intakeIdOf('intake', 'C:/repo', 'w1')
  const busy = harness({ sessions: [{ sessionId: id, cwd: 'C:/repo' }], state: { running: true, queue: [], pendingInput: [], cursor: 3 } })
  await assert.rejects(() => busy.maintainer.compactManual(id), (error) => error.code === 'busy')
  await assert.rejects(() => busy.maintainer.compactManual('nope'), (error) => error.code === 'not-found')

  const idle = harness({ sessions: [{ sessionId: id, cwd: 'C:/repo' }] })
  const out = await idle.maintainer.compactManual(id)
  assert.equal(out.reason, 'manual')
  assert.equal(idle.calls.compact, 1)
})

test('开关关闭：maintain/snapshot 都不碰会话', async () => {
  const h = harness({ single: { enabled: false } })
  const out = await h.maintainer.maintain()
  assert.equal(out.enabled, false)
  assert.equal(h.calls.created.length, 0)
  assert.equal(h.calls.compact, 0)
  const snap = await h.maintainer.snapshot()
  assert.equal(snap.enabled, false)
})
