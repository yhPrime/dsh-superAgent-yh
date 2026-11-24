import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessmentModeOf, parseVerdict, createAssessment, matchWorkspace } from '../../lib/assessment.js'
import { normalizeConfig } from '../../lib/config.js'

const ticket = { id: 'qq:1', source: 'qq', thread: 'group:1', actor: 'u1', title: '帮我看下这个报错', body: '截图里说 x is not defined', url: '' }

test('按源选研判模式：QQ=agent，GitHub/飞书=off', () => {
  const config = normalizeConfig({})
  assert.equal(assessmentModeOf(config, 'qq'), 'agent')
  assert.equal(assessmentModeOf(config, 'github'), 'off')
  assert.equal(assessmentModeOf(config, 'feishu'), 'off')
  assert.equal(config.sources.qq.assessment, 'agent')
  assert.equal(config.sources.github.assessment, 'off')
})

test('显式配置覆盖默认', () => {
  assert.equal(assessmentModeOf(normalizeConfig({ sources: { qq: { assessment: 'off' } } }), 'qq'), 'off')
  assert.equal(assessmentModeOf(normalizeConfig({ sources: { github: { assessment: 'agent' } } }), 'github'), 'agent')
})

test('parseVerdict：合法/非法', () => {
  const parsed = parseVerdict('{"verdict":"ignore","reason":"闲聊"}')
  assert.equal(parsed.verdict, 'ignore')
  assert.equal(parsed.reason, '闲聊')
  assert.equal(parsed.workspace, undefined)
  assert.equal(parseVerdict('{"verdict":"nope"}'), null)
  assert.equal(parseVerdict('没有 JSON'), null)
  assert.equal(parseVerdict(''), null)
  assert.equal(parseVerdict('{"verdict":"accept","preset":"coder"}').preset, 'coder')
  assert.equal(parseVerdict('{"verdict":"accept","workspace":"C:/repo"}').workspace, 'C:/repo')
})

test('matchWorkspace：只认候选清单里的 id/path（防幻觉）', () => {
  const list = [{ id: 'w1', path: 'C:/repo-a' }, { id: 'w2', path: 'C:\\repo-b' }]
  assert.equal(matchWorkspace('w1', list).id, 'w1')
  assert.equal(matchWorkspace('c:/repo-a', list).id, 'w1')
  assert.equal(matchWorkspace('C:/repo-b/', list).id, 'w2')
  assert.equal(matchWorkspace('D:/hallucinated', list), null)
  assert.equal(matchWorkspace('', list), null)
  assert.equal(matchWorkspace('w1', []), null)
})

test('off 源直通 accept，且不调模型', async () => {
  let calls = 0
  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({ sources: { github: { assessment: 'off' } } }), log: () => {}, redact: (x) => x,
    deps: { call: async () => { calls += 1; return '{"verdict":"ignore"}' } },
  })
  const out = await assessment.assess({ ...ticket, source: 'github' })
  assert.equal(out.verdict, 'accept')
  assert.equal(out.mode, 'off')
  assert.equal(calls, 0)
})

test('QQ 走模型：ignore/stop 生效并计数', async () => {
  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({}), log: () => {}, redact: (x) => x,
    deps: { call: async () => '{"verdict":"ignore","reason":"闲聊"}' },
  })
  const out = await assessment.assess(ticket)
  assert.equal(out.verdict, 'ignore')
  assert.equal(out.mode, 'agent')
  assert.equal(assessment.stats().calls, 1)
  assert.equal(assessment.stats().ignored, 1)
})

test('模型输出不可解析 → 回退 accept 并记错误', async () => {  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({}), log: () => {}, redact: (x) => x,
    deps: { call: async () => '我觉得可以' },
  })
  const out = await assessment.assess(ticket)
  assert.equal(out.verdict, 'accept')
  assert.equal(out.reason, 'fallback')
  assert.match(out.error, /不可解析/)
  assert.equal(assessment.stats().fallbacks, 1)
})

test('模型抛错 → 回退 accept（不丢活）', async () => {
  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({}), log: () => {}, redact: (x) => x,
    deps: { call: async () => { throw new Error('llm down') } },
  })
  const out = await assessment.assess(ticket)
  assert.equal(out.verdict, 'accept')
  assert.match(out.error, /llm down/)
})

const ws = [{ id: 'w-a', path: 'C:/repo-a' }, { id: 'w-b', path: 'C:/repo-b' }]

test('QQ 研判选中候选工作区', async () => {
  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({}), log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => ws,
      call: async () => '{"verdict":"accept","reason":"要改 repo-b","workspace":"w-b"}',
    },
  })
  const out = await assessment.assess(ticket)
  assert.equal(out.verdict, 'accept')
  assert.equal(out.workspace.id, 'w-b')
  assert.equal(assessment.stats().workspacePicked, 1)
})

test('QQ 研判给出清单外工作区 → 丢弃并计数', async () => {
  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({}), log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => ws,
      call: async () => '{"verdict":"accept","workspace":"D:/hallucinated"}',
    },
  })
  const out = await assessment.assess(ticket)
  assert.equal(out.verdict, 'accept')
  assert.equal(out.workspace, undefined)
  assert.equal(assessment.stats().workspaceDropped, 1)
})

test('候选清单为空时不选工作区（只判真活）', async () => {
  const assessment = createAssessment({
    ctx: {}, config: normalizeConfig({}), log: () => {}, redact: (x) => x,
    deps: { listWorkspaces: () => [], call: async () => '{"verdict":"accept","workspace":"w-a"}' },
  })
  const out = await assessment.assess(ticket)
  assert.equal(out.workspace, undefined)
})
