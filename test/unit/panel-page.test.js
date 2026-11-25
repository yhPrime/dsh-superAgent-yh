import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerPanel } from '../../lib/panel.js'
import { normalizeConfig } from '../../lib/config.js'

// S6 · 独立页处置：页面必须冻结为只读降级页。
// 判据（计划书 docs/控制台重构计划书-v1.0.md:179）：无写请求、无「每 5 秒自动刷新」文案、
// 只读内容可显示、含一句「完整控制台在应用内左栏」。
const GUIDE_TEXT = '完整控制台在应用内左栏'
const PAGE_PATH = '/dsh-superagent-yh'

function buildStore(tickets = {}) {
  return { state: { tickets, lastError: null, sourceStatus: {} }, logsDir: '' }
}

/** 用最小 fake ctx 注册 panel，返回独立页 handler。 */
function renderPageHandler({ tickets = {} } = {}) {
  const routes = new Map()
  const ctx = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:50290',
      register: ({ path, handler }) => { routes.set(path, handler) },
    },
    effect: (fn) => fn(),
    get: () => null,
    sessionController: {},
  }
  registerPanel({
    ctx,
    store: buildStore(tickets),
    config: normalizeConfig({ dryRun: true }),
    redact: (value) => String(value),
    log: () => {},
    getSingleSession: () => ({ snapshot: async () => ({ enabled: false, workspaces: [] }) }),
  })
  return routes.get(PAGE_PATH)
}

async function fetchPage(handler) {
  let status = 0
  let headers = {}
  let body = ''
  const res = {
    writeHead: (code, nextHeaders) => { status = code; headers = nextHeaders },
    end: (text) => { body = String(text) },
  }
  await handler({ url: PAGE_PATH }, res)
  return { status, headers, body }
}

test('S6 独立页：渲染 200 且为只读降级页（无写表单、无写请求、无假刷新文案）', async () => {
  const { status, headers, body } = await fetchPage(renderPageHandler())

  assert.equal(status, 200)
  assert.match(String(headers['content-type']), /text\/html/)

  // 写表单/写入口彻底消失
  assert.doesNotMatch(body, /<form\b/i, '页面不应再有 <form>')
  assert.doesNotMatch(body, /<(?:input|button|textarea|select)\b/i, '页面不应再有表单控件')
  assert.doesNotMatch(body, /method\s*=\s*["']?(?:post|put|patch|delete)/i, '页面不应有写方法')
  assert.doesNotMatch(body, /\bfetch\s*\(/, '页面不应再发起 fetch')
  assert.doesNotMatch(body, /XMLHttpRequest/, '页面不应再发起 XHR')

  // 假刷新文案消失
  assert.doesNotMatch(body, /每\s*5\s*秒自动刷新/, '页面不应再声称每 5 秒自动刷新')
  assert.doesNotMatch(body, /自动刷新/, '页面不应有任何自动刷新假文案')

  // 指引文案与只读信息仍在
  assert.ok(body.includes(GUIDE_TEXT), `页面应包含「${GUIDE_TEXT}」`)
  assert.match(body, /总览/, '总览只读信息应保留')
  assert.match(body, /只读降级页/, '应说明是只读降级页')
})

test('S6 独立页：保留工单/三态只读信息展示', async () => {
  const handler = renderPageHandler({
    tickets: {
      t1: { id: 't1', source: 'github', title: '修复登录', status: 'failed', attempts: 2, lastError: 'boom' },
      t2: { id: 't2', source: 'github', title: '补文档', status: 'done', attempts: 1 },
    },
  })
  const { body } = await fetchPage(handler)

  assert.match(body, /总览/)
  assert.match(body, /待处理 <b>0<\/b>/, '三态统计仍渲染')
  assert.match(body, /修复登录/, '工单标题仍渲染')
  assert.match(body, /class="badge failed"/, '工单状态徽章仍渲染')
  assert.match(body, /boom/, '工单最后错误仍渲染')
  assert.match(body, /补文档/)
})

test('S6 独立页：lib/panel.js 源码不含任何前端写请求方法', () => {
  const source = readFileSync(new URL('../../lib/panel.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'panel.js 不应再含 fetch 调用')
  assert.doesNotMatch(source, /XMLHttpRequest/, 'panel.js 不应再含 XMLHttpRequest')
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i, 'panel.js 不应含前端写请求方法')
  assert.doesNotMatch(source, /addEventListener\(\s*['"]submit['"]/, 'panel.js 不应再绑定提交事件')
})
