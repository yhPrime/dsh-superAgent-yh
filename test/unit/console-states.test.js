// S6 验收：disabled / 空态 / 错态三态的等价断言（不要求快照图片）。
//
// 无 DOM 环境决定了这里断言的是「状态 → 渲染分支」的接线等价，而不是像素：
//   · 空态：每处 EmptyState 都必须在给定空数据时由对应的守卫条件命中，且文案 key 在 zh/en 都有；
//   · 错态：ErrorBanner 必须是 role=alert，且错误串的两种来源（加载失败 / 操作失败）都有落点；
//   · disabled：当前是 5 处局部条件，没有统一语义（见 disabled 组的 todo），这里锁住现状，改条件时测试会提醒。
// 真实读屏播报与视觉禁用态无法在无 DOM 断言，登记在 docs/S6-第二轮测试报告.md 的待验项。
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

const overviewView = between('    function OverviewView(', '    function TicketsView(')
const ticketsView = between('    function TicketsView(', '    function RolesView(')
const rolesView = between('    function RolesView(', '    function SourceCard(')
const saveBar = between('    function SaveBar(', '    function SourcesView(')
const sourcesView = between('    function SourcesView(', '    function SettingsView(')
const settingsView = between('    function SettingsView(', '    function Console(')
const errorBanner = between('    function ErrorBanner(', '    // S4 空/错态统一')
const emptyState = between('    function EmptyState(', '    function ConfirmBar(')
const { DICT } = loadClient().__internals

// 空态：视图 → 守卫条件 → 文案 key。8 处复用点逐条覆盖（含 TicketsView 的双 key 三目）。
const EMPTY_SITES = [
  { name: '概览·单会话未启用', body: overviewView, guard: '!data?.singleSession?.enabled', key: 'noWorkspace' },
  { name: '概览·已启用但工作区为空', body: overviewView, guard: '(data.singleSession.workspaces ?? []).length === 0', key: 'noWorkspace' },
  { name: '概览·无已启用来源', body: overviewView, guard: 'enabledSources.length === 0', key: 'noSources' },
  { name: '概览·无工单', body: overviewView, guard: 'tickets.length === 0', key: 'noTickets' },
  { name: '角色·无角色', body: rolesView, guard: 'roles.length === 0', key: 'noRoles' },
]

