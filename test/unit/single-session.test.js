import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slugOf, intakeIdOf, shouldCompact, regionEndOf, createSingleSessionMaintainer,
  truncateUtf8, singleSessionTitle, guardSessionActivity, SINGLE_SESSION_TITLE_SUFFIX,
  normalizeTitleText, sessionTitleOf, childAddressOf,
} from '../../lib/single-session.js'
import { normalizeConfig } from '../../lib/config.js'
import { registerCompactionEngine } from '../../lib/compaction-bridge.js'

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

function harness({
  enabled = true, sessions = [{ sessionId: 's1', workspaceId: 'w1', cwd: 'C:/repo' }],
  workspaces = [{ id: 'w1', path: 'C:/repo', title: 'repo' }],
  state = { running: false, queue: [], pendingInput: [], cursor: 7 },
  pressure = { pressureTokens: 100, contextWindow: 1000 }, blank = true,
  selectError = null, selectSequence = [], pinError = null, renameError = null,
  agentAlive = true, config: configPatch = {},
  renameNormalize = (title) => title, renameNoReturn = false, applyRename = true,
  children = [], childRecords = {}, childArchiveError = null, childReadError = null,
  presetId = 'standard', useRealCompaction = false, compactionEngine = null,
  unarchiveError = null,
} = {}) {
  const calls = { pin: 0, unpin: 0, archive: 0, archiveChild: 0, unarchive: 0, compact: 0, selected: [], rename: 0, titles: [], accepted: [], relay: [], childReads: [], logs: [] }
  const store = { state: { singleSessions: {}, singleSession: {}, lastError: null }, save() {} }
  const config = normalizeConfig({ ...configPatch, singleSession: { enabled, idleMinutes: 30, pressureRatio: 0.5, ...(configPatch.singleSession ?? {}) } })
  const agent = { session: {} }
  let selectCalls = 0
  // 可拨动的时钟：退避/观察窗口要用真实时间推进来验证。
  let nowMs = 1_000_000
  const clock = { now: () => nowMs, set: (ms) => { nowMs = ms }, advance: (ms) => { nowMs += ms } }
  // 真机形状：标题在 projections.values.title，summary 顶层没有 title。
  const setProjectedTitle = (sessionId, title) => {
    const summary = sessions.find((item) => item.sessionId === sessionId)
    if (!summary) return
    summary.projections ??= { values: {} }
    summary.projections.values.title = { ver: 1, seq: calls.rename, val: title }
  }
  const maintainer = createSingleSessionMaintainer({
    ctx: {}, config, store, log: (ns, msg) => calls.logs.push(`${ns}: ${msg}`), redact: (x) => x,
    deps: {
      now: () => clock.now(),
      listWorkspaces: () => workspaces,
      listSessions: async () => [...sessions, ...children],
      getState: async () => state,
      getAgent: () => (agentAlive ? agent : null),
      getPressure: () => pressure,
      ...(useRealCompaction ? {} : { getCompaction: () => compactionEngine ?? { compactNow: async () => { calls.compact += 1; return { ok: true } }, compactRegion: async () => ({ ok: true }) } }),
      readEvents: async (sessionId) => childRecords[sessionId] ?? [],
      // v0.9.4：子会话必须走 subagent 地址；D49 起整页（含 cursor）一起回给诊断。
      readChildPage: async (child) => {
        calls.childReads.push(child)
        if (childReadError) throw new Error(childReadError)
        return { records: childRecords[child.sessionId] ?? [], page: { cursor: 'p1' } }
      },
      pinSession: async () => { if (pinError) throw new Error(pinError); calls.pin += 1 },
      unpinSession: async () => { calls.unpin += 1 },
      archiveSession: async () => { calls.archive += 1 },
      unarchiveSession: async () => { if (unarchiveError) throw new Error(unarchiveError); calls.unarchive += 1 },
      archiveChild: async (sessionId) => {
        if (childArchiveError) throw new Error(childArchiveError)
        calls.archiveChild += 1
        calls.archivedChildren = [...(calls.archivedChildren ?? []), sessionId]
      },
      relay: { send: async (ticket, kind) => { calls.relay.push({ id: ticket.id, kind }) } },
      resolveByPath: async () => workspaces[0],
      resolveAgent: async () => ({ agent }),
      presetOf: () => presetId,
      isBlank: () => blank,
      renameSession: async ({ sessionId, title }) => {
        if (renameError) throw new Error(renameError)
        calls.rename += 1
        calls.titles.push(title)
        const accepted = renameNormalize(title)
        calls.accepted.push(accepted)
        // applyRename=false 模拟宿主 summary 投影滞后：事件已写，但 list() 还读到旧值。
        if (applyRename) setProjectedTitle(sessionId, accepted)
        if (renameNoReturn) return undefined
        return { title: accepted, seq: calls.rename }
      },
      selectPreset: async (_a, preset) => {
        const step = selectSequence[selectCalls]
        selectCalls += 1
        if (step instanceof Error) throw step
        if (step === undefined && selectError) throw new Error(selectError)
        calls.selected.push(preset)
      },
    },
  })
  return { maintainer, store, calls, config, sessions, workspaces, clock, setProjectedTitle }
}

