import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, ConfigError } from '../../lib/config.js'

test('默认 dryRun=true，三个源全部关闭', () => {
  const config = normalizeConfig({})
  assert.equal(config.dryRun, true)
  assert.equal(config.sources.github.enabled, false)
  assert.equal(config.sources.feishu.enabled, false)
  assert.equal(config.sources.qq.enabled, false)
  assert.equal(config.maxWorkers, 1)
  assert.ok(config.stateDir.includes('dsh-superagent-yh'))
})

test('只接受布尔 true 才关闭 dryRun（防 "false" 字符串误判）', () => {
  assert.equal(normalizeConfig({ dryRun: false }).dryRun, false)
  assert.equal(normalizeConfig({ dryRun: 'false' }).dryRun, true)
})

test('GitHub repo 必须是 owner/name', () => {
  assert.throws(
    () => normalizeConfig({ sources: { github: { enabled: true, repo: 'not-a-repo' } } }),
    ConfigError,
  )
})

test('启用源且 dryRun=false 必须给 repoPath', () => {
  assert.throws(
    () => normalizeConfig({ dryRun: false, sources: { github: { enabled: true, repo: 'a/b' } } }),
    /repoPath/,
  )
})

test('QQ 源启用即 fail-closed', () => {
  assert.throws(() => normalizeConfig({ sources: { qq: { enabled: true } } }), /未接入/)
  assert.throws(() => normalizeConfig({ sources: { qq: { enabled: true, mode: 'personal' } } }), /个人号源未接入/)
})

test('maxWorkers 只允许 1', () => {
  assert.throws(() => normalizeConfig({ maxWorkers: 2 }), /只支持 1/)
})

test('pollIntervalMs 下限 1s', () => {
  assert.equal(normalizeConfig({ pollIntervalMs: 10 }).pollIntervalMs, 1000)
})
