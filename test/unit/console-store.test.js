// consoleStore（S2 数据层）单元测试：单定时器、共享快照、可见性暂停、过滤 parity。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClient } from '../tools/client-source.mjs'
import { filterTicketsForSession as serverFilter } from '../../lib/panel.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

// node:test 的 mock timers 只有同步 tick；每次推进后让 fetch 的微任务落地，
// 定时器链才会把下一次 setTimeout 排上（Node 24 没有 tickAsync）。
async function advanceTimers(t, totalMs, stepMs = 5000) {
  let elapsed = 0
  while (elapsed < totalMs) {
    const step = Math.min(stepMs, totalMs - elapsed)
    t.mock.timers.tick(step)
    await flush()
    elapsed += step
  }
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

function loadInternals() {
  return loadClient().__internals
}

function fakeDocument() {
  const listeners = new Set()
  return {
    hidden: false,
    addEventListener(type, listener) { if (type === 'visibilitychange') listeners.add(listener) },
    removeEventListener(type, listener) { if (type === 'visibilitychange') listeners.delete(listener) },
    emitVisibility() { for (const listener of [...listeners]) listener() },
    get listenerCount() { return listeners.size },
  }
}

test('consoleStore：单定时器，30s 窗口内 /status 请求数落在 [6,8]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { createConsoleStore } = loadInternals()
  let fetches = 0
  const urls = []
  const store = createConsoleStore({
    fetch: async (url) => { fetches += 1; urls.push(url); return jsonResponse({ tickets: [] }) },
    document: null,
  })
  const stop = store.subscribe('status', () => {})
  await flush()
  const firstFetches = fetches
  await advanceTimers(t, 30000)
  // 首查在 t=0，之后每 5s 一次：30s 内共 7 次（t=0,5,10,15,20,25,30）。
  assert.ok(fetches >= 6 && fetches <= 8, `30s 内应请求 6~8 次，实际 ${fetches}`)
  assert.equal(firstFetches, 1, '订阅时应立即补拉一次')
  assert.equal(fetches - firstFetches, 6, '30s 内应再定时拉 6 次')
  assert.ok(urls.every((url) => url.endsWith('/status')), `请求应打到单一路由，实际 ${urls[0]}`)
  stop()
  store.dispose()
})

test('consoleStore：多消费者共享同一快照与同一在途请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { createConsoleStore } = loadInternals()
  const payload = { tickets: [{ id: 't1' }], stats: {} }
  let fetches = 0
  const store = createConsoleStore({
    fetch: async () => { fetches += 1; return jsonResponse(payload) },
    document: null,
  })
  const received = { console: [], board: [], pill: [] }
  const stops = [
    store.subscribe('status', (snapshot) => received.console.push(snapshot)),
    store.subscribe('status', (snapshot) => received.board.push(snapshot)),
    store.subscribe('status', (snapshot) => received.pill.push(snapshot)),
  ]
  await flush()

  assert.equal(fetches, 1, '同一资源的三个消费者只应触发一次 fetch')
  const snapshot = store.getSnapshot('status')
  assert.equal(snapshot.data, payload, '快照应指向同一份数据对象')
  for (const [name, list] of Object.entries(received)) {
    assert.ok(list.length >= 1, `${name} 应收到快照通知`)
    assert.equal(list.at(-1).data, payload, `${name} 应与主面板共享同一快照`)
  }

  await advanceTimers(t, 30000)
  assert.equal(fetches, 7, '三个消费者共享一个定时器，30s 仍只应 7 次请求')
  for (const stop of stops) stop()
  store.dispose()
})

test('consoleStore：document.hidden 时暂停轮询，恢复可见立即补拉', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { createConsoleStore } = loadInternals()
  const doc = fakeDocument()
  let fetches = 0
  const store = createConsoleStore({
    fetch: async () => { fetches += 1; return jsonResponse({ tickets: [] }) },
    document: doc,
  })
  const stop = store.subscribe('status', () => {})
  await flush()
  assert.equal(fetches, 1)

  doc.hidden = true
  doc.emitVisibility()
  await advanceTimers(t, 30000)
  assert.equal(fetches, 1, '页面不可见时不应继续轮询')

  doc.hidden = false
  doc.emitVisibility()
  await flush()
  assert.equal(fetches, 2, '恢复可见时应立即补拉一次')
  await advanceTimers(t, 5000)
  assert.equal(fetches, 3, '恢复后应继续按 5s 轮询')

  stop()
  store.dispose()
  assert.equal(doc.listenerCount, 0, 'dispose 应移除 visibilitychange 监听，不泄漏')
})

test('consoleStore：最后退订后停表，不再发请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { createConsoleStore } = loadInternals()
  let fetches = 0
  const store = createConsoleStore({
    fetch: async () => { fetches += 1; return jsonResponse({ tickets: [] }) },
    document: null,
  })
  const stop = store.subscribe('status', () => {})
  await flush()
  stop()
  await advanceTimers(t, 60000)
  assert.equal(fetches, 1, '没有订阅者时定时器应停止')
  store.dispose()
})

test('consoleStore：过滤结果与 lib/panel.js 的 filterTicketsForSession 逐条一致', () => {
  const { filterTicketsForSession: clientFilter } = loadInternals()
  const workspaces = [
    { sessionId: 's1', path: 'D:\\Work\\Alpha\\' },
    { sessionId: 's2', path: '/home/u/beta/' },
  ]
  const tickets = [
    { id: 'a', targetSessionId: 's1', workspace: 'C:\\other' },
    { id: 'b', targetSessionId: null, workspace: 'd:/work/alpha' },
    { id: 'c', targetSessionId: null, workspace: 'D:/WORK/ALPHA/' },
    { id: 'd', targetSessionId: 's2', workspace: '/home/u/beta' },
    { id: 'e', targetSessionId: null, workspace: 'D:/Work/Alpha2' },
    { id: 'f', targetSessionId: null, workspace: null },
    { id: 'g', targetSessionId: 's3', workspace: '/home/u/beta' },
  ]
  const cases = [
    [tickets, 's1', workspaces],
    [tickets, 's2', workspaces],
    [tickets, 's9', workspaces],
    [tickets, 's1', []],
    [tickets, null, workspaces],
    [[], 's1', workspaces],
  ]
  for (const args of cases) {
    assert.deepEqual(clientFilter(...args), serverFilter(...args), `parity 失败：${JSON.stringify(args[1])}`)
  }
  assert.deepEqual(clientFilter(tickets, 's1', workspaces).map((ticket) => ticket.id), ['a', 'b', 'c'])
})