/** 测试里取真机形状的标题。 */
const projectedTitle = (session) => session?.projections?.values?.title?.val ?? session?.projections?.values?.title ?? null


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

test('register：切到纯调度 preset（默认 dispatcher）并记住原 preset；解除时切回', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  assert.deepEqual(h.calls.selected, ['dsh-superagent-yh-dispatcher'])
  assert.equal(h.store.state.singleSessionPrevPreset.w1, 'standard')

  await h.maintainer.unregister('s1')
  assert.deepEqual(h.calls.selected, ['dsh-superagent-yh-dispatcher', 'standard'])
  assert.equal(h.store.state.singleSessionPrevPreset.w1, undefined)
})

test('register：singleSession.preset 可覆盖默认值', async () => {
  const h = harness({ config: { singleSession: { enabled: true, preset: 'ptc' } } })
  await h.maintainer.register('s1')
  assert.deepEqual(h.calls.selected, ['ptc'])
})

test('register：已开始的会话拒绝登记（宿主不允许中途切 preset）', async () => {
  const h = harness({ blank: false })
  await assert.rejects(() => h.maintainer.register('s1'), (e) => e.code === 'started')
  assert.equal(h.store.state.singleSessions.w1, undefined)
  assert.equal(h.calls.pin, 0)
})

