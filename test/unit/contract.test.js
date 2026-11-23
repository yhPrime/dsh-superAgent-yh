import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrigger, assertSource, contractCheck, SourceError } from '../../lib/source/contract.js'

test('normalizeTrigger 补全并校验字段', () => {
  const trigger = normalizeTrigger({
    id: 1,
    thread: 'issue-1',
    actor: 'tester',
    title: '标题',
    at: '2026-01-01T00:00:00Z',
    kind: 'issue',
  }, 'github')
  assert.equal(trigger.id, '1')
  assert.equal(trigger.body, '')
  assert.equal(trigger.url, '')
  assert.throws(() => normalizeTrigger({ id: 1 }, 'github'), SourceError)
  assert.throws(() => normalizeTrigger({ id: 1, thread: 't', actor: 'a', title: 'x', at: 'not-a-date', kind: 'issue' }, 'github'), /at 非法/)
})

test('assertSource 绑定方法并校验 kind', () => {
  const source = assertSource({ kind: 'github', capabilities: { write: true }, poll: async () => ({ triggers: [], since: null }), ack: async () => ({}) }, 'github')
  assert.equal(source.kind, 'github')
  assert.equal(source.capabilities.write, true)
  assert.equal(source.send, null)
  assert.throws(() => assertSource({ kind: 'x', poll: async () => ({}) }, 'github'), /kind 不匹配/)
})

test('contractCheck 报出缺失能力', () => {
  const problems = contractCheck({ kind: 'x', capabilities: { write: true } })
  assert.ok(problems.includes('poll 必须是函数'))
  assert.ok(problems.includes('capabilities.write=true 时必须实现 send()'))
})
