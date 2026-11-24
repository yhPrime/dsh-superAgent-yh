import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickWorkspace, pickSession, createTargetResolver } from '../../lib/target.js'

const workspaces = [
  { id: 'w-a', path: 'C:/repo-a' },
  { id: 'w-b', path: 'C:/repo-b' },
]

test('pickWorkspace：确定性线索 > 研判 > 默认', () => {
  assert.equal(pickWorkspace({ ticket: { workspaceHint: 'C:/repo-a' }, assessment: { workspace: { id: 'w-b' } }, workspaces }).workspace.id, 'w-a')
  assert.equal(pickWorkspace({ ticket: {}, assessment: { workspace: { id: 'w-b' } }, workspaces }).workspace.id, 'w-b')
  assert.equal(pickWorkspace({ ticket: {}, workspaces, defaultWorkspaceId: 'w-a' }).via, 'default')
  assert.equal(pickWorkspace({ ticket: {}, workspaces }).via, 'none')
})

test('pickWorkspace：清单外路径成合成工作区（无 id），清单外 id 丢弃', () => {
  const synth = pickWorkspace({ ticket: { workspaceHint: 'D:/unregistered' }, workspaces })
  assert.equal(synth.via, 'hint')
  assert.equal(synth.workspace.synthetic, true)
  assert.equal(synth.workspace.id, null)
  assert.equal(pickWorkspace({ ticket: { workspaceHint: 'w-unknown' }, workspaces }).via, 'none')
})

test('pickSession：只认已登记的单会话', () => {
  assert.equal(pickSession(workspaces[0], 's-1').sessionId, 's-1')
  assert.equal(pickSession(workspaces[0], null), null)
  assert.equal(pickSession({ path: 'C:/x' }, 's-1'), null)
})

function harness({ registered = { 'w-a': 's-1' } } = {}) {
  const resolver = createTargetResolver({
    ctx: {}, config: { singleSession: { sessionIdPrefix: 'intake' } }, log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => workspaces,
      registeredSession: async (workspaceId) => registered[workspaceId] ?? null,
    },
  })
  return resolver
}

test('resolve：工作区已登记单会话 → 返回它', async () => {
  const out = await harness().resolve({ workspaceHint: 'C:/repo-a' }, null)
  assert.equal(out.sessionId, 's-1')
  assert.equal(out.workspace.id, 'w-a')
})

test('resolve：没有登记的单会话 → 明确报错，不自动建', async () => {
  const out = await harness({ registered: {} }).resolve({ workspaceHint: 'C:/repo-a' }, null)
  assert.equal(out.sessionId, null)
  assert.match(out.error, /没有登记单会话/)
})

test('resolve：未注册成工作区的目录 → 提示先建工作区', async () => {
  const out = await harness().resolve({ workspaceHint: 'D:/not-a-workspace' }, null)
  assert.equal(out.sessionId, null)
  assert.match(out.error, /还不是 DSH 工作区/)
})

test('resolve：找不到工作区', async () => {
  const out = await harness().resolve({}, null)
  assert.equal(out.sessionId, null)
  assert.match(out.error, /找不到工单对应的工作区/)
})
