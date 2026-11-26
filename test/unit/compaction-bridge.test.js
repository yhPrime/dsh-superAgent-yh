import assert from 'node:assert/strict'
import test from 'node:test'

import * as bridge from '../../lib/compaction-bridge.js'

const { apply, compactionEngineFor, name } = bridge

function harness(engine = { compactNow: async () => ({ ok: true }) }) {
  const ctx = {
    compaction: engine,
    logger: { warn: () => {} },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return ctx
}

test('compaction-bridge：按 preset 登记引擎，卸载时注销', () => {
  const engine = { compactNow: async () => ({ ok: true }) }
  const ctx = harness(engine)
  let dispose = null
  ctx.effect = (fn) => {
    dispose = fn()
  }
  apply(ctx, { preset: 'p-one' })
  assert.equal(compactionEngineFor('p-one'), engine)
  assert.equal(compactionEngineFor('p-two'), null)
  dispose()
  assert.equal(compactionEngineFor('p-one'), null)
})

test('compaction-bridge：服务晚到也能登记（惰性 inject，不阻塞 preset 挂载）', () => {
  const engine = { compactNow: async () => ({ ok: true }) }
  const calls = []
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => {
      fn()
    },
    inject: (deps, cb) => {
      calls.push(deps)
      cb({ compaction: engine })
    },
  }
  apply(ctx, { preset: 'p-late' })
  assert.deepEqual(calls, [['compaction']])
  assert.equal(compactionEngineFor('p-late'), engine)
})

test('compaction-bridge：没有 preset 时只 warn，不登记', () => {
  const warnings = []
  const ctx = harness()
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  apply(ctx, {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /config\.preset/)
})

test('compaction-bridge：没有 compaction 服务又没有 inject 能力时只 warn', () => {
  const warnings = []
  const ctx = harness(null)
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  apply(ctx, { preset: 'p-three' })
  assert.equal(compactionEngineFor('p-three'), null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /没有 compaction 服务/)
})

test('compaction-bridge：模块契约（不再导出 inject，避免 preset 挂载被卡）', () => {
  assert.equal(name, 'dsh-superagent-yh-compaction-bridge')
  assert.equal(bridge.inject, undefined)
})
