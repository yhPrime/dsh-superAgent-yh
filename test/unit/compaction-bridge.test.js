import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, compactionEngineFor, inject, name } from '../../lib/compaction-bridge.js'

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

test('compaction-bridge：没有 preset 或无 compaction 服务时不登记、只 warn', () => {
  const warnings = []
  const ctx = harness()
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  apply(ctx, {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /config\.preset/)
  apply({ ...ctx, compaction: null }, { preset: 'p-three' })
  assert.equal(compactionEngineFor('p-three'), null)
  assert.equal(warnings.length, 2)
  assert.match(warnings[1], /没有 compaction 服务/)
})

test('compaction-bridge：模块契约', () => {
  assert.equal(name, 'dsh-superagent-yh-compaction-bridge')
  assert.deepEqual(inject, ['compaction'])
})
