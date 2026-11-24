import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeSettings, configView, originAllowed } from '../../lib/panel.js'
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

test('mergeSettings：repoPath 可写（真跑 worktree 源）', () => {
  const next = mergeSettings(base(), { repoPath: 'C:/work/repo' })
  assert.equal(next.repoPath, 'C:/work/repo')
})

test('mergeSettings 后仍走配置校验（启用 GitHub 但缺 repo 会抛）', () => {
  const next = mergeSettings(base(), { sources: { github: { enabled: true } } })
  assert.throws(() => normalizeConfig(next), ConfigError)
})

test('mergeSettings：singleSession 开关与参数按类型合并', () => {
  const next = mergeSettings(base(), {
    singleSession: { enabled: true, idleMinutes: 10, pressureRatio: 0.4, aggressive: true, keepRecentTurns: 3, autoCreate: false, sessionIdPrefix: 'ask' },
  })
  assert.equal(next.singleSession.enabled, true)
  assert.equal(next.singleSession.idleMinutes, 10)
  assert.equal(next.singleSession.pressureRatio, 0.4)
  assert.equal(next.singleSession.aggressive, true)
  assert.equal(next.singleSession.keepRecentTurns, 3)
  assert.equal(next.singleSession.autoCreate, false)
  assert.equal(next.singleSession.sessionIdPrefix, 'ask')
  // 非法值被忽略，不写坏配置
  const kept = mergeSettings(next, { singleSession: { idleMinutes: 'abc', enabled: 'yes' } })
  assert.equal(kept.singleSession.idleMinutes, 10)
  assert.equal(kept.singleSession.enabled, true)
})

test('mergeSettings：singleSession 非法数值经校验会抛', () => {
  const next = mergeSettings(base(), { singleSession: { pressureRatio: 2 } })
  assert.throws(() => normalizeConfig(next), ConfigError)
})

test('configView 暴露 singleSession 配置', () => {
  const view = configView(normalizeConfig({ singleSession: { enabled: true, idleMinutes: 12 } }))
  assert.equal(view.singleSession.enabled, true)
  assert.equal(view.singleSession.idleMinutes, 12)
})

test('origin：同源/回环放行，跨源拒绝（含桌面代理端口不一致、同源不带 Origin）', () => {
  const req = (origin, remote = '127.0.0.1', host = '127.0.0.1:50290') => ({ headers: { origin, host }, socket: { remoteAddress: remote } })
  const expected = 'http://127.0.0.1:50290'
  assert.equal(originAllowed(req('http://127.0.0.1:50290'), expected), true)
  // 桌面版前面套了本地代理：页面端口与 webServer 端口不同
  assert.equal(originAllowed(req('http://127.0.0.1:58299'), expected), true)
  assert.equal(originAllowed(req('http://localhost:58299'), expected), true)
  // 同源 fetch POST 不带 Origin（Chromium 行为）：回环来源放行
  assert.equal(originAllowed(req(undefined), expected), true)
  assert.equal(originAllowed(req(undefined, '8.8.8.8', '127.0.0.1:50290'), expected), true)
  assert.equal(originAllowed(req(undefined, '8.8.8.8', 'evil.example:80'), expected), false)
  assert.equal(originAllowed(req('https://evil.example'), expected), false)
  assert.equal(originAllowed(req('http://192.168.1.5:58299'), expected), false)
  assert.equal(originAllowed(req('null'), expected), true)
  assert.equal(originAllowed(req('null', '8.8.8.8', 'evil.example:80'), expected), false)
  assert.equal(originAllowed(req('http://127.0.0.1:1', '8.8.8.8', 'evil.example:80'), expected), false)
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
