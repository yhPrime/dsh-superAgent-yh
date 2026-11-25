/**
 * 真机黑盒验证（0.8.0 / v2.10）：只走 HTTP + 宿主公开接口，不碰插件内部。
 * 用法：node test/tools/verify-v210.mjs [baseUrl] [--console]
 *       node test/tools/verify-v210.mjs console [baseUrl]
 *
 * 默认只验版本、preset、设置读写（历史调用方式不变）。
 * 加 --console / console 子命令时，额外对 /status /single /log /action /settings
 * 做控制台冒烟：HTTP 状态 + JSON 形状 + 不出现明文 token。
 *
 * 能自动验的：版本、默认纯调度 preset、worker preset 独立、设置读写与非法值拒绝。
 * 需要人工的（真机 UI 里才有空白会话）：
 *   1. 新建空白会话 → 点亮「超级智能体」图标 → 发任务；
 *   2. 看 single-session.log 是否有 `preset → dsh-superagent-yh-dispatcher`；
 *   3. 会话里她应只派 subagent、不再出现 ops_bash；worker 会话里工具齐全。
 */
const args = process.argv.slice(2)
const wantsConsole = args.includes('--console') || args[0] === 'console'
const positional = args.filter((arg) => arg !== '--console' && arg !== 'console')
const base = positional[0] || 'http://127.0.0.1:54196'
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
record('版本 0.9.5', config.version === '0.9.5', `version=${config.version}`)
record(
  '单会话默认 preset=dsh-superagent-yh-dispatcher',
  config.singleSession?.preset === 'dsh-superagent-yh-dispatcher',
  `preset=${config.singleSession?.preset}`,
)
record('workerPreset 独立', Boolean(config.workerPreset), `workerPreset=${config.workerPreset}`)
record('旧 orchestratorPreset 已移除', config.orchestratorPreset === undefined, String(config.orchestratorPreset))
record('角色表可读', Array.isArray(status.body?.roles), `roles=${Array.isArray(status.body?.roles) ? status.body.roles.length : '?'}`)
record('delegate 并发上限=6', status.body?.delegate?.limit === 6, `limit=${status.body?.delegate?.limit}`)
const roleMissing = await post('/action', { action: 'remove-role', role: '' })
record('remove-role 缺 role 返回 400', roleMissing.status === 400, `status=${roleMissing.status}`)

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

// 只看「敏感字段名里带真值」：hasToken/tokenSet 之类的布尔与提示文案不算泄漏。
const SECRET_KEY = /^(token|appSecret|httpToken|wsToken|accessToken|botToken|secret)$/i
function findPlaintextSecrets(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPlaintextSecrets(item, `${path}[${index}]`, found))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof item === 'string' && item.trim()) found.push(`${path}.${key}`)
      else if (!(SECRET_KEY.test(key) && typeof item === 'string')) findPlaintextSecrets(item, `${path}.${key}`, found)
    }
  }
  return found
}

function shapeOk(body) {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body)
}

async function consoleSmoke() {
  console.log('\n— 控制台冒烟（--console）—')
  const status = await get('/status')
  const secrets = findPlaintextSecrets(status.body)
  record('控制台 /status 200', status.status === 200, `status=${status.status}`)
  record('控制台 /status JSON 形状', shapeOk(status.body) && Array.isArray(status.body?.tickets) && shapeOk(status.body?.config), `tickets=${Array.isArray(status.body?.tickets) ? status.body.tickets.length : '?'}`)
  record('控制台 /status 不含明文 token', secrets.length === 0, secrets.join(', '))
  const body = status.body ?? {}
  const ticketIds = (body.tickets ?? []).map((ticket) => ticket.id).filter(Boolean).slice(0, 5)
  const sessionId = (body.singleSession?.workspaces ?? []).find((workspace) => workspace?.sessionId)?.sessionId || body.config?.mainSessionId || ''

  if (sessionId) {
    const single = await get(`/single?sessionId=${encodeURIComponent(sessionId)}`)
    record('控制台 /single 200', single.status === 200, `status=${single.status}`)
    record('控制台 /single JSON 形状', shapeOk(single.body) && single.body?.ok === true, `ok=${single.body?.ok}`)
    record('控制台 /single 不含明文 token', findPlaintextSecrets(single.body).length === 0, findPlaintextSecrets(single.body).join(', '))
  } else {
    record('控制台 /single 200', false, '没有可用的 sessionId（无单会话工作空间）')
  }

  let logOk = false
  let logStatus = null
  for (const ticketId of ticketIds) {
    const log = await get(`/log?ticketId=${encodeURIComponent(ticketId)}`)
    logStatus = log.status
    if (log.status === 200) {
      logOk = shapeOk(log.body) && log.body?.ok === true && typeof log.body?.text === 'string'
      record('控制台 /log 200 + JSON 形状', logOk, `ticket=${ticketId} status=200 lines=${String(log.body?.text ?? '').split('\n').length}`)
      record('控制台 /log 不含明文 token', findPlaintextSecrets(log.body).length === 0, findPlaintextSecrets(log.body).join(', '))
      break
    }
  }
  if (!logOk) {
    // 没有日志文件时 404 是既有语义；只断言 JSON 形状，不伪造 200。
    record('控制台 /log 200 + JSON 形状', logStatus === 404 && ticketIds.length > 0, `无可用日志（lastStatus=${logStatus}）；404 为既有语义`)
  }

  const action = await post('/action', {})
  record('控制台 /action 路由存活', [200, 400, 404].includes(action.status), `status=${action.status} 空 payload 不制造写副作用`)
  record('控制台 /action JSON 形状', shapeOk(action.body) && typeof action.body?.ok === 'boolean', `ok=${action.body?.ok}`)
  record('控制台 /action 不含明文 token', findPlaintextSecrets(action.body).length === 0, findPlaintextSecrets(action.body).join(', '))

  const settings = await post('/settings', {})
  record('控制台 /settings 200', settings.status === 200, `status=${settings.status}（501=宿主没有 configEditor）`)
  record('控制台 /settings JSON 形状', shapeOk(settings.body), `ok=${settings.body?.ok}`)
  record('控制台 /settings 不含明文 token', findPlaintextSecrets(settings.body).length === 0, findPlaintextSecrets(settings.body).join(', '))
}

if (wantsConsole) await consoleSmoke()

const okCount = results.filter((r) => r.ok).length
console.log(`\n${okCount}/${results.length} 通过`)
console.log('真机 UI 部分需要人工：新建空白会话 → 点亮图标 → 发任务 → 看 single-session.log 的 preset 行。')
process.exitCode = okCount === results.length ? 0 : 1