test('register：preset 切不上就撤销登记并报错', async () => {
  const h = harness({ selectError: 'This session has already started' })
  await assert.rejects(() => h.maintainer.register('s1'), (e) => e.code === 'preset-failed')
  assert.equal(h.store.state.singleSessions.w1, undefined)
  assert.equal(h.calls.unpin, 1)
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

test('maintain：compaction 引擎由 preset 桥提供（D48）', async () => {
  const engine = { compactNow: async () => ({ ok: true }), compactRegion: async () => ({ ok: true }) }
  const off = registerCompactionEngine('dsh-superagent-yh-dispatcher', engine)
  try {
    const h = harness({
      pressure: { pressureTokens: 900, contextWindow: 1000 },
      presetId: 'dsh-superagent-yh-dispatcher',
      useRealCompaction: true,
    })
    await h.maintainer.register('s1')
    await h.maintainer.maintain()
    assert.equal(h.store.state.singleSession.s1.beforeTokens, 900)
    assert.equal(h.store.state.singleSession.s1.mode, 'compactNow')
  } finally {
    off()
  }
})

test('maintain：没有 compaction 引擎时每会话只告警一次（D48）', async () => {
  const h = harness({
    pressure: { pressureTokens: 900, contextWindow: 1000 },
    presetId: 'no-such-preset',
    useRealCompaction: true,
  })
  await h.maintainer.register('s1')
  await h.maintainer.maintain()
  await h.maintainer.maintain()
  assert.equal(h.calls.logs.filter((line) => /compact skipped/.test(line)).length, 1)
  assert.equal(h.store.state.singleSession.s1, undefined)
})

test('子会话纳管：unknown 最多 8 次，到顶转人工清单并暴露 unknownChildren（D49）', async () => {
  const ghost = { sessionId: 'c12', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 5 * 60_000, title: '查不到' }
  const h = harness({ children: [ghost], childRecords: { c12: [] } })
  await h.maintainer.register('s1')
  for (let i = 0; i < 8; i += 1) {
    await h.maintainer.maintain()
    const entry = h.store.state.singleSessionChildUnknown.c12
    assert.equal(entry.attempts, i + 1)
    if (i < 7) h.store.state.singleSessionChildUnknown.c12.at = Date.now() - 11 * 60_000
  }
  const entry = h.store.state.singleSessionChildUnknown.c12
  assert.equal(entry.terminal, true)
  assert.equal(entry.attempts, 8)
  assert.equal(h.calls.logs.filter((line) => /转人工清单/.test(line)).length, 1)
  // terminal 之后不再累加尝试次数。
  await h.maintainer.maintain()
  assert.equal(h.store.state.singleSessionChildUnknown.c12.attempts, 8)
  const list = h.maintainer.unknownChildren()
  assert.equal(list.length, 1)
  assert.equal(list[0].sessionId, 'c12')
  assert.equal(list[0].terminal, true)
  assert.equal(list[0].attempts, 8)
  assert.equal(list[0].diagnostics.cursor, 'p1')
  assert.equal(list[0].diagnostics.records, 0)
  assert.equal(list[0].diagnostics.running, false)
  assert.equal(list[0].diagnostics.eventCount, null)
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

test('purgeLegacy：归档所有 intake-* 会话；已登记的先注销', async () => {
  const h = harness({ sessions: [
    { sessionId: 'intake-a', workspaceId: 'w1' },
    { sessionId: 'intake-b', workspaceId: 'w1' },
    { sessionId: 'session-normal', workspaceId: 'w1' },
  ] })
  h.store.state.singleSessions.w1 = 'intake-a'
  const out = await h.maintainer.purgeLegacy()
  assert.equal(out.total, 2)
  assert.equal(out.archived, 2)
  assert.equal(h.calls.archive, 2)
  assert.equal(h.calls.unpin, 1, '已登记的那个要先注销（含 unpin）')
  assert.equal(h.store.state.singleSessions.w1, undefined)
})

test('开关关闭：maintain / snapshot / list 都是空', async () => {
  const off = harness({ enabled: false })
  assert.equal((await off.maintainer.maintain()).enabled, false)
  assert.deepEqual(await off.maintainer.list(), [])
  assert.equal((await off.maintainer.snapshot()).enabled, false)
})

test('onPresetSelected：未登记/同 preset 不动；空会话被改回默认 preset；已开始只提示一次', async () => {
  const h = harness()
  assert.equal((await h.maintainer.onPresetSelected('other', 'ptc')).ignored, 'not-registered')
  await h.maintainer.register('s1') // 登记后 preset 已是默认值
  h.calls.selected.length = 0
  assert.equal((await h.maintainer.onPresetSelected('s1', 'dsh-superagent-yh-dispatcher')).ignored, 'same')
  const out = await h.maintainer.onPresetSelected('s1', 'ptc')
  assert.deepEqual(out, { ok: true, reverted: true })
  assert.deepEqual(h.calls.selected, ['dsh-superagent-yh-dispatcher'])

  const started = harness({ blank: false })
  started.store.state.singleSessions.w1 = 's1'
  const skip = await started.maintainer.onPresetSelected('s1', 'ptc')
  assert.equal(skip.ignored, 'started')
  assert.deepEqual(started.calls.selected, [])
})

test('onArchived：已登记的单会话被归档就拉回来；未登记/未开启不动；失败只记日志', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  const out = await h.maintainer.onArchived({ sessionId: 's1' })
  assert.deepEqual(out, { ok: true, restored: true })
  assert.equal(h.calls.unarchive, 1)
  assert.ok(h.calls.logs.some((line) => line.includes('archived registered session restored')))

  // 事件也可能直接传 id 字符串。
  assert.deepEqual(await h.maintainer.onArchived('s1'), { ok: true, restored: true })
  assert.equal(h.calls.unarchive, 2)

  assert.equal((await h.maintainer.onArchived({ sessionId: 'other' })).ignored, 'not-registered')
  assert.equal((await h.maintainer.onArchived({})).ignored, 'no-session')

  const off = harness({ enabled: false })
  assert.equal((await off.maintainer.onArchived({ sessionId: 's1' })).ignored, 'disabled')
  assert.equal(off.calls.unarchive, 0)

  const bad = harness({ unarchiveError: 'workspace/write-failed' })
  await bad.maintainer.register('s1')
  const failed = await bad.maintainer.onArchived({ sessionId: 's1' })
  assert.deepEqual(failed, { ok: false, ignored: 'error' })
  assert.ok(bad.calls.logs.some((line) => line.includes('restore archived session')))
})

test('标题：59 字节按 UTF-8 安全截断，不切半个中文', () => {
  assert.equal(SINGLE_SESSION_TITLE_SUFFIX, '超级智能体团队')
  // 59 是工作空间名部分的字节上限；多字节字符只能整字保留：19 个中文 = 57 字节。
  assert.equal(truncateUtf8('中'.repeat(20), 59), '中'.repeat(19))
  assert.equal(Buffer.byteLength(truncateUtf8('中'.repeat(20), 59), 'utf8'), 57)
  assert.equal(truncateUtf8('abc', 59), 'abc')
  assert.equal(truncateUtf8('', 59), '')
  assert.equal(singleSessionTitle('repo'), `repo${SINGLE_SESSION_TITLE_SUFFIX}`)
  assert.equal(singleSessionTitle('中'.repeat(20)), `${'中'.repeat(19)}${SINGLE_SESSION_TITLE_SUFFIX}`)
  assert.equal(singleSessionTitle(null), SINGLE_SESSION_TITLE_SUFFIX)
})

test('register：标题固定为「工作空间名+超级智能体团队」，canonical 写进 state', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  const expected = `repo${SINGLE_SESSION_TITLE_SUFFIX}`
  assert.equal(h.store.state.singleSessionTitles.w1, expected)
  assert.equal(h.calls.rename, 1)
  assert.deepEqual(h.calls.titles, [expected])
  assert.equal(projectedTitle(h.sessions[0]), expected)
})

test('register：改名失败只记日志，不撤销登记', async () => {
  const h = harness({ renameError: 'rename boom' })
  const out = await h.maintainer.register('s1')
  assert.equal(out.workspaceId, 'w1')
  assert.equal(h.store.state.singleSessions.w1, 's1')
  assert.equal(h.calls.rename, 0)
})

test('maintain：标题被改回时对账重写；会话不活着时不 rename', async () => {
  const live = harness()
  await live.maintainer.register('s1')
  const canonical = `repo${SINGLE_SESSION_TITLE_SUFFIX}`
  live.setProjectedTitle('s1', 'drifted')
  live.clock.advance(70_000)
  live.calls.rename = 0
  await live.maintainer.maintain()
  assert.equal(live.calls.rename, 1)
  assert.equal(live.calls.titles[0], canonical)
  assert.equal(projectedTitle(live.sessions[0]), canonical)

  // 再次 maintain 不应重复 rename（写前比对）。
  live.clock.advance(70_000)
  live.calls.rename = 0
  await live.maintainer.maintain()
  assert.equal(live.calls.rename, 0)

  const cold = harness({ agentAlive: false })
  await cold.maintainer.register('s1')
  cold.setProjectedTitle('s1', 'drifted')
  cold.clock.advance(70_000)
  cold.calls.rename = 0
  await cold.maintainer.maintain()
  assert.equal(cold.calls.rename, 0, '冷会话不 resume、不改名')
})

test('register：canonical 用 rename 返回值（宿主按 72 字节截断），下一轮 maintain 不再 rename', async () => {
  const longName = '工作空间'.repeat(12) // 48 个汉字 = 144 字节，必被宿主截断
  const truncateToBytes = (text, maxBytes) => {
    let out = ''
    let used = 0
    for (const char of text) {
      const size = Buffer.byteLength(char, 'utf8')
      if (used + size > maxBytes) break
      out += char
      used += size
    }
    return out
  }
  const h = harness({
    workspaces: [{ id: 'w1', path: 'C:/repo', title: longName }],
    renameNormalize: (title) => truncateToBytes(title, 72),
  })
  await h.maintainer.register('s1')
  const accepted = h.calls.accepted[0]
  assert.ok(Buffer.byteLength(accepted, 'utf8') <= 72)
  assert.notEqual(accepted, h.calls.titles[0], '宿主返回的标题应 ≠ 传入值')
  assert.equal(h.store.state.singleSessionTitles.w1, accepted, 'canonical 必须是宿主返回值')
  assert.equal(projectedTitle(h.sessions[0]), accepted)

  // 第二轮：canonical 已等于宿主落下的标题，不该再 rename（否则就是 60s 风暴）。
  h.clock.advance(70_000)
  h.calls.rename = 0
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 0, 'canonical 来自返回值时第二轮不得重复 rename')
  assert.equal(h.store.state.singleSessionTitles.w1, accepted)
})

test('maintain：旧 canonical 被宿主截断时以返回值为准，且只记一次、下一轮不再 rename', async () => {
  const longName = '工作空间'.repeat(12)
  const truncateToBytes = (text, maxBytes) => {
    let out = ''
    let used = 0
    for (const char of text) {
      const size = Buffer.byteLength(char, 'utf8')
      if (used + size > maxBytes) break
      out += char
      used += size
    }
    return out
  }
  const h = harness({
    workspaces: [{ id: 'w1', path: 'C:/repo', title: longName }],
    renameNormalize: (title) => truncateToBytes(title, 72),
  })
  // 模拟旧 state：canonical 是自己算的（未经宿主规范化），会话标题也被改坏。
  const selfTitle = singleSessionTitle(longName)
  h.store.state.singleSessions.w1 = 's1'
  h.store.state.singleSessionTitles = { w1: selfTitle }
  h.setProjectedTitle('s1', 'drifted')
  h.calls.rename = 0
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 1)
  const accepted = h.calls.accepted[0]
  assert.notEqual(accepted, selfTitle)
  assert.equal(h.store.state.singleSessionTitles.w1, accepted, 'maintain 也要回写返回值')

  h.clock.advance(70_000)
  h.calls.rename = 0
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 0, '返回值的 canonical 不应每轮触发 rename 风暴')
})