test('空态：统一组件带 role=status，且全文件只有 8 处复用点', () => {
  assert.match(emptyState, /role: 'status'/, '空态应是 role=status，供读屏播报')
  assert.equal((source.match(/h\(EmptyState, null, /g) ?? []).length, 8, '空态复用点应恒为 8 处；增删状态时同步更新本表')
  assert.equal((source.match(/className: 'syh-empty'/g) ?? []).length, 1, 'syh-empty 只应出现在 EmptyState 定义里')
})

test('空态：概览/角色 5 处守卫命中对应文案 key', () => {
  for (const site of EMPTY_SITES) {
    const at = site.body.indexOf(site.guard)
    assert.ok(at >= 0, `${site.name}：应能找到守卫条件 ${site.guard}`)
    const slice = site.body.slice(at, at + 220)
    assert.ok(slice.includes(`h(EmptyState, null, t('${site.key}'))`), `${site.name}：守卫之后应命中 t('${site.key}') 的空态`)
  }
})

test('空态：工单页过滤后为空时区分「无匹配」与「无工单」', () => {
  const listGuard = 'list.length === 0'
  const at = ticketsView.indexOf(listGuard)
  assert.ok(at >= 0, '应与按筛选后的 list 为空比较')
  const slice = ticketsView.slice(at, at + 200)
  assert.match(slice, /h\(EmptyState, null, query \? t\('noMatch'\) : t\('noTickets'\)\)/, '有搜索词走 noMatch，否则走 noTickets')
})

test('空态：来源/设置表单未加载时走 loadFailed', () => {
  for (const [name, body] of [['来源', sourcesView], ['设置', settingsView]]) {
    assert.match(body, /if \(!form\) return h\(EmptyState, null, t\('loadFailed'\)\)/, `${name}页表单未加载应显示加载失败空态`)
  }
})

test('空态：全部空态文案 key 在 zh/en 都存在且非空、互不复制', () => {
  const keys = ['noWorkspace', 'noSources', 'noTickets', 'noMatch', 'noRoles', 'loadFailed']
  for (const key of keys) {
    assert.ok(String(DICT.zh[key] ?? '').trim(), `zh.${key} 不能为空`)
    assert.ok(String(DICT.en[key] ?? '').trim(), `en.${key} 不能为空`)
    assert.notEqual(DICT.zh[key], DICT.en[key], `${key} 中英文案不应互相复制`)
  }
  assert.notEqual(DICT.zh.noTickets, DICT.zh.noMatch, '「没有工单」与「没有匹配」应可区分')
})

test('错态：ErrorBanner 有 role=alert，加载失败与操作失败两个来源都有落点', () => {
  assert.match(errorBanner, /role: 'alert'/, '错态 banner 应有 role=alert')
  assert.match(errorBanner, /loadError[\s\S]{0,160}?t\('loadFailed'\)/, '加载失败应带「加载失败」前缀')
  assert.match(errorBanner, /error[\s\S]{0,80}?h\('div', \{ className: 'syh-err' \}, error\)/, '操作失败应原样落到 syh-err')
  assert.ok(!/window\.alert/.test(errorBanner), '错态不应再走原生弹窗')
})

test('错态：错误串来源固定为 HTTP 状态或宿主回包 error 字段', () => {
  // load（GET /status）与 post（写操作）都把失败收敛成 `HTTP <status>` 或 data.error，便于后续 humanize 按码映射。
  assert.match(source, /if \(!response\.ok\) throw new Error\(`HTTP \$\{response\.status\}`\)/, 'GET 失败应是 HTTP <status>')
  assert.match(source, /throw new Error\(data\.error \|\| `HTTP \$\{response\.status\}`\)/, 'POST 失败应优先用回包 error')
  const consoleBody = between('    function Console({ ctx, compact = false, onClose }) {', '    function Icon({')
  const raw = consoleBody.match(/setError\(String\(reason\?\.message \|\| reason\)\)/g) ?? []
  assert.ok(raw.length >= 4, `操作失败应统一取 message，当前 ${raw.length} 处`)
})

// 错态的人话映射（offline/timeout/401/403/404/500/badJson/unknown）依赖 S5 的 humanizeError()。
// 当前 client.js 还没有这个函数（S5 落地的是任务板键盘/读屏 + 面板内确认），所以先以 todo 挂着：
// 一旦 S5b 把 humanizeError 加进 __internals，把下面这个 todo 换成真断言即可，不需要改回归门。
// 参考规格（S5b 落地后照此断言）：humanizeError('offline'|'timeout'|'401'|'403'|'404'|'500'|'badJson'|'unknown')
// 返回非空人话，且不等于入参错误码。
test('错态：错误码经 humanizeError 产出非空人话（offline/timeout/401/403/404/500/badJson/unknown）', {
  todo: 'humanizeError() 尚未实现（S5 只做了任务板 a11y）——待 S5b 落地后启用',
}, () => {
  // 暂不执行：没有可用实现，避免用假实现把红线刷绿。
})

// disabled 现状（S6 只读探测结论）：没有统一语义，5 处都是「请求在途 / 前置缺失」的局部条件。
const DISABLED_SITES = [
  { name: '登记按钮', body: between('    function SingleSessionPill(props) {', '    function PressureBar('), cond: 'disabled: busy || !sessionId' },
  { name: '头部单会话开关', body: between('    function ConsoleHeader(', '    function OverviewView('), cond: 'disabled: singleBusy' },
  { name: '概览·立即压缩', body: overviewView, cond: 'disabled: busySession === workspace.sessionId' },
  { name: '概览·删除单会话', body: overviewView, cond: 'disabled: busySession === workspace.sessionId,' },
  { name: '保存按钮', body: saveBar, cond: 'disabled: !form' },
]

test('disabled：5 处都有禁用条件，且都只在请求在途/前置缺失时置灰', () => {
  for (const site of DISABLED_SITES) {
    assert.ok(site.body.includes(site.cond), `${site.name} 应有 ${site.cond}`)
  }
  const total = (source.match(/disabled: /g) ?? []).length
  assert.equal(total, 5, `客户区禁用点应恒为 5 处，当前 ${total} 处；新增时更新本表与报告`)
})

test('disabled：被禁用的按钮与开关都有可见降级样式', () => {
  assert.match(source, /\.syh-btn:disabled\{opacity:\.5;cursor:default\}/, '普通按钮禁用应降透明度且不改光标形状')
  assert.match(source, /\.sysi:disabled\{cursor:default;opacity:\.7\}/, '登记按钮禁用应有视觉降级')
  assert.match(source, /\.sysi:hover:not\(:disabled\)/, '禁用态不应再有 hover 反馈')
})

test('disabled：统一语义尚未定义（disabledReason/aria-disabled 均为零）', {
  todo: 'S6 只读探测：无统一 disabled 抽象——建议后续引入 disabledReason（禁用理由文案）+ aria-disabled，见 S6 报告第 3 节',
}, () => {
  // 暂不执行：现状没有统一语义，等方案拍板后再把这条换成真断言。
})
