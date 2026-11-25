// S3 验收：视图提为显式 props 组件、3 段 CSS 合并为单一模块常量、Console 行数口径 ≤250。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientSource as source, loadClient } from '../tools/client-source.mjs'

// 行数口径（计划书 §09）：从 `function Console(` 起至匹配的右花括号止，
// 含注释与空行；不计 DICT / 模块级 token / __internals。
// 扫描时跳过字符串、模板字面量、行注释与块注释，避免把花括号当代码。
function skipString(text, index) {
  const quote = text[index]
  let i = index + 1
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === quote) return i + 1
    i += 1
  }
  return -1
}

// 从 `${` 的 `{` 位置（openIndex）匹配到配对的 `}`，跳过其中的字符串/注释/嵌套模板。
function matchBraces(text, openIndex) {
  let i = openIndex + 1
  let depth = 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) return -1
      i = nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close < 0) return -1
      i = close + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const next = skipString(text, i)
      if (next < 0) return -1
      i = next
      continue
    }
    if (ch === '`') {
      const next = skipTemplate(text, i)
      if (next < 0) return -1
      i = next
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

function skipTemplate(text, index) {
  let i = index + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '`') return i + 1
    if (ch === '$' && text[i + 1] === '{') {
      const close = matchBraces(text, i + 1)
      if (close < 0) return -1
      i = close + 1
      continue
    }
    i += 1
  }
  return -1
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

function findFunctionRange(text, signature) {
  const startIndex = text.indexOf(signature)
  assert.ok(startIndex >= 0, `应能找到 ${signature}`)
  const bodyStart = text.indexOf(') {', startIndex)
  assert.ok(bodyStart > startIndex, `${signature} 应有函数体`)
  const openIndex = bodyStart + 2

  let depth = 0
  let i = openIndex
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close < 0) break
      i = close + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const next = skipString(text, i)
      if (next < 0) break
      i = next
      continue
    }
    if (ch === '`') {
      const next = skipTemplate(text, i)
      if (next < 0) break
      i = next
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const startLine = lineAt(text, startIndex)
        const endLine = lineAt(text, i)
        const lineStart = startIndex === 0 ? 0 : text.lastIndexOf('\n', startIndex - 1) + 1
        return { startIndex, endIndex: i, startLine, endLine, lines: endLine - startLine + 1, text: text.slice(lineStart, i + 1) }
      }
    }
    i += 1
  }
  assert.fail(`没有找到 ${signature} 的匹配右花括号`)
}

const consoleRange = findFunctionRange(source, '    function Console({ ctx, compact = false, onClose }) {')

test('Console 行数口径 ≤250（含注释与空行，不含 DICT/模块级 token/__internals）', () => {
  assert.ok(
    consoleRange.lines <= 250,
    `Console 现有 ${consoleRange.lines} 行（${consoleRange.startLine}-${consoleRange.endLine}），超过计划书上限 250`,
  )
  // 计划书口径明确排除这些模块级内容，确认它们不在 Console 体内。
  assert.ok(!consoleRange.text.includes('const DICT'), 'Console 体内不应含 DICT')
  assert.ok(!consoleRange.text.includes('__internals'), 'Console 体内不应含 __internals')
  assert.ok(!consoleRange.text.includes('const TAB_LABELS'), 'Console 体内不应含模块级 token')
})

test('视图已提为模块级、显式 props 组件，且 Console 只按页签选择视图', () => {
  const views = ['OverviewView', 'TicketsView', 'RolesView', 'SourcesView', 'SettingsView']
  for (const name of views) {
    const signature = new RegExp(`^    function ${name}\\(\\{ [^}]+\\}\\) \\{`, 'm')
    assert.match(source, signature, `${name} 应是模块级 function 且以显式 props 解构入参`)
    const range = findFunctionRange(source, `    function ${name}({`)
    assert.ok(range.startIndex < consoleRange.startIndex, `${name} 应定义在 Console 之前（模块级）`)
    assert.ok(!/function\s+\(/.test(range.text.split('\n').slice(0, 2).join('\n')), `${name} 不应使用匿名函数形式`)
  }
  for (const name of views) {
    assert.match(source, new RegExp(`h\\(${name}, \\{ t,`), `Console 应以显式 props 渲染 ${name}`)
  }
})

test('3 段内联 CSS 合并为单一模块级常量，类名不变', () => {
  assert.ok(!/const PILL_CSS\s*=/.test(source), '不应残留 PILL_CSS 常量')
  assert.ok(!/const BOARD_CSS\s*=/.test(source), '不应残留 BOARD_CSS 常量')
  assert.ok(!source.includes("h('style', null, PILL_CSS)"), '不应再有引用 PILL_CSS 的 style 节点')
  assert.ok(!source.includes("h('style', null, BOARD_CSS)"), '不应再有引用 BOARD_CSS 的 style 节点')
  const cssDeclarations = [...source.matchAll(/^    const CSS = `/gm)]
  assert.equal(cssDeclarations.length, 1, '模块级应只有一个 CSS 常量')

  // 原 PILL_CSS / BOARD_CSS 的类名与关键规则必须仍在。
  for (const selector of ['.sysi{', '.sysi:hover', '.syhb{', '.syhb-row{', '.syhb-dot{', '.syhb-subject{', '.syhb-muted']) {
    assert.ok(source.includes(selector), `合并后的 CSS 缺少 ${selector}`)
  }
  const styleSites = [...source.matchAll(/h\('style', null, CSS\)/g)]
  assert.equal(styleSites.length, 3, 'Console / SingleSessionPill / SessionBoard 三处都应引用同一个 CSS')
})

test('页签标签映射覆盖全部页签，且不再回退到概览文案', () => {
  const { __internals: internals } = loadClient()
  const { TABS, TAB_LABELS, DICT } = internals

  assert.deepEqual(TABS, ['overview', 'tickets', 'roles', 'sources', 'settings'])
  assert.equal(Object.keys(TAB_LABELS).length, TABS.length, '每个页签都要有自己的标签文案 key')

  const labelKeys = TABS.map((tab) => TAB_LABELS[tab])
  assert.ok(labelKeys.every(Boolean), `页签缺少标签映射：${TABS.filter((tab) => !TAB_LABELS[tab]).join(', ')}`)
  assert.equal(new Set(labelKeys).size, TABS.length, '标签文案 key 不能重复（否则视觉上会撞文案）')
  assert.equal(TAB_LABELS.roles, 'rolesTab')
  assert.notEqual(TAB_LABELS.roles, TAB_LABELS.overview, '角色页签不能用概览的文案（原 bug）')

  for (const key of labelKeys) {
    assert.ok(key in DICT.zh, `DICT.zh 缺少 ${key}`)
    assert.ok(key in DICT.en, `DICT.en 缺少 ${key}`)
    assert.ok(String(DICT.zh[key]).trim() && String(DICT.en[key]).trim(), `${key} 文案不能为空`)
  }
  // 五个页签视觉上必须两两不同（zh/en 各自）。
  assert.equal(new Set(TABS.map((tab) => DICT.zh[TAB_LABELS[tab]])).size, TABS.length, 'zh 页签文案应两两不同')
  assert.equal(new Set(TABS.map((tab) => DICT.en[TAB_LABELS[tab]])).size, TABS.length, 'en 页签文案应两两不同')
})