test('标题：sessionTitleOf 优先读宿主 projections.values.title，兼容旧顶层 title', () => {
  assert.equal(sessionTitleOf({ projections: { values: { title: 'A' } } }), 'A')
  assert.equal(sessionTitleOf({ projections: { values: { title: { ver: 1, seq: 3, val: 'B' } } } }), 'B')
  assert.equal(sessionTitleOf({ title: 'C' }), 'C')
  assert.equal(sessionTitleOf({ projections: { values: {} } }), null)
  assert.equal(sessionTitleOf({ projections: { values: { title: '' } } }), null)
  assert.equal(sessionTitleOf(undefined), null)
})

test('标题：normalizeTitleText 与宿主对齐（空白折叠/去控制字符/80 字节截断）', () => {
  assert.equal(normalizeTitleText('  a \t b\n '), 'a b')
  assert.equal(normalizeTitleText('a\u0000\u200bb'), 'ab')
  assert.equal(normalizeTitleText('\u001b[31mred\u001b[0m'), 'red')
  assert.equal(normalizeTitleText('   '), '')
  // 80 字节上限：中文 3 字节/字，只能留 26 个（78 字节）。
  assert.equal(normalizeTitleText('中'.repeat(30)), '中'.repeat(26))
})

test('maintain：宿主 summary 滞后一拍时不每轮 rename', async () => {
  const h = harness({ applyRename: false })
  await h.maintainer.register('s1')
  assert.equal(h.calls.rename, 1)
  // 投影里还是改名前的旧标题（事件已写、summary 没跟上）。
  h.setProjectedTitle('s1', '旧标题')
  h.clock.advance(61_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 2, '投影仍读旧值时按退避重试一次')
  // 紧接着的下一轮（投影还没跟上）不许再 rename。
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 2, '滞后一拍不得触发重写')
  h.clock.advance(1_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 2, '同一 canonical 在观察窗口内只允许一次 rename')
})

