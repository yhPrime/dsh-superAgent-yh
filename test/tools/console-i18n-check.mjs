#!/usr/bin/env node
// 控制台 i18n 护栏（S0）：zh/en 键集合零差集、无空值、无未使用键。
// 退出码非 0 表示失败。解析逻辑复用 test/tools/client-source.mjs，避免两套解析器。
import { clientSource, loadDict } from './client-source.mjs'

const problems = []
const dict = loadDict()
const zhKeys = Object.keys(dict.zh).sort()
const enKeys = Object.keys(dict.en).sort()

for (const key of zhKeys) {
  if (!(key in dict.en)) problems.push(`en 缺少键：${key}`)
}
for (const key of enKeys) {
  if (!(key in dict.zh)) problems.push(`zh 缺少键：${key}`)
}

for (const [locale, entries] of Object.entries(dict)) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}.${key} 为空值`)
  }
}

// 判断「未使用」：键名必须作为字符串字面量在 client.js 源码里出现过。
// 动态取值的键（如 t(ticket.status)）都另有对应字面量（状态数组、TABS 等），故按字面量并集判定。
const literals = new Set([...clientSource.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((match) => match[1] ?? match[2]))
for (const key of zhKeys) {
  if (!literals.has(key)) problems.push(`未使用的键（zh/en 都有但源码未引用）：${key}`)
}

if (problems.length > 0) {
  console.error(`i18n 检查失败（${problems.length} 项）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`i18n 检查通过：zh ${zhKeys.length} 键 / en ${enKeys.length} 键，无空值、无差集、无未使用键。`)
}
