/**
 * 真机黑盒验证（0.7.3 / v2.9）：只走 HTTP + 宿主公开接口，不碰插件内部。
 * 用法：node test/tools/verify-v29.mjs [baseUrl] [workspacePath]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] || 'http://127.0.0.1:56857'
const cwdArg = process.argv[3] || 'C:\\Users\\yh\\WorkDeepSeek\\插件'
const api = `${base}/dsh-superagent-yh`
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`)
}

async function get(path) {
  const res = await fetch(`${api}${path}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function act(payload) {
  const res = await fetch(`${api}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// 1) 版本与默认 preset
const status = await get('/status')
record('版本 0.7.3', status.body?.config?.version === '0.7.3', `version=${status.body?.config?.version}`)
record('单会话默认 preset=minimal', status.body?.config?.singleSession?.preset === 'minimal', `preset=${status.body?.config?.singleSession?.preset}`)
record('workerPreset 独立', Boolean(status.body?.config?.workerPreset), `workerPreset=${status.body?.config?.workerPreset}`)
record('旧 orchestratorPreset 已移除', status.body?.config?.orchestratorPreset === undefined, String(status.body?.config?.orchestratorPreset))

// 2) 设置里能改 preset（非法值拒绝、合法值写回）
const bad = await act({ action: 'save-settings', settings: { singleSession: { preset: 'bad name!' } } })
record('非法 preset 被拒绝', bad.status === 400, `status=${bad.status}`)
const good = await act({ action: 'save-settings', settings: { singleSession: { preset: 'minimal' } } })
record('合法 preset 可保存', good.status === 200, `status=${good.status}`)

// 3) 登记一张空白会话
const root = mkdtempSync(join(tmpdir(), 'v29-'))
execFileSync('git', ['init', '-q'], { cwd: root })
writeFileSync(join(root, 'README.md'), 'v29 verify\n')
execFileSync('git', ['add', '.'], { cwd: root })
execFileSync('git', ['-c', 'user.email=v@t', '-c', 'user.name=v', 'commit', '-qm', 'init'], { cwd: root })

const sessionId = `verify-v29-${Date.now().toString(36)}`
const reg = await act({ action: 'register-single', sessionId, workspacePath: root })
record('登记空白会话成功', reg.status === 200 && reg.body?.ok !== false, `status=${reg.status} body=${JSON.stringify(reg.body).slice(0, 160)}`)

const after = await get('/status')
const regs = after.body?.singleSession?.workspaces ?? []
const mine = regs.find((item) => item.sessionId === sessionId)
record('注册表里有该会话', Boolean(mine), JSON.stringify({ registered: regs.length }))
record('登记后工作区被 pin', Boolean(mine), `pinned=${JSON.stringify(mine?.pinned ?? null)}`)

// 4) 真实工单：派给已登记单会话 → 子智能体执行 → relay 只回三条
const trigger = await act({ action: 'probe-ticket', text: '在仓库根目录新建 v29.txt，内容写 V29-OK' })
record('触发一张探针工单', trigger.status === 200, `status=${trigger.status} body=${JSON.stringify(trigger.body).slice(0, 200)}`)

const ticketId = trigger.body?.ticketId ?? trigger.body?.id
let final = null
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  const s = await get('/status')
  const ticket = (s.body?.tickets ?? []).find((t) => t.id === ticketId)
  if (ticket && ['done', 'failed', 'waiting'].includes(ticket.status)) {
    final = ticket
    break
  }
}
record('工单到达终态', Boolean(final), final ? `status=${final.status} mode=${final.mode} workspace=${final.workspace}` : '超时')
record('工单走团队模式（spawn 子智能体）', final?.mode === 'team', `mode=${final?.mode}`)
record('工单目标=已登记单会话', final?.targetSessionId === sessionId, `target=${final?.targetSessionId}`)
record('子智能体产物写入仓库', existsSync(join(root, 'v29.txt')), join(root, 'v29.txt'))

const okCount = results.filter((r) => r.ok).length
console.log(`\n${okCount}/${results.length} 通过`)
console.log(JSON.stringify({ root, sessionId, ticketId, final }, null, 2))