test('maintain：同名不同空白字符规范化后不再 rename', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  const canonical = `repo${SINGLE_SESSION_TITLE_SUFFIX}`
  h.setProjectedTitle('s1', `  ${canonical}\u200b \t`)
  h.clock.advance(70_000)
  h.calls.rename = 0
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 0)
})

test('maintain：连续不一致时 rename 间隔递增（1min → 5min → 30min 上限）', async () => {
  const h = harness({ applyRename: false })
  await h.maintainer.register('s1') // 第 1 次 rename（attempts=1）
  h.setProjectedTitle('s1', '旧标题')
  h.clock.advance(61_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 2, '第一次重试：约 1 分钟后')
  // attempts=2 → 下次要等 5 分钟
  h.clock.advance(61_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 2, '1 分钟后仍不到 5min 退避，不许重写')
  h.clock.advance(4 * 60_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 3, '等满 5 分钟才允许第二次重试')
  // attempts=3 → 30 分钟
  h.clock.advance(6 * 60_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 3, '6 分钟还不够')
  h.clock.advance(24 * 60_000)
  await h.maintainer.maintain()
  assert.equal(h.calls.rename, 4, '等满 30 分钟才允许第三次重试')
})

test('maintain：标题没被改乱时只 rename 一次（不会风暴）', async () => {
  const h = harness()
  await h.maintainer.register('s1')
  for (let round = 0; round < 5; round += 1) {
    h.clock.advance(60_000)
    await h.maintainer.maintain()
  }
  assert.equal(h.calls.rename, 1)
  assert.equal(projectedTitle(h.sessions[0]), `repo${SINGLE_SESSION_TITLE_SUFFIX}`)
})

