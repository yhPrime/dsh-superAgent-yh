import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientSource as source, loadClient } from '../tools/client-source.mjs'

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

  const pill = slots.find((entry) => entry.options.name === 'conversation.input.right')
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

test('client 模块：控制台五条路由的客户端调用面存在', () => {
  const internals = loadClient().__internals
  const store = internals.createConsoleStore({ document: null, fetch: async () => ({ ok: true, json: async () => ({}) }) })
  assert.match(store.urlFor('status'), /\/status$/)
  assert.match(store.urlFor('status:s1'), /\/status\?sessionId=s1$/)
  assert.match(store.urlFor('single:s1'), /\/single\?sessionId=s1$/)
  store.dispose()

  // /log、/action、/settings 走 post/fetch 字面量，路由名必须留在客户端调用面上。
  assert.match(source, /post\('\/action'/, '缺少 /action 调用')
  assert.match(source, /post\('\/settings'/, '缺少 /settings 调用')
  assert.match(source, /\/log\?ticketId=/, '缺少 /log 调用')
})

test('client 模块：配置侧 token 掩码，表单与提交 payload 都不含明文', () => {
  const internals = loadClient().__internals
  const secrets = ['ghp_PLAINTEXT_abc123', 'feishu_secret_xyz', 'qq_http_tok', 'qq_ws_tok', 'qq_official_tok']
  const config = {
    dryRun: false, mainSessionId: 'main-1', repoPath: 'D:\\repo', pollIntervalMs: 60000, workerPreset: 'preset',
    sources: {
      github: { enabled: true, repo: 'a/b', labels: ['x'], authors: [], apiBase: 'https://api', confirmWrites: false, token: secrets[0], hasToken: true },
      feishu: { enabled: false, appId: 'app', chatIds: [], authors: [], requireMention: true, confirmWrites: false, appSecret: secrets[1], hasSecret: true },
      qq: {
        enabled: false, mode: 'official', requireAt: true, authors: [], allowedGroups: [], confirmWrites: false,
        personal: { httpUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:2', selfId: '1', snowLumaDir: 'd', httpToken: secrets[2], wsToken: secrets[3], hasHttpToken: true, hasWsToken: true },
        official: { host: '127.0.0.1', port: 3000, token: secrets[4], hasToken: true },
      },
    },
  }
  const singleSession = { enabled: true, idleMinutes: 30, pressureRatio: 0.5, aggressive: false, keepRecentTurns: 2, sessionIdPrefix: 'intake', preset: 'p' }
  const form = internals.buildForm(config, singleSession)
  const payload = internals.formPayload(form)
  const visible = JSON.stringify(form) + JSON.stringify(payload)
  for (const secret of secrets) assert.ok(!visible.includes(secret), `表单/payload 泄漏明文 token：${secret.slice(0, 4)}…`)
  assert.equal(form.github.token, '')
  assert.equal(form.feishu.appSecret, '')
  assert.equal(form.qq.official.token, '')
  assert.equal(form.github.hasToken, true, '掩码后仍应保留已配置标记')
  assert.equal(form.feishu.hasSecret, true)
  assert.equal(form.qq.personal.hasHttpToken, true)
})
