import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialQqSource, normalizeOfficialFrame } from '../../lib/source/qq/official.js'

const baseCfg = {
  mode: 'official',
  requireAt: true,
  allowedGroups: [],
  authors: [],
  confirmWrites: true,
  official: { host: '127.0.0.1', port: 6807, token: 't', allowRemote: false },
}

const frame = (overrides = {}) => ({
  type: 'message',
  seq: 42,
  at: 1795000000000,
  data: {
    chat: { kind: 'group', chatId: 'g1', groupUin: '100' },
    sender: { openid: 'u1', uin: '123' },
    content: '@机器人 请修一下',
    eventId: 'e1',
    msgId: 'm0',
    addressed: true,
    mentioned: true,
    ...overrides,
  },
})

function fakeClientFactory({ capabilities = { methods: { 'msg.send': { scope: 'message' } } } } = {}) {
  const box = { events: [], calls: [] }
  const factory = (opts) => {
    box.onEvent = opts.onEvent
    return {
      call: async (method, params) => {
        box.calls.push({ method, params })
        if (method === 'system.capabilities') return capabilities
        return { id: 'sent-1' }
      },
      start: () => {},
      stop: () => {},
      state: 'connected',
    }
  }
  return { box, factory }
}

test('message 帧规范化为 Trigger', () => {
  const trigger = normalizeOfficialFrame(frame(), baseCfg)
  assert.equal(trigger.id, 'msg-e1')
  assert.equal(trigger.thread, 'chat:group:g1')
  assert.equal(trigger.actor, 'u1')
  assert.equal(trigger.kind, 'message')
})

test('过滤：群没 @、作者不在白名单、会话类型不支持', () => {
  assert.equal(normalizeOfficialFrame(frame({ addressed: false, mentioned: false }), baseCfg), null)
  assert.equal(normalizeOfficialFrame(frame(), { ...baseCfg, authors: ['u2'] }), null)
  assert.equal(normalizeOfficialFrame(frame({ chat: { kind: 'unknown', chatId: 'x' } }), baseCfg), null)
  assert.equal(normalizeOfficialFrame({ type: 'welcome' }, baseCfg), null)
})

test('源：事件入队 → poll 先探测 capabilities 再出 Trigger', async () => {
  const { box, factory } = fakeClientFactory()
  const source = createOfficialQqSource(baseCfg, { clientFactory: factory })
  box.onEvent(frame())
  const result = await source.poll(null)
  assert.equal(result.triggers.length, 1)
  assert.equal(box.calls[0].method, 'system.capabilities')
})

test('capabilities 缺 msg.send 时 poll fail-closed', async () => {
  const { box, factory } = fakeClientFactory({ capabilities: { methods: {} } })
  const source = createOfficialQqSource(baseCfg, { clientFactory: factory })
  box.onEvent(frame())
  await assert.rejects(() => source.poll(null), /不支持 msg\.send/)
})

test('send 调 msg.send 并带 requestId/receivedAt', async () => {
  const { box, factory } = fakeClientFactory()
  const source = createOfficialQqSource(baseCfg, { clientFactory: factory })
  await source.send('chat:group:g1', '【superagent】完成', { requestId: 'r1', receivedAt: 1795000000000 })
  const call = box.calls.find((item) => item.method === 'msg.send')
  assert.deepEqual(call.params, {
    kind: 'group',
    chatId: 'g1',
    content: '【superagent】完成',
    receivedAt: 1795000000000,
    requestId: 'r1',
  })
})

test('confirmWrites=false 时 send 抛错；gap 帧记错误', async () => {
  const { box, factory } = fakeClientFactory()
  const source = createOfficialQqSource({ ...baseCfg, confirmWrites: false }, { clientFactory: factory })
  await assert.rejects(() => source.send('chat:group:g1', 'hi'), /回写未开启/)
  box.onEvent({ type: 'gap' })
  await assert.rejects(() => source.poll(null), /gap|不可用/)
})