test('register：renameSession 没有返回值时回落用自算标题', async () => {
  const h = harness({ renameNoReturn: true })
  await h.maintainer.register('s1')
  assert.equal(h.store.state.singleSessionTitles.w1, `repo${SINGLE_SESSION_TITLE_SUFFIX}`)
})

test('register：pin 失败回滚登记并报 pin-failed', async () => {
  const h = harness({ pinError: 'pin boom' })
  await assert.rejects(() => h.maintainer.register('s1'), (e) => e.code === 'pin-failed')
  assert.equal(h.store.state.singleSessions.w1, undefined)
  assert.equal(h.calls.unpin, 1)
})

test('unregister：preset 恢复失败重试一次；仍失败则留下可读状态', async () => {
  const retry = harness({ selectSequence: ['ok', new Error('first fail'), 'ok'] })
  await retry.maintainer.register('s1')
  await retry.maintainer.unregister('s1')
  assert.deepEqual(retry.calls.selected, ['dsh-superagent-yh-dispatcher', 'standard'])
  assert.equal(retry.store.state.singleSessionPrevPreset.w1, undefined)
  assert.equal(retry.store.state.singleSessionRestore?.w1, undefined)

  const broken = harness({ selectSequence: ['ok', new Error('boom1'), new Error('boom2')] })
  await broken.maintainer.register('s1')
  await broken.maintainer.unregister('s1')
  assert.equal(broken.store.state.singleSessionPrevPreset.w1, 'standard', '恢复失败时保留原 preset 记录')
  assert.equal(broken.store.state.singleSessionRestore.w1.ok, false)
  assert.match(broken.store.state.lastError, /preset 未恢复/)
})

