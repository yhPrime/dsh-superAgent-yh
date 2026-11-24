import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickWorkspace, pickSession, createTargetResolver } from '../../lib/target.js'
import { intakeIdOf } from '../../lib/single-session.js'

const workspaces = [
  { id: 'w-a', path: 'C:/repo-a' },
  { id: 'w-b', path: 'C:/repo-b' },
]

test('pickWorkspace：确定性线索优先于研判', () => {
  const out = pickWorkspace({ ticket: { workspaceHint: 'C:/repo-a' }, assessment: { workspace: { id: 'w-b' } }, workspaces })
  assert.equal(out.workspace.id, 'w-a')
  assert.equal(out.via, 'hint')
})

test('pickWorkspace：没有线索用研判给的 workspace', () => {
  const out = pickWorkspace({ ticket: {}, assessment: { workspace: { id: 'w-b' } }, workspaces })
  assert.equal(out.workspace.id, 'w-b')
  assert.equal(out.via, 'assessment')
})

test('pickWorkspace：都没有落默认；默认也没有则 none', () => {
  assert.equal(pickWorkspace({ ticket: {}, workspaces, defaultWorkspaceId: 'w-a' }).via, 'default')
  const none = pickWorkspace({ ticket: {}, workspaces })
  assert.equal(none.via, 'none')
  assert.equal(none.workspace, null)
})

test('pickWorkspace：研判给的清单外 workspace 一律丢弃', () => {
  assert.equal(pickWorkspace({ ticket: {}, assessment: { workspace: { id: 'w-x' } }, workspaces }).via, 'none')
})

test('pickWorkspace：清单外的 hint 若是路径则直接采用（仓库未注册工作区）', () => {
  const out = pickWorkspace({ ticket: { workspaceHint: 'D:/unregistered/repo' }, workspaces })
  assert.equal(out.via, 'hint')
  assert.equal(out.workspace.path, 'D:/unregistered/repo')
  assert.equal(out.workspace.synthetic, true)
  // 非路径形态的 id 不乱当路径
  assert.equal(pickWorkspace({ ticket: { workspaceHint: 'w-unknown' }, workspaces }).via, 'none')
})

test('pickSession：优先 intake id，其次同 cwd 的 intake- 会话', () => {
  const wanted = intakeIdOf('intake', 'C:/repo-a', 'w-a')
  assert.equal(pickSession(workspaces[0], [{ sessionId: wanted, cwd: 'C:/repo-a' }]).sessionId, wanted)
  assert.equal(pickSession(workspaces[0], [{ sessionId: 'intake-x-1', cwd: 'C:\\repo-a' }]).sessionId, 'intake-x-1')
  assert.equal(pickSession(workspaces[0], [{ sessionId: 'session-other', cwd: 'C:/repo-a' }]), null)
})

function harness({ sessions = [], workspaces: ws = workspaces, single = {}, createThrows = false } = {}) {
  const created = []
  const resolver = createTargetResolver({
    ctx: {}, config: { singleSession: { sessionIdPrefix: 'intake', autoCreate: true, ...single } }, log: () => {}, redact: (x) => x,
    deps: {
      listWorkspaces: () => ws,
      listSessions: async () => sessions,
      resolveByPath: async (path) => (ws.find((w) => w.path === path) ?? null),
      createWorkspace: async (path) => { created.push({ registered: path }); return { id: 'w-new', path } },
      createSession: async (request) => {
        if (createThrows) throw new Error('create failed')
        created.push(request)
        return { sessionId: request.sessionId }
      },
    },
  })
  return { resolver, created }
}

test('resolve：找到已有单会话', async () => {
  const id = intakeIdOf('intake', 'C:/repo-a')
  const { resolver } = harness({ sessions: [{ sessionId: id, cwd: 'C:/repo-a' }] })
  const out = await resolver.resolve({ workspaceHint: 'C:/repo-a' }, null)
  assert.equal(out.sessionId, id)
  assert.equal(out.via, 'hint')
})

test('resolve：没有则按 autoCreate 建；关掉则报错', async () => {
  const on = harness()
  const out = await on.resolver.resolve({ workspaceHint: 'C:/repo-a' }, null)
  assert.equal(out.sessionId, intakeIdOf('intake', 'C:/repo-a', 'w-a'))
  assert.equal(on.created.length, 1)

  const off = harness({ single: { autoCreate: false } })
  const out2 = await off.resolver.resolve({ workspaceHint: 'C:/repo-a' }, null)
  assert.equal(out2.sessionId, null)
  assert.match(out2.error, /没有单会话/)
})

test('resolve：建单会话时用 workspaceId 绑定工作区（不是 cwd）', async () => {
  const h = harness()
  await h.resolver.resolve({ workspaceHint: 'C:/repo-a' }, null)
  const request = h.created[0]
  assert.equal(request.sessionId, intakeIdOf('intake', 'C:/repo-a', 'w-a'))
  assert.equal(request.workspaceId, 'w-a')
  assert.equal(request.cwd, undefined)
})

test('pickSession：优先返回属于该 workspace 的会话', () => {
  const list = [
    { sessionId: 'intake-old', cwd: 'C:/repo-a' },
    { sessionId: 'intake-new', cwd: 'C:/repo-a', workspaceId: 'w-a' },
  ]
  assert.equal(pickSession(workspaces[0], list).sessionId, 'intake-new')
})

test('resolve：找不到工作区 / 建会话失败都返回明确错误', async () => {
  const none = harness()
  const out = await none.resolver.resolve({}, null)
  assert.match(out.error, /工作区/)

  const failing = harness({ createThrows: true })
  const out2 = await failing.resolver.resolve({ workspaceHint: 'C:/repo-a' }, null)
  assert.match(out2.error, /建单会话失败/)
})
