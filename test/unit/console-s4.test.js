// S4 验收：窄栏降级（头部换行 / 工单减列 / 错误第二行）、表单 dirty 保护、
// 空/错态统一、autoCreate 控件为零且配置键保留。
// 视觉判据（scrollWidth/clientWidth、无重叠）无法在无 DOM 环境断言，登记在 docs/S0-待验清单.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clientSource as source, loadClient } from '../tools/client-source.mjs'

function between(startSignature, endSignature) {
  const start = source.indexOf(startSignature)
  assert.ok(start >= 0, `应能找到 ${startSignature}`)
  const end = source.indexOf(endSignature, start + startSignature.length)
  assert.ok(end > start, `应能找到 ${endSignature}`)
  return source.slice(start, end)
}

const cssMatch = source.match(/const CSS = `([\s\S]*?)`\r?\n/)
assert.ok(cssMatch, '应能找到模块级 CSS 常量')
const css = cssMatch[1]
const consoleBody = between('    function Console({ ctx, compact = false, onClose }) {', '    function Icon({')
const ticketsView = between('    function TicketsView(', '    function RolesView(')
const errorBanner = between('    function ErrorBanner(', '    // S4 空/错态统一')

test('窄栏降级：容器查询、头部换行、工单减列、错误降到第二行', () => {
  // 宽度按容器判断：右栏 320/360/380 的真实宽度不等于视口，不能用 @media。
  assert.match(css, /\.syh-root\{[^}]*container-type:inline-size/, '根节点应建立 inline-size 容器')
  assert.match(css, /@container \(max-width:420px\)\{/, '应有窄栏容器查询')
  assert.match(css, /\.syh-th-attempts,\.syh-td-attempts,\.syh-th-error,\.syh-td-error\{display:none\}/, '窄栏应隐藏「尝试」「最后错误」两列')
  assert.match(css, /\.syh-td-err\{display:block\}/, '窄栏应把错误显示为第二行')
  assert.match(css, /\.syh-td-err\{display:none/, '宽栏不应重复显示第二行错误')

  // 头部换行与表格内长串折行，避免 scrollWidth 超出 clientWidth。
  assert.match(css, /\.syh-head\{[^}]*flex-wrap:wrap/, '头部应允许换行')
  assert.match(css, /\.syh-root,\.syh-root \*\{box-sizing:border-box\}/, '全局 border-box 防止 padding 撑破窄栏')
  assert.match(css, /\.syh-table td\{[^}]*overflow-wrap:anywhere/, '表格单元格应允许任意断行')
  assert.match(css, /\.syh-ws\{grid-template-columns:1fr\}/, '窄栏工作区行应单列')
})

test('TicketsView 接线：两个列类 + 第二行错误只出现在首列', () => {
  for (const token of ["className: 'syh-th-attempts'", "className: 'syh-th-error'", "className: 'syh-td-attempts'", "className: 'syh-td-error'"]) {
    assert.ok(ticketsView.includes(token), `TicketsView 缺少 ${token}`)
  }
  assert.ok(ticketsView.includes("'syh-err syh-td-err'"), '最后错误应有第二行节点')
  assert.ok(
    ticketsView.indexOf("'syh-err syh-td-err'") < ticketsView.indexOf("'syh-td-attempts'"),
    '第二行错误应在首列（尝试列之前）',
  )
})

test('dirty 判据：未加载/未修改为干净，改一处即脏', () => {
  const { isFormDirty } = loadClient().__internals
  assert.equal(typeof isFormDirty, 'function')
  assert.equal(isFormDirty(null, { a: 1 }), false, '表单未加载不算脏')
  assert.equal(isFormDirty({ a: 1 }, null), false, '没有基线不算脏')
  const baseline = { dryRun: false, single: { enabled: true, idleMinutes: '30' }, github: { token: '' } }
  assert.equal(isFormDirty(structuredClone(baseline), baseline), false, '内容相同应为干净')
  const edited = structuredClone(baseline)
  edited.single.idleMinutes = '45'
  assert.equal(isFormDirty(edited, baseline), true, '改任一字段应为脏')
  assert.equal(isFormDirty(baseline, baseline), false, '基线自身比较为干净')
})

test('dirty 保护接线：切页签、点统计卡、关闭都先过 confirmLeave', () => {
  assert.ok(consoleBody.includes('const dirty = isFormDirty(form, baseline)'), 'Console 应计算 dirty')
  const guards = consoleBody.match(/if \(!confirmLeave\(\)\) return/g) ?? []
  assert.ok(guards.length >= 2, `selectTab 与 pickStat 都应拦截，当前 ${guards.length} 处`)
  assert.ok(consoleBody.includes('onSelect: selectTab'), '页签切换应走带保护的 selectTab')
  assert.ok(consoleBody.includes('onClose: requestClose'), '关闭应走带保护的 requestClose')

  const { DICT } = loadClient().__internals
  assert.ok(DICT.zh.unsavedConfirm?.trim(), 'zh 应有未保存确认文案')
  assert.ok(DICT.en.unsavedConfirm?.trim(), 'en 应有未保存确认文案')
  assert.notEqual(DICT.zh.unsavedConfirm, DICT.en.unsavedConfirm)
})

test('空/错态统一：空态走 EmptyState，错态 banner 有 role=alert', () => {
  assert.match(source, /function EmptyState\(\{ children \}\) \{\r?\n      return h\('div', \{ className: 'syh-empty', role: 'status' \}/, '应有统一空态组件')
  assert.ok((source.match(/h\(EmptyState, null, /g) ?? []).length >= 7, '各视图空态都应走 EmptyState')
  assert.equal((source.match(/className: 'syh-empty'/g) ?? []).length, 1, 'syh-empty 只应出现在 EmptyState 定义里')
  assert.match(errorBanner, /role: 'alert'/, '错误 banner 应有 role=alert')
})

test('autoCreate：client.js 无控件，lib 配置键保留（不删键）', () => {
  assert.ok(!/autoCreate/.test(source), 'client.js 中不应检索到 autoCreate')
  const configSource = readFileSync(new URL('../../lib/config.js', import.meta.url), 'utf8')
  const panelSource = readFileSync(new URL('../../lib/panel.js', import.meta.url), 'utf8')
  assert.ok(configSource.includes('autoCreate'), 'lib/config.js 的 autoCreate 键应保留')
  assert.ok(panelSource.includes('autoCreate'), 'lib/panel.js 白名单应保留 autoCreate')
})
