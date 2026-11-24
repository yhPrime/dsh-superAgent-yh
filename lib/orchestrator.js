/**
 * orchestrator（调度者）：决定一条工单怎么派。
 * 默认由「目标单会话的 agent」判定（route='agent'）；超时/拒答/格式错回退规则（route='rules'）。
 * 只做路由，不写代码、不给实现计划——和原版 dispatch 约束一致。
 */

const ROUTE_VERDICTS = new Set(['accept', 'attach', 'stop', 'ignore'])
const DEFAULT_TIMEOUT_MS = 60_000

const SYSTEM = [
  '你是工单调度器。只决定这条工单怎么处理，不做实现、不评估技术方案。',
  '只输出一行 JSON：',
  '{"verdict":"accept|attach|stop|ignore","reason":"≤40字","preset":"可选","ticketId":"attach 时填"}',
  'accept=新工作；attach=并入已有工单；stop=人要求停止；ignore=无关讨论。',
].join('\n')

export function routeModeOf(config) {
  return config?.orchestrator === 'rules' ? 'rules' : 'agent'
}

export function parseRoute(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    if (!value || !ROUTE_VERDICTS.has(value.verdict)) return null
    return {
      verdict: value.verdict,
      reason: String(value.reason ?? '').slice(0, 120),
      preset: typeof value.preset === 'string' && value.preset.trim() ? value.preset.trim() : undefined,
      ticketId: typeof value.ticketId === 'string' ? value.ticketId : undefined,
    }
  } catch {
    return null
  }
}

function routePrompt(ticket, openTickets) {
  const lines = [
    `新工单：${ticket.id}`,
    `来源：${ticket.source} ${ticket.thread}`,
    `标题：${ticket.title}`,
    `正文：${(ticket.body || '（无正文）').slice(0, 2000)}`,
    `链接：${ticket.url || '（无）'}`,
  ]
  if (openTickets.length > 0) {
    lines.push('', '同线程未结束的工单：')
    for (const item of openTickets.slice(0, 10)) lines.push(`- ${item.id} ${item.status} ${item.title}`)
  }
  lines.push('', '只回一行 JSON。')
  return lines.join('\n')
}

/** 从会话 wait 结果里取最后一条 assistant 文本。 */
export function lastAssistantText(records) {
  let text = ''
  for (const record of records ?? []) {
    const event = record?.event ?? record
    if (event?.type !== 'assistant/message') continue
    const blocks = event.data?.message?.content ?? []
    const joined = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    if (joined.trim()) text = joined
  }
  return text
}

export function createOrchestrator({ ctx, config, store, log, redact, deps = {} }) {
  const promptFn = deps.prompt ?? ((request, signal) => ctx.sessionController.prompt(request, signal))
  const waitFn = deps.wait ?? ((request, signal) => ctx.sessionController.wait(request, signal))
  const counters = { routed: 0, agent: 0, rules: 0, fallbacks: 0 }
  const controller = deps.controller ?? new AbortController()

  function openTicketsOf(thread) {
    return Object.values(store.state.tickets ?? {})
      .filter((item) => item.thread === thread && (item.status === 'running' || item.status === 'waiting'))
  }

  function rulesDecision(reason) {
    return { verdict: 'accept', preset: config.workerPreset, reason, mode: 'rules' }
  }

  async function route(ticket, target) {
    counters.routed += 1
    const mode = routeModeOf(config)
    if (mode === 'rules' || !target?.sessionId || !target?.agent) {
      counters.rules += 1
      return rulesDecision('rules')
    }
    const signal = controller.signal
    const timer = setTimeout(() => controller.abort(new Error('orchestrator timeout')), config?.orchestratorTimeoutMs || DEFAULT_TIMEOUT_MS)
    try {
      counters.agent += 1
      await promptFn({
        requestId: `route:${ticket.id}:${ticket.attempts ?? 0}`,
        sessionId: target.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: routePrompt(ticket, openTicketsOf(ticket.thread)) }],
      }, signal)
      const waited = await waitFn({ sessionId: target.sessionId, timeoutMs: config?.orchestratorTimeoutMs || DEFAULT_TIMEOUT_MS, maxMessages: 20 }, signal)
      const parsed = parseRoute(lastAssistantText(waited?.output?.records))
      if (!parsed) throw new Error('orchestrator 未给出可解析判定')
      log?.(ticket.id, `route ${parsed.verdict}: ${parsed.reason}`)
      return { ...parsed, preset: parsed.preset || config.workerPreset, mode: 'agent' }
    } catch (error) {
      counters.fallbacks += 1
      const message = redact?.(error?.message ?? String(error)) ?? String(error)
      log?.(ticket.id, `orchestrator fallback rules: ${message}`)
      store.state.lastError = `orchestrator: ${message}`
      return { ...rulesDecision('fallback'), error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    route,
    stats: () => ({ ...counters }),
    dispose() {
      controller.abort()
    },
  }
}
