import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuSource } from '../../lib/source/feishu.js'
import { SourceError } from '../../lib/source/contract.js'

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

const message = (overrides = {}) => ({
  message_id: 'om_1',
  msg_type: 'text',
  create_time: String(Date.now()),
  sender: { id: 'ou_1', sender_type: 'user' },
  body: { content: JSON.stringify({ text: '@_user_1 请创建 M2.txt' }) },
  mentions: [{ id: { open_id: 'ou_bot' } }],
  ...overrides,
})

function fakeFetch({ items = [message()], tokenCode = 0 } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return response(200, tokenCode === 0
        ? { code: 0, tenant_access_token: 't-1', expire: 7200 }
        : { code: 99991663, msg: 'bad credential' })
    }
    if (url.includes('/im/v1/messages')) {
      if (init.method === 'POST') return response(200, { code: 0, data: { message_id: 'om_new' } })
      return response(200, { code: 0, data: { items, has_more: false } })
    }
    return response(404, { code: 404 })
  }
  return { impl, calls }
}

const baseConfig = {
  appId: 'cli_x',
  appSecret: 'secret',
  chatIds: ['oc_1'],
  authors: [],
  botOpenId: '',
  requireMention: true,
  apiBase: 'https://open.feishu.cn',
  confirmWrites: false,
}

test('token 缓存 + 轮询把 @ 消息规范化为 Trigger', async () => {
  const { impl, calls } = fakeFetch()
  const source = createFeishuSource(baseConfig, { fetchImpl: impl })
  const result = await source.poll('2026-01-01T00:00:00.000Z')
  assert.equal(result.triggers.length, 1)
  assert.equal(result.triggers[0].id, 'msg-om_1')
  assert.equal(result.triggers[0].thread, 'chat:oc_1')
  assert.equal(result.triggers[0].actor, 'ou_1')
  assert.equal(result.triggers[0].kind, 'message')
  assert.ok(calls.filter((c) => c.url.includes('tenant_access_token')).length === 1)
})

test('过滤：非文本、机器人发的、没有 @ 的、作者不在白名单', async () => {
  const items = [
    message(),
    message({ message_id: 'om_2', msg_type: 'image' }),
    message({ message_id: 'om_3', sender: { id: 'ou_app', sender_type: 'app' } }),
    message({ message_id: 'om_4', body: { content: JSON.stringify({ text: '没有提及' }) }, mentions: [] }),
    message({ message_id: 'om_5', sender: { id: 'ou_stranger', sender_type: 'user' } }),
  ]
  const source = createFeishuSource({ ...baseConfig, authors: ['ou_1'] }, { fetchImpl: fakeFetch({ items }).impl })
  const result = await source.poll(null)
  assert.deepEqual(result.triggers.map((t) => t.id), ['msg-om_1'])
})

test('botOpenId 过滤：只有 @ 指定机器人算触发', async () => {
  const source = createFeishuSource({ ...baseConfig, botOpenId: 'ou_other' }, { fetchImpl: fakeFetch().impl })
  const result = await source.poll(null)
  assert.equal(result.triggers.length, 0)
})

test('confirmWrites=false 时 send 抛错；ack 静默跳过', async () => {
  const source = createFeishuSource(baseConfig, { fetchImpl: fakeFetch().impl })
  await assert.rejects(() => source.send('chat:oc_1', 'hi'), /回写未开启/)
  assert.equal((await source.ack({})).skipped, true)
})

test('confirmWrites=true 时 send 发到 chat_id', async () => {
  const { impl, calls } = fakeFetch()
  const source = createFeishuSource({ ...baseConfig, confirmWrites: true }, { fetchImpl: impl })
  await source.send('chat:oc_1', 'hello')
  const post = calls.find((c) => c.init.method === 'POST' && c.url.includes('/im/v1/messages'))
  assert.ok(post)
  assert.match(post.url, /receive_id_type=chat_id/)
  assert.deepEqual(JSON.parse(post.init.body), { receive_id: 'oc_1', msg_type: 'text', content: JSON.stringify({ text: 'hello' }) })
})

test('token 获取失败抛 SourceError', async () => {
  const source = createFeishuSource(baseConfig, { fetchImpl: fakeFetch({ tokenCode: 99991663 }).impl })
  await assert.rejects(() => source.poll(null), (error) => error instanceof SourceError && /tenant_access_token/.test(error.message))
})
