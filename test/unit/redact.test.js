import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRedactor } from '../../lib/redact.js'

test('已知密钥整串替换', () => {
  const redact = createRedactor(['super-secret-token'])
  assert.equal(redact('token=super-secret-token 结束'), 'token=[REDACTED] 结束')
})

test('常见 GitHub token 形态被替换', () => {
  const redact = createRedactor()
  assert.match(redact('用 ghp_abcdefghijklmnopqrstuvwxyz0123 访问'), /\[REDACTED\]/)
  assert.doesNotMatch(redact('用 ghp_abcdefghijklmnopqrstuvwxyz0123 访问'), /ghp_/)
  assert.match(redact('github_pat_11ABCDEFG0123456789_abcdefghijklmnop'), /\[REDACTED\]/)
})

test('对象递归脱敏，非字符串原样', () => {
  const redact = createRedactor(['s3cret'])
  const out = redact({ a: 's3cret', b: ['s3cret', 1, true, null], c: { d: 's3cret' } })
  assert.equal(out.a, '[REDACTED]')
  assert.equal(out.b[0], '[REDACTED]')
  assert.equal(out.b[1], 1)
  assert.equal(out.c.d, '[REDACTED]')
})
