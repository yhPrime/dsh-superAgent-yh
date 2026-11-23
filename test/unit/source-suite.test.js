/**
 * 源一致性套件：GitHub / 飞书 / QQ 空实现同跑同一组最小契约断言。
 * 任何一个源实现不合格，这里必须红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSource, contractCheck, normalizeTrigger } from '../../lib/source/contract.js'
import { createGithubSource } from '../../lib/source/github.js'
import { createFeishuSource } from '../../lib/source/feishu.js'
import { createQqPlaceholder } from '../../lib/source/qq.js'

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, async json() { return body }, async text() { return JSON.stringify(body) } }
}

function githubFixture() {
  return createGithubSource(
    { repo: 'a/b', labels: [], assignee: '', authors: [], token: '', apiBase: 'https://api.github.com', confirmWrites: false },
    {
      fetchImpl: async () => response(200, [{
        number: 7,
        title: 't',
        body: 'b',
        updated_at: '2026-02-01T00:00:00Z',
        html_url: 'u',
        user: { login: 'tester' },
        labels: [],
        assignees: [],
      }]),
    },
  )
}

function feishuFixture() {
  return createFeishuSource(
    { appId: 'a', appSecret: 's', chatIds: ['oc_1'], authors: [], botOpenId: '', requireMention: false, apiBase: 'https://open.feishu.cn', confirmWrites: false },
    {
      fetchImpl: async (url) => {
        if (url.includes('tenant_access_token')) return response(200, { code: 0, tenant_access_token: 't', expire: 7200 })
        return response(200, {
          code: 0,
          data: {
            has_more: false,
            items: [{
              message_id: 'om_1',
              msg_type: 'text',
              create_time: String(Date.parse('2026-02-01T00:00:00Z')),
              sender: { id: 'ou_1', sender_type: 'user' },
              body: { content: JSON.stringify({ text: '你好' }) },
              mentions: [],
            }],
          },
        })
      },
    },
  )
}

const assertTriggerShape = (trigger, kind) => {
  assert.equal(trigger.source, undefined)
  for (const field of ['id', 'thread', 'actor', 'title', 'body', 'url', 'at', 'kind']) assert.ok(trigger[field] !== undefined, `${kind} trigger 缺 ${field}`)
  assert.ok(!Number.isNaN(Date.parse(trigger.at)), `${kind} trigger.at 不是时间`)
  assert.equal(trigger.at, new Date(trigger.at).toISOString(), `${kind} trigger.at 不是 ISO`)
}

const CASES = [
  { name: 'github', create: githubFixture, expectTriggers: 1 },
  { name: 'feishu', create: feishuFixture, expectTriggers: 1 },
]

for (const testCase of CASES) {
  test(`一致性：${testCase.name} 契约与 poll 形状`, async () => {
    const raw = testCase.create()
    assert.deepEqual(contractCheck(raw), [])
    const source = assertSource(raw, testCase.name)
    const first = await source.poll(null)
    assert.ok(Array.isArray(first.triggers))
    assert.equal(first.triggers.length, testCase.expectTriggers)
    for (const trigger of first.triggers) assertTriggerShape(normalizeTrigger(trigger, testCase.name), testCase.name)
    assert.ok(first.since === null || !Number.isNaN(Date.parse(first.since)))
    const second = await source.poll(first.since)
    assert.ok(Array.isArray(second.triggers))
    const ack = await source.ack({ thread: first.triggers[0]?.thread ?? 'x' })
    assert.equal(typeof ack, 'object')
  })
}

test('一致性：QQ 空实现明确报未接入，不许静默', async () => {
  const source = assertSource(createQqPlaceholder('official'), 'qq')
  assert.deepEqual(contractCheck(source), [])
  await assert.rejects(() => source.poll(null), /QQ .*源未接入（fail-closed）/)
  await assert.rejects(() => source.send('x', 'y'), /未接入/)
})
