import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeSettings, configView } from '../../lib/panel.js'
import { normalizeConfig, ConfigError } from '../../lib/config.js'

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

const base = () => normalizeConfig({ dryRun: true })

test('mergeSettings：顶字段与 GitHub 源深合并，数组按逗号拆', () => {
  const current = base()
  const next = mergeSettings(current, {
    dryRun: false,
    mainSessionId: 'main-1',
    pollIntervalMs: 5000,
    sources: {
      github: { enabled: true, repo: 'a/b', labels: 'bug, superagent', authors: 'tester', confirmWrites: true },
    },
  })
  assert.equal(next.dryRun, false)
  assert.equal(next.mainSessionId, 'main-1')
  assert.equal(next.pollIntervalMs, 5000)
  assert.equal(next.sources.github.repo, 'a/b')
  assert.deepEqual(next.sources.github.labels, ['bug', 'superagent'])
  assert.deepEqual(next.sources.github.authors, ['tester'])
  assert.equal(next.sources.github.confirmWrites, true)
  // 未触碰的源保持原样
  assert.equal(next.sources.feishu.enabled, false)
})

test('mergeSettings：空 token 不覆盖，非空才写', () => {
  const current = base()
  current.sources.github.token = 'keep-me'
  const kept = mergeSettings(current, { sources: { github: { token: '' } } })
  assert.equal(kept.sources.github.token, 'keep-me')
  const replaced = mergeSettings(current, { sources: { github: { token: 'new-token' } } })
  assert.equal(replaced.sources.github.token, 'new-token')
})

test('mergeSettings：QQ 两模式嵌套字段合并', () => {
  const next = mergeSettings(base(), {
    sources: {
      qq: {
        enabled: true,
        mode: 'personal',
        requireAt: true,
        personal: { httpUrl: 'http://127.0.0.1:6700', wsUrl: 'ws://127.0.0.1:6700', selfId: '999' },
        official: { host: '127.0.0.1', port: 6807, token: 't' },
      },
    },
  })
  assert.equal(next.sources.qq.mode, 'personal')
  assert.equal(next.sources.qq.personal.selfId, '999')
  assert.equal(next.sources.qq.official.port, 6807)
  assert.equal(next.sources.qq.official.token, 't')
})

test('mergeSettings 后仍走配置校验（启用 GitHub 但缺 repo 会抛）', () => {
  const next = mergeSettings(base(), { sources: { github: { enabled: true } } })
  assert.throws(() => normalizeConfig(next), ConfigError)
})

test('configView 不回明文 token，只给 hasToken', () => {
  const config = base()
  config.sources.github.token = 'secret-gh'
  config.sources.feishu.appSecret = 'secret-fs'
  config.sources.qq.official.token = 'secret-qq'
  const view = configView(config)
  const text = JSON.stringify(view)
  assert.doesNotMatch(text, /secret-gh|secret-fs|secret-qq/)
  assert.equal(view.sources.github.hasToken, true)
  assert.equal(view.sources.feishu.hasSecret, true)
  assert.equal(view.sources.qq.official.hasToken, true)
  assert.equal(view.version, VERSION)
})
