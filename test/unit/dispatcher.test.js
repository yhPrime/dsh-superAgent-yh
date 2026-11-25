import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../../lib/dispatcher.js'
import { registerDiagnostics } from '../../lib/diagnostics.js'

function harness({ tools, keep, definitionsError, restrictError } = {}) {
  const calls = { restrict: [], warn: [], info: [], changeListeners: [] }
  const toolList = tools ?? [
    { name: 'ops_bash' },
    { name: 'exp_recall' },
    { name: 'cycle_search' },
    { name: 'run_code' },
    { name: 42 },
  ]
  const ctx = {
    logger: {
      warn: (...args) => calls.warn.push(args),
      info: (...args) => calls.info.push(args),
    },
    root: {
      on: (event, listener) => {
        if (event === 'tools/change') calls.changeListeners.push(listener)
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      definitions: () => {
        if (definitionsError) throw new Error(definitionsError)
        return toolList
      },
      restrict: (filter) => {
        if (restrictError) throw new Error(restrictError)
        calls.restrict.push(filter)
        return () => {}
      },
    },
  }
  return { ctx, calls, config: keep === undefined ? {} : { keep } }
}

test('dispatcher：隐藏所有全局工具，排除保留名 run_code', () => {
  const h = harness()
  apply(h.ctx, h.config)
  assert.equal(h.calls.restrict.length, 1)
  assert.deepEqual(h.calls.restrict[0], { deny: ['ops_bash', 'exp_recall', 'cycle_search'] })
  assert.equal(h.calls.info.length, 1)
})

test('dispatcher：config.keep 里的工具不隐藏', () => {
  const h = harness({ keep: ['ops_bash'] })
  apply(h.ctx, h.config)
  assert.deepEqual(h.calls.restrict[0], { deny: ['exp_recall', 'cycle_search'] })
})

test('dispatcher：restrict 失败只 warn，不阻断会话', () => {
  const h = harness({ restrictError: 'names unknown global tool' })
  assert.doesNotThrow(() => apply(h.ctx, h.config))
  assert.ok(h.calls.warn.length >= 1)
  assert.match(String(h.calls.warn[0][0]), /batch restrict failed/)
})

test('dispatcher：列不出全局工具时只 warn', () => {
  const h = harness({ definitionsError: 'no scope' })
  assert.doesNotThrow(() => apply(h.ctx, h.config))
  assert.equal(h.calls.restrict.length, 0)
  assert.match(String(h.calls.warn[0][0]), /cannot list global tools/)
})

test('dispatcher：没有可隐藏的工具时不调用 restrict', () => {
  const h = harness({ tools: [{ name: 'run_code' }] })
  apply(h.ctx, h.config)
  assert.equal(h.calls.restrict.length, 0)
})

test('dispatcher：完全没收敛（denied 为空）也要留下可查 warn', () => {
  const h = harness({ tools: [{ name: 'run_code' }] })
  const seen = []
  const off = registerDiagnostics((entry) => seen.push(entry))
  try {
    assert.doesNotThrow(() => apply(h.ctx, h.config))
  } finally {
    off()
  }
  assert.equal(h.calls.restrict.length, 0)
  assert.equal(h.calls.warn.length, 1)
  assert.match(String(h.calls.warn[0][0]), /no global tool to hide/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].level, 'warn')
  assert.equal(seen[0].message, String(h.calls.warn[0][0]))
  assert.match(seen[0].message, /^dispatcher: /)
})

test('dispatcher：整批被拒时逐个重试，能藏的都藏上', () => {
  const calls = []
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => {
      fn()
      return () => {}
    },
    tools: {
      definitions: () => [{ name: 'ops_bash' }, { name: 'exp_recall' }],
      restrict: (filter) => {
        if (filter.deny.length > 1) throw new Error('names unknown global tool')
        calls.push(filter)
        return () => {}
      },
    },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.deepEqual(calls, [{ deny: ['ops_bash'] }, { deny: ['exp_recall'] }])
})

test('dispatcher：apply 之后异步注册的工具由 tools/change 增量补齐', () => {
  const tools = [{ name: 'ops_bash' }]
  const h = harness({ tools, keep: ['delegate'] })
  apply(h.ctx, h.config)
  assert.equal(h.calls.changeListeners.length, 1)
  assert.equal(h.calls.restrict.length, 1)
  tools.push({ name: 'compress' }, { name: 'delegate' })
  for (const listener of h.calls.changeListeners) listener('tools/change')
  assert.deepEqual(h.calls.restrict[1], { deny: ['compress'] })
  // 新增 restriction 本身会再次触发 tools/change：必须去重，不能无限 deny。
  for (const listener of h.calls.changeListeners) listener('tools/change')
  assert.equal(h.calls.restrict.length, 2)
  assert.equal(h.calls.info.at(-1)[1], 2)
  assert.match(String(h.calls.info.at(-1)[0]), /global tool\(s\) after/)
})

test('dispatcher：重放时单个工具失败只 warn，不阻断其余工具', () => {
  const tools = [{ name: 'ops_bash' }]
  const h = harness({ tools })
  apply(h.ctx, h.config)
  tools.push({ name: 'compress' }, { name: 'search_context' })
  const realRestrict = h.ctx.tools.restrict
  h.ctx.tools.restrict = (filter) => {
    if (filter.deny.includes('compress')) throw new Error('bad tool')
    return realRestrict(filter)
  }
  for (const listener of h.calls.changeListeners) listener('tools/change')
  assert.deepEqual(h.calls.restrict.at(-1), { deny: ['search_context'] })
  assert.match(String(h.calls.warn.at(-1)[0]), /could not hide 1\/2 new global tool/)
})

test('dispatcher：模块名与注入契约', () => {
  assert.equal(name, 'dsh-superagent-yh-dispatcher')
  assert.deepEqual(inject, ['tools'])
})