test('guardSessionActivity：已登记会话上报活动阻断入档；删除中/未登记放行', async () => {
  const h = harness()
  const next = async () => [{ kind: 'message' }]
  assert.deepEqual(await guardSessionActivity(h.maintainer, { sessionId: 's1' }, next), [{ kind: 'message' }])
  await h.maintainer.register('s1')
  assert.deepEqual(await guardSessionActivity(h.maintainer, { sessionId: 's1' }, next), [{ kind: 'turn' }, { kind: 'message' }])
  // 未登记的会话原样放行。
  assert.deepEqual(await guardSessionActivity(h.maintainer, { sessionId: 'other' }, next), [{ kind: 'message' }])
  // 控制台删除中放行，否则 removeSingle 归档会被自己的活动上报挡住。
  const deleting = { isRegistered: () => true, isDeleting: () => true }
  assert.deepEqual(await guardSessionActivity(deleting, { sessionId: 's1' }, next), [{ kind: 'message' }])
})

test('子会话纳管：有工具调用 = 真工单，登记并汇报；空闲后归档', async () => {
  const child = { sessionId: 'c1', parentSessionId: 's1', origin: 'subagent', running: true, updatedAt: Date.now(), title: '修标题' }
  const h = harness({ children: [child], childRecords: { c1: [{ event: { type: 'tool/call', seq: 3 } }] } })
  await h.maintainer.register('s1')
  await h.maintainer.maintain()
  const ticket = (h.store.state.tickets ?? {})['subagent:c1']
  assert.ok(ticket, '真工单应被登记')
  assert.equal(ticket.status, 'running')
  assert.equal(ticket.childSessionId, 'c1')
  assert.equal(ticket.targetSessionId, 's1')
  assert.equal(h.calls.childReads[0].parentSessionId, 's1', '子会话读取要带着父会话身份')
  assert.deepEqual(h.calls.relay, [{ id: 'subagent:c1', kind: 'started' }])

  child.running = false
  child.updatedAt = Date.now() - 3 * 60_000
  await h.maintainer.maintain()
  assert.equal(h.store.state.tickets['subagent:c1'].status, 'done')
  assert.deepEqual(h.calls.relay.map((r) => r.kind), ['started', 'done'])
  assert.deepEqual(h.calls.archivedChildren, ['c1'])
  assert.ok(h.store.state.tickets['subagent:c1'].archivedAt)
})

test('子会话纳管：回声/占位 = 噪音，不建工单，空闲即归档', async () => {
  const echo = { sessionId: 'c2', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 5 * 60_000, title: '空占位' }
  const h = harness({
    children: [echo],
    childRecords: {
      c2: [{ event: { type: 'user/message', data: { content: [{ type: 'text', text: '只回复「ok」。Your final answer is delivered automatically: done' }] } } }],
    },
  })
  await h.maintainer.register('s1')
  await h.maintainer.maintain()
  assert.equal((h.store.state.tickets ?? {})['subagent:c2'], undefined)
  assert.equal(h.store.state.singleSessionChildNoise.c2, 'echo')
  assert.deepEqual(h.calls.archivedChildren, ['c2'])
  assert.equal(h.calls.relay.length, 0)
})

test('子会话纳管：读不到事件时不动、不归档（防止把真任务当噪音清掉）', async () => {
  const ghost = { sessionId: 'c9', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 5 * 60_000, title: '修标题' }
  const h = harness({ children: [ghost], childRecords: { c9: [] } })
  await h.maintainer.register('s1')
  await h.maintainer.maintain()
  assert.equal((h.store.state.tickets ?? {})['subagent:c9'], undefined)
  assert.equal(h.calls.archiveChild, 0, '读不到事件不许归档')
  assert.equal(h.store.state.singleSessionChildUnknown.c9 !== undefined, true)
})

test('子会话纳管：读不到事件会隔一阵重试，读到了就正常纳管', async () => {
  const ghost = { sessionId: 'c10', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 5 * 60_000, title: '' }
  const records = { c10: [] }
  const h = harness({ children: [ghost], childRecords: records })
  await h.maintainer.register('s1')
  await h.maintainer.maintain()
  assert.equal(h.store.state.singleSessionChildUnknown.c10.attempts, 1)
  // 还没到重试时间：不重复记、也不纳管。
  await h.maintainer.maintain()
  assert.equal(h.store.state.singleSessionChildUnknown.c10.attempts, 1)
  // 把上次时间拨到两分钟前，且事件已经读得到：这次应纳管成工单。
  h.store.state.singleSessionChildUnknown.c10.at = Date.now() - 5 * 60_000
  records.c10 = [{ event: { type: 'tool/call', seq: 2, data: { name: 'ops_bash' } } }]
  await h.maintainer.maintain()
  assert.ok((h.store.state.tickets ?? {})['subagent:c10'], '重试读到事件后应纳管')
  assert.equal(h.store.state.singleSessionChildUnknown.c10, undefined, '纳管后清掉 unknown 记录')
})

