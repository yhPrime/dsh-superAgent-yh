import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../../lib/dispatcher.js'

function harness({ tools, keep, definitionsError, restrictError } = {}) {
  const calls = { restrict: [], warn: [], info: [] }
  const ctx = {
    logger: {
      warn: (...args) => calls.warn.push(args),
      info: (...args) => calls.info.push(args),
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      definitions: () => {
        if (definitionsError) throw new Error(definitionsError)
        return tools ?? [
          { name: 'ops_bash' },
          { name: 'exp_recall' },
          { name: 'cycle_search' },
          { name: 'run_code' },
          { name: 42 },
        ]
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

test('dispatcher：模块名与注入契约', () => {
  assert.equal(name, 'dsh-superagent-yh-dispatcher')
  assert.deepEqual(inject, ['tools'])
})
