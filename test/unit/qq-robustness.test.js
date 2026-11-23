import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPersonalQqSource } from '../../lib/source/qq/personal.js'
import { createRoostHostClient } from '../../lib/source/qq/roost-host.js'

const baseCfg = {
  mode: 'personal',
  requireAt: false,
  allowedGroups: [],
  authors: [],
  confirmWrites: false,
  personal: { httpUrl: 'http://127.0.0.1:6700', wsUrl: 'ws://127.0.0.1:6700', httpToken: '', wsToken: '', selfId: '999', snowLumaDir: '' },
}

test('事件队列超过 1000 条时丢最旧，不涨内存', async () => {
  let push
  const factory = (opts) => {
    push = opts.onEvent
    return { call: async () => ({}), start() {}, stop() {}, state: 'connected' }
  }
  const source = createPersonalQqSource(baseCfg, { clientFactory: factory })
  for (let i = 1; i <= 1005; i += 1) {
    push({
      post_type: 'message',
      message_type: 'group',
      group_id: 100,
      user_id: 123,
      message_id: i,
      time: 1795000000 + i,
      raw_message: `消息 ${i}`,
      message: [{ type: 'text', data: { text: `消息 ${i}` } }],
      sender: { user_id: 123 },
    })
  }
  const result = await source.poll(null)
  assert.equal(result.triggers.length, 1000)
  assert.equal(result.triggers[0].id, 'msg-6')
  source.dispose()
})

test('roost-host 客户端：401 明确失败，成功路径返回 data', async () => {
  const unauthorized = createRoostHostClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 'bad',
    onEvent() {},
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'UNAUTHORIZED' } }) }),
  })
  await assert.rejects(() => unauthorized.call('system.capabilities'), /HTTP 401/)

  const ok = createRoostHostClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 'good',
    onEvent() {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: '1', ok: true, data: { methods: {} } }) }),
  })
  assert.deepEqual(await ok.call('system.capabilities'), { methods: {} })
})

test('roost-host 客户端：业务错误带 code 抛出', async () => {
  const client = createRoostHostClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 't',
    onEvent() {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'NO_SCOPE', message: '缺 message' } }) }),
  })
  await assert.rejects(() => client.call('msg.send'), /NO_SCOPE/)
})
