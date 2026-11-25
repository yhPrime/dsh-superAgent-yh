// 读取并加载 client.js 的共享工具：单测与验收脚本共用同一套解析器，避免两套。
import { readFileSync } from 'node:fs'

export const clientSource = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

export const reactStub = {
  createElement: (...args) => args,
  useReducer: (initial) => [initial, () => {}],
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

export function loadClientModule(source = clientSource) {
  let captured = null
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  const requireStub = (name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(windowStub, requireStub)
  if (!captured) throw new Error('client.js 应该调用 __ModuleLoader__.load')
  return { definition: captured, requireStub }
}

export function loadClient(source = clientSource) {
  const { definition, requireStub } = loadClientModule(source)
  return definition.factory(requireStub)
}

export function loadDict(source = clientSource) {
  const mod = loadClient(source)
  let registered = null
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
  if (!registered?.zh || !registered?.en) throw new Error('应注册 zh/en 两套 DICT')
  return registered
}