test('子会话纳管：归档失败记 lastError、不抛；adoptChildren=false 时整段跳过', async () => {
  const echo = { sessionId: 'c3', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 5 * 60_000, title: '空' }
  const broken = harness({
    children: [echo],
    childArchiveError: 'archive boom',
    childRecords: { c3: [{ event: { type: 'user/message', data: { content: [{ type: 'text', text: '只回复「ok」。' }] } } }] },
  })
  await broken.maintainer.register('s1')
  await broken.maintainer.maintain()
  assert.match(broken.store.state.lastError, /子会话归档失败（c3）：archive boom/)

  const off = harness({
    children: [echo],
    config: { singleSession: { adoptChildren: false } },
    childRecords: { c3: [{ event: { type: 'user/message', data: { content: [{ type: 'text', text: '只回复「ok」。' }] } } }] },
  })
  await off.maintainer.register('s1')
  await off.maintainer.maintain()
  assert.equal(off.calls.archiveChild, 0)
  assert.equal((off.store.state.tickets ?? {})['subagent:c3'], undefined)
})

test('childAddressOf：子会话必须用 subagent 地址（mode unknown）', () => {
  assert.deepEqual(childAddressOf({ parentSessionId: 'p1', sessionId: 'c1' }), {
    kind: 'subagent', parentSessionId: 'p1', childSessionId: 'c1', mode: 'unknown',
  })
  assert.equal(childAddressOf({ sessionId: 'c1' }), null)
  assert.equal(childAddressOf(null), null)
})

test('子会话纳管：读取抛错时记日志、判 unknown、不归档', async () => {
  const ghost = { sessionId: 'c11', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 5 * 60_000, title: '修标题' }
  const h = harness({ children: [ghost], childReadError: 'session/agent-busy' })
  await h.maintainer.register('s1')
  await h.maintainer.maintain()
  assert.ok(h.store.state.singleSessionChildUnknown.c11, '读失败要进 unknown 重试队列')
  assert.equal(h.calls.archiveChild, 0)
})

test('D51：maintain 批量归档超过 workerArchiveDays 的终态 worker，未超期/运行中/角色不动', async () => {
  const now = Date.now()
  const day = 86_400_000
  const stale = { sessionId: 'cw-old', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: now - 4 * day }
  const fresh = { sessionId: 'cw-new', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: now - 1 * day }
  const running = { sessionId: 'cw-run', parentSessionId: 's1', origin: 'subagent', running: true, updatedAt: now - 4 * day }
  const rolePrefixed = { sessionId: 'role-qa-1', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: now - 4 * day }
  const registeredRole = { sessionId: 'cw-role', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: now - 4 * day }
  const h = harness({ enabled: false, children: [stale, fresh, running, rolePrefixed, registeredRole] })
  h.store.state.roles = { qa: 'cw-role' }
  const result = await h.maintainer.maintain()
  assert.deepEqual(h.calls.archivedChildren, ['cw-old'])
  assert.equal(result.staleWorkers.total, 1)
  assert.equal(result.staleWorkers.archived, 1)
  assert.ok(h.calls.logs.some((line) => line.includes('purged stale workers: 1/1')))
})

test('D51：workerArchive:false 时 maintain 不做过期兜底', async () => {
  const stale = { sessionId: 'cw-old', parentSessionId: 's1', origin: 'subagent', running: false, updatedAt: Date.now() - 4 * 86_400_000 }
  const h = harness({ enabled: false, children: [stale], config: { singleSession: { workerArchive: false } } })
  const result = await h.maintainer.maintain()
  assert.deepEqual(h.calls.archivedChildren ?? [], [])
  assert.equal(result.staleWorkers.archived, 0)
})
