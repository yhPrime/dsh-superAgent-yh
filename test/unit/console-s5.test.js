// S5 验收：任务板与登记按钮的键盘/读屏改造；原生 alert/confirm 归零；
// 键盘可判定项全部落成断言。真实焦点顺序、读屏播报与窄栏观感无法在无 DOM 环境断言，
// 登记在 docs/S0-待验清单.md（v4）保持「待验」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientSource as source, loadClient } from '../tools/client-source.mjs'

function between(startSignature, endSignature) {
  const start = source.indexOf(startSignature)
  assert.ok(start >= 0, `应能找到 ${startSignature}`)
  const end = source.indexOf(endSignature, start + startSignature.length)
  assert.ok(end > start, `应能找到 ${endSignature}`)
  return source.slice(start, end)
}

const consoleBody = between('    function Console({ ctx, compact = false, onClose }) {', '    function Icon({')
const tabsBar = between('    function TabsBar(', '    function StatCards(')
const board = between('    function SessionBoard(props) {', '    // S3 视图层')
const pill = between('    function SingleSessionPill(props) {', '    function PressureBar(')

test('原生 alert/confirm 归零，确认改走控制台内 ConfirmBar', () => {
  assert.equal((source.match(/window\.alert|window\.confirm/g) ?? []).length, 0, 'client.js 中不应再有原生弹窗调用')
  assert.ok(source.includes('function ConfirmBar('), '应有模块级 ConfirmBar')
  const confirmBar = between('    function ConfirmBar(', '    // S5 页签键盘导航')
  assert.match(confirmBar, /role: 'alertdialog'/, '确认条应有 alertdialog 语义')
  assert.match(confirmBar, /'aria-live': 'assertive'/, '确认条应即时播报')
  assert.ok(confirmBar.includes("t('ok')") && confirmBar.includes("t('cancel')"), '确认条应有确定/取消按钮')

  assert.ok(consoleBody.includes("h(ConfirmBar, { t, confirm: pendingConfirm, onResolve: resolveConfirm })"), 'Console 应渲染确认条')
  for (const key of ['confirmCompact', 'deleteSingleConfirm', 'roleRemoveConfirm']) {
    assert.match(consoleBody, new RegExp(`askConfirm\\(t\\('${key}'\\)`), `${key} 应走面板确认`)
  }
  assert.ok(consoleBody.includes("askConfirm(t('unsavedConfirm'), leaveIntent.current)"), '未保存离开应走面板确认')
})

test('确认结果：取消不执行，确定才执行；dirty 离开仍先确认', () => {
  const resolve = between('      const resolveConfirm = (accepted) => {', '      const confirmLeave = () => {')
  assert.ok(resolve.indexOf('setPendingConfirm(null)') < resolve.indexOf('if (accepted && pending) pending.action()'), '应先清空确认条再按结果执行')
  const guards = consoleBody.match(/if \(!confirmLeave\(\)\) return/g) ?? []
  assert.ok(guards.length >= 2, `切页签/关闭/统计卡应拦截未保存离开，当前 ${guards.length} 处`)
  assert.ok(consoleBody.includes('onSelect: selectTab') && consoleBody.includes('onClose: requestClose'))
})

test('页签：tablist/tab 语义、aria-selected、Tab 逐个可达 + 方向键导航', () => {
  assert.match(tabsBar, /role: 'tablist'/, '页签容器应有 tablist 语义')
  assert.match(tabsBar, /'aria-label': t\('tablist'\)/, '页签组应有可读名称')
  assert.match(tabsBar, /role: 'tab'/, '页签按钮应有 tab 语义')
  assert.match(tabsBar, /'aria-selected': tab === key/, '当前页签应标 aria-selected')
  assert.match(tabsBar, /onKeyDown/, '页签应支持方向键')
  assert.ok(!/tabIndex/.test(tabsBar), '不加 roving tabindex，保证每个页签都能被 Tab 到达')
  assert.ok(consoleBody.includes("role: 'tabpanel'"), '内容区应有 tabpanel 语义')
})

test('页签方向键纯函数：左/右/Home/End 边界与未知键', () => {
  const { nextTabIndex } = loadClient().__internals
  assert.equal(typeof nextTabIndex, 'function')
  assert.equal(nextTabIndex(5, 0, 'ArrowRight'), 1)
  assert.equal(nextTabIndex(5, 4, 'ArrowRight'), 0, '右方向键应回环')
  assert.equal(nextTabIndex(5, 0, 'ArrowLeft'), 4, '左方向键应回环')
  assert.equal(nextTabIndex(5, 3, 'Home'), 0)
  assert.equal(nextTabIndex(5, 1, 'End'), 4)
  assert.equal(nextTabIndex(5, 2, 'Enter'), -1, 'Enter 交还给按钮原生激活')
  assert.equal(nextTabIndex(0, 0, 'Home'), -1)
})

test('任务板行：role=button + tabIndex=0 + Enter/Space 打开控制台（D6 点击行为不变）', () => {
  assert.match(board, /role: 'button'/, '任务板行应是按钮语义')
  assert.match(board, /tabIndex: 0/, '任务板行应可 Tab 聚焦')
  assert.match(board, /event\.key === 'Enter'/, 'Enter 应激活')
  assert.match(board, /event\.key === ' '/, 'Space 应激活')
  assert.match(board, /selectPanel\(PANEL_ID\)/, '激活后仍打开控制台（D6）')
  assert.match(board, /'aria-label': `\$\{label\} · \$\{status\}`/, '行应有「标题 · 状态」可读名称')
  assert.match(source, /\.syhb-row:focus-visible\{/, '任务板行应有可见焦点')
})

test('登记按钮：失败走行内 role=alert 提示，不再用原生弹窗', () => {
  assert.match(pill, /role: 'alert'/, '登记失败应有 role=alert 行内提示')
  assert.match(pill, /syh-sr-only/, '提示应只给读屏、不撑破 24×24 按钮布局')
  assert.match(pill, /sysi-error/, '失败时按钮应有可见红框')
  assert.match(pill, /'aria-label'/, '按钮应有可读名称')
  assert.ok(!/window\./.test(pill), '登记按钮不应再访问 window 弹窗')
  assert.match(source, /\.syh-sr-only\{/, '应有只读屏文本样式')
})

test('键盘焦点可见：focus-visible 覆盖普通控件与胶囊', () => {
  assert.match(source, /\.syh-root :focus-visible,\.syh-root:focus-visible\{/)
  assert.match(source, /\.syh-capsule:focus-within\{/, '隐藏原生 checkbox 的胶囊应有 focus-within 焦点')
  assert.match(source, /\.sysi-error\{/)
})

test('S5 新增文案 zh/en 成对、非空且不互相复制', () => {
  const { DICT } = loadClient().__internals
  for (const key of ['ok', 'tablist', 'confirmTitle']) {
    assert.ok(String(DICT.zh[key] ?? '').trim(), `zh.${key} 不能为空`)
    assert.ok(String(DICT.en[key] ?? '').trim(), `en.${key} 不能为空`)
  }
  assert.notEqual(DICT.zh.confirmTitle, DICT.en.confirmTitle)
})
