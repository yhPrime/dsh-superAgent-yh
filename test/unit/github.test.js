import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGithubSource } from '../../lib/source/github.js'
import { SourceError } from '../../lib/source/contract.js'

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

const issue = (overrides = {}) => ({
  number: 1,
  title: '修复登录',
  body: '正文',
  state: 'open',
  updated_at: '2026-01-02T00:00:00Z',
  html_url: 'https://github.com/a/b/issues/1',
  user: { login: 'tester' },
  labels: [{ name: 'superagent' }],
  assignees: [{ login: 'tester' }],
  ...overrides,
})

const baseConfig = {
  repo: 'a/b',
  labels: ['superagent'],
  assignee: '',
  authors: ['tester'],
  token: '',
  apiBase: 'https://api.github.com',
  confirmWrites: false,
}

test('过滤 PR、标签、作者与 since，只留合法 issue', async () => {
  const calls = []
  const source = createGithubSource(baseConfig, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return response(200, [
        issue(),
        issue({ number: 2, pull_request: { url: 'x' } }),
        issue({ number: 3, labels: [{ name: 'other' }] }),
        issue({ number: 4, user: { login: 'stranger' } }),
        issue({ number: 5, updated_at: '2025-12-01T00:00:00Z' }),
      ])
    },
  })
  const result = await source.poll('2026-01-01T00:00:00.000Z')
  assert.equal(result.triggers.length, 1)
  assert.equal(result.triggers[0].id, 'issue-1')
  assert.equal(result.triggers[0].thread, 'issue-1')
  assert.equal(result.triggers[0].actor, 'tester')
  assert.equal(result.triggers[0].kind, 'issue')
  assert.equal(result.since, '2026-01-02T00:00:00Z')
  assert.match(calls[0].url, /repos\/a\/b\/issues/)
  assert.match(calls[0].url, /since=2026-01-01/)
})

test('assignee 过滤生效', async () => {
  const source = createGithubSource({ ...baseConfig, assignee: 'alice' }, {
    fetchImpl: async () => response(200, [issue(), issue({ number: 2, assignees: [{ login: 'alice' }], assignee: { login: 'alice' } })]),
  })
  const result = await source.poll(null)
  assert.deepEqual(result.triggers.map((t) => t.id), ['issue-2'])
})

test('403 限流抛 SourceError，带 retryAfterMs', async () => {
  const source = createGithubSource(baseConfig, {
    fetchImpl: async () => response(403, { message: 'rate limited' }, { 'retry-after': '30', 'x-ratelimit-remaining': '0' }),
  })
  await assert.rejects(() => source.poll(null), (error) => {
    assert.ok(error instanceof SourceError)
    assert.equal(error.status, 403)
    assert.equal(error.retryAfterMs, 30000)
    return true
  })
})

test('confirmWrites=false 时 send 抛错、ack 静默跳过', async () => {
  const source = createGithubSource(baseConfig, { fetchImpl: async () => response(200, []) })
  await assert.rejects(() => source.send('issue-1', 'hi'), /回写未开启/)
  const ack = await source.ack({ thread: 'issue-1' })
  assert.equal(ack.skipped, true)
})

test('有 token 时带 Authorization 头', async () => {
  let seen = null
  const source = createGithubSource({ ...baseConfig, token: 'abc123' }, {
    fetchImpl: async (_url, init) => {
      seen = init
      return response(200, [])
    },
  })
  await source.poll(null)
  assert.equal(seen.headers.authorization, 'Bearer abc123')
})
