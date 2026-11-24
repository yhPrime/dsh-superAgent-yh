import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

function loadClient() {
  let captured = null
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  const ReactStub = { createElement: (...args) => args, useReducer: (initial) => [initial, () => {}], useState: (initial) => [initial, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn() }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(windowStub, requireStub)
  assert.ok(captured, 'client.js 应该调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-superagent-yh')
  return captured.factory(requireStub)
}

test('client 模块：注册左栏图标、主面板、右侧页签类型', () => {
  const mod = loadClient()
  assert.deepEqual(mod.inject, ['slots', 'layout', 'locale'])

  const slots = []
  const tabTypes = []
  const ctx = {
    locale: { register: () => () => {}, subscribe: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, callback) => { callback(); return () => {} },
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}) },
    get: (name) => {
      if (name === 'sidebarRightTabs') return { register: (definition) => { tabTypes.push(definition); return () => {} } }
      if (name === 'sidebarRight') return { openTab: () => {} }
      return undefined
    },
    inject: (_deps, callback) => { callback(ctx) },
    layout: { selectPanel: () => {} },
  }
  mod.apply(ctx)

  const main = slots.find((entry) => entry.options.name === 'main')
  assert.ok(main, '缺少 main 主面板')
  assert.equal(main.options.key, 'dsh-superagent-yh')
  assert.equal(typeof main.component, 'function')

  const icon = slots.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(icon, '缺少左侧栏图标')
  assert.equal(icon.options.id, 'dsh-superagent-yh')

  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, 'dsh-superagent-yh')
  assert.equal(tabTypes[0].kind, 'dsh-superagent-yh')
  assert.equal(tabTypes[0].priority, 'extension')

  const body = slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  assert.ok(body, '缺少右侧栏正文')
  assert.equal(body.options.key, 'dsh-superagent-yh')
  const title = slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
  assert.ok(title, '缺少右侧栏标题')

  const board = slots.find((entry) => entry.options.name === 'conversation.session.header.actions.subagent.footer')
  assert.ok(board, '缺少会话内任务板')
  assert.equal(board.options.id, 'dsh-superagent-yh')
  assert.equal(typeof board.component, 'function')

  const pill = slots.find((entry) => entry.options.name === 'conversation.composer.dock')
  assert.ok(pill, '缺少输入区超级智能体胶囊')
  assert.equal(pill.options.id, 'dsh-superagent-yh')
})

test('client 模块：没有 better-sidebar 时不注册右栏，也不抛错', () => {
  const mod = loadClient()
  const slots = []
  const ctx = {
    locale: { register: () => () => {}, subscribe: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: (options, component) => { slots.push({ options, component }); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
    inject: (_deps, callback) => { callback({ get: () => undefined, effect: (fn) => fn(), slots: { inject: () => () => {}, register: () => () => {} }, locale: ctx.locale }) },
    layout: { selectPanel: () => {} },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.ok(slots.some((entry) => entry.options.name === 'main'))
  assert.ok(!slots.some((entry) => entry.options.name === 'sidebar.right.pane.tab'))
})
