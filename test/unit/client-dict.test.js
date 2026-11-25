import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientSource as source, loadDict } from '../tools/client-source.mjs'

test('client.js 里所有 t(...) 字面量 key 都在 DICT 里', () => {
  const dict = loadDict()
  const keys = [...new Set([...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]))]
  assert.ok(keys.length > 0, '应能扫到 t(...) 字面量')

  const missingZh = keys.filter((key) => !(key in dict.zh))
  const missingEn = keys.filter((key) => !(key in dict.en))
  assert.deepEqual(missingZh, [], `DICT.zh 缺少：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `DICT.en 缺少：${missingEn.join(', ')}`)
})
