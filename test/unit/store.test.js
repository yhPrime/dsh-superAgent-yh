import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, StoreLockedError, STATE_VERSION } from '../../lib/store.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'superagent-store-'))

test('落盘后重新打开能读回', () => {
  const dir = tempDir()
  const store = openStore({ dir })
  store.update((state) => {
    state.watermark.github = '2026-01-01T00:00:00.000Z'
    state.tickets['github:issue-1'] = { id: 'github:issue-1', status: 'queued' }
  })
  store.close()

  const reopened = openStore({ dir })
  assert.equal(reopened.state.watermark.github, '2026-01-01T00:00:00.000Z')
  assert.equal(reopened.state.tickets['github:issue-1'].status, 'queued')
  reopened.close()
})

test('单写者锁：第二个实例被拒，关闭后可再开', () => {
  const dir = tempDir()
  const first = openStore({ dir })
  assert.throws(() => openStore({ dir }), StoreLockedError)
  first.close()
  const second = openStore({ dir })
  second.close()
})

test('死进程留下的旧锁可被接管', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 999999, at: 0 }))
  const store = openStore({ dir })
  assert.ok(store.state.version === STATE_VERSION)
  store.close()
})

test('未来版本的 state 拒绝降级读取', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 99 }))
  assert.throws(() => openStore({ dir }), /高于插件支持/)
})

test('旧 state 迁移补齐缺省字段', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1 }))
  const store = openStore({ dir })
  assert.deepEqual(store.state.tickets, {})
  assert.deepEqual(store.state.watermark, {})
  store.close()
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.version, STATE_VERSION)
})

test('迁移：丢掉 0.9.0 误判的子会话噪音缓存，只丢一次', () => {
  const dir = tempDir()
  const store = openStore({ dir })
  store.update((state) => {
    state.singleSessionChildNoise = { c1: 'empty', c2: 'empty' }
    state.singleSessionChildUnknown = { c3: { at: 1 } }
  })
  store.close()
  const reopened = openStore({ dir })
  assert.equal(reopened.state.singleSessionChildNoise, undefined)
  assert.equal(reopened.state.singleSessionChildUnknown, undefined)
  assert.equal(reopened.state.singleSessionChildNoiseVersion, 1)
  reopened.update((state) => { state.singleSessionChildNoise = { c9: 'echo' } })
  reopened.close()
  const again = openStore({ dir })
  assert.equal(again.state.singleSessionChildNoise.c9, 'echo')
  again.close()
})
