import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPersonalQqSource, normalizePersonalEvent } from '../../lib/source/qq/personal.js'

const baseCfg = {
  mode: 'personal',
  requireAt: true,
  allowedGroups: [],
  authors: [],
  confirmWrites: true,
  personal: { httpUrl: 'http://127.0.0.1:6700', wsUrl: 'ws://127.0.0.1:6700', httpToken: '', wsToken: '', selfId: '999', snowLumaDir: '' },
}

function fakeClientFactory() {
  const box = { events: [], calls: [], started: 0, stopped: 0 }
  return {
    box,
    factory: (opts) => {
      box.onEvent = opts.onEvent
      return {
        call: async (action, params) => {
          box.calls.push({ action, params })
          return { message_id: 1001 }
        },
        start: () => {
          box.started += 1
        },
        stop: () => {
          box.stopped += 1
        },
        state: 'connected',
      }
    },
  }
}

const groupEvent = (overrides = {}) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: 100,
  user_id: 123,
  message_id: 5,
  time: 1795000000,
  raw_message: '[CQ:at,qq=999] 请修一下',
  message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' 请修一下' } }],
  sender: { user_id: 123 },
  ...overrides,
})

test('群 @ 消息规范化为 Trigger', () => {
  const trigger = normalizePersonalEvent(groupEvent(), baseCfg)
  assert.equal(trigger.id, 'msg-5')
  assert.equal(trigger.thread, 'group:100')
  assert.equal(trigger.actor, '123')
  assert.equal(trigger.kind, 'message')
  assert.match(trigger.title, /请修一下/)
  assert.doesNotMatch(trigger.body, /\[CQ:/)
})

test('过滤：没 @、自己发的、群不在白名单、作者不在白名单、非 message', () => {
  assert.equal(normalizePersonalEvent(groupEvent({ message: [{ type: 'text', data: { text: 'hi' } }] }), baseCfg), null)
  assert.equal(normalizePersonalEvent(groupEvent({ user_id: '999', sender: { user_id: 999 } }), baseCfg), null)
  assert.equal(normalizePersonalEvent(groupEvent(), { ...baseCfg, allowedGroups: ['200'] }), null)
  assert.equal(normalizePersonalEvent(groupEvent(), { ...baseCfg, authors: ['456'] }), null)
  assert.equal(normalizePersonalEvent({ ...groupEvent(), post_type: 'notice' }, baseCfg), null)
})

test('私聊消息不需要 @', () => {
  const event = groupEvent({ message_type: 'private', group_id: undefined, raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }] })
  const trigger = normalizePersonalEvent(event, baseCfg)
  assert.equal(trigger.thread, 'private:123')
})

test('源：事件入队 → poll 出 Trigger；send 调 send_group_msg', async () => {
  const { box, factory } = fakeClientFactory()
  const source = createPersonalQqSource(baseCfg, { clientFactory: factory })
  assert.equal(box.started, 1)
  box.onEvent(groupEvent())
  const result = await source.poll(null)
  assert.equal(result.triggers.length, 1)
  await source.send('group:100', '【superagent】完成')
  assert.deepEqual(box.calls[0], { action: 'send_group_msg', params: { group_id: 100, message: '【superagent】完成' } })
  await source.send('private:123', 'hi')
  assert.equal(box.calls[1].action, 'send_private_msg')
  source.dispose()
  assert.equal(box.stopped, 1)
})

test('重复 message_id 只入队一次', async () => {
  const { box, factory } = fakeClientFactory()
  const source = createPersonalQqSource(baseCfg, { clientFactory: factory })
  box.onEvent(groupEvent())
  box.onEvent(groupEvent())
  const result = await source.poll(null)
  assert.equal(result.triggers.length, 1)
})

test('confirmWrites=false 时 send 抛错', async () => {
  const { factory } = fakeClientFactory()
  const source = createPersonalQqSource({ ...baseCfg, confirmWrites: false }, { clientFactory: factory })
  await assert.rejects(() => source.send('group:100', 'hi'), /回写未开启/)
})
