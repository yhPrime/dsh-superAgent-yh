/**
 * 真机黑盒验证（0.8.0 / v2.10）：只走 HTTP + 宿主公开接口，不碰插件内部。
 * 用法：node test/tools/verify-v210.mjs [baseUrl]
 *
 * 能自动验的：版本、默认纯调度 preset、worker preset 独立、设置读写与非法值拒绝。
 * 需要人工的（真机 UI 里才有空白会话）：
 *   1. 新建空白会话 → 点亮「超级智能体」图标 → 发任务；
 *   2. 看 single-session.log 是否有 `preset → dsh-superagent-yh-dispatcher`；
 *   3. 会话里她应只派 subagent、不再出现 ops_bash；worker 会话里工具齐全。
 */
const base = process.argv[2] || 'http://127.0.0.1:54196'
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
async function post(path, payload) {
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-superagent': '1' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const status = await get('/status')
const config = status.body?.config ?? {}
record('状态可读', status.status === 200, `status=${status.status}`)
record('版本 0.8.0', config.version === '0.8.0', `version=${config.version}`)
record(
  '单会话默认 preset=dsh-superagent-yh-dispatcher',
  config.singleSession?.preset === 'dsh-superagent-yh-dispatcher',
  `preset=${config.singleSession?.preset}`,
)
record('workerPreset 独立', Boolean(config.workerPreset), `workerPreset=${config.workerPreset}`)
record('旧 orchestratorPreset 已移除', config.orchestratorPreset === undefined, String(config.orchestratorPreset))

const bad = await post('/settings', { singleSession: { preset: 'bad name!' } })
record('非法 preset 被拒绝', bad.status === 400, `status=${bad.status}`)
const good = await post('/settings', { singleSession: { preset: 'dsh-superagent-yh-dispatcher' } })
record('合法 preset 可保存', good.status === 200, `status=${good.status}`)

const after = await get('/status')
record(
  '保存后仍是纯调度 preset',
  after.body?.config?.singleSession?.preset === 'dsh-superagent-yh-dispatcher',
  `preset=${after.body?.config?.singleSession?.preset}`,
)

const okCount = results.filter((r) => r.ok).length
console.log(`\n${okCount}/${results.length} 通过`)
console.log('真机 UI 部分需要人工：新建空白会话 → 点亮图标 → 发任务 → 看 single-session.log 的 preset 行。')
process.exitCode = okCount === results.length ? 0 : 1
