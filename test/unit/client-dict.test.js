import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

function loadDict() {
  let captured = null
  let registered = null
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  const ReactStub = { createElement: (...args) => args, useReducer: (initial) => [initial, () => {}], useState: (initial) => [initial, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn() }
  const requireStub = () => ReactStub
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(windowStub, requireStub)
  assert.ok(captured, 'client.js 应该调用 __ModuleLoader__.load')
  const mod = captured.factory(requireStub)
  const locale = { register: (_ns, dict) => { registered = dict; return () => {} }, subscribe: () => () => {}, bind: () => (key) => key }
  const child = { get: () => undefined, effect: (fn) => { fn(); return () => {} }, slots: { inject: () => () => {}, register: () => () => {} }, locale }
  const ctx = {
    locale,
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: (_deps, callback) => { callback(child) },
    layout: { selectPanel: () => {} },
  }
  mod.apply(ctx)
  assert.ok(registered?.zh && registered?.en, '应注册 zh/en 两套 DICT')
  return registered
}

test('client.js 里所有 t(...) 字面量 key 都在 DICT 里', () => {
  const dict = loadDict()
  const keys = [...new Set([...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]))]
  assert.ok(keys.length > 0, '应能扫到 t(...) 字面量')

  const missingZh = keys.filter((key) => !(key in dict.zh))
  const missingEn = keys.filter((key) => !(key in dict.en))
  assert.deepEqual(missingZh, [], `DICT.zh 缺少：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `DICT.en 缺少：${missingEn.join(', ')}`)
})
