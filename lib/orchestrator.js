/**
 * orchestrator（调度者）：决定一条工单怎么派。
 * v2.9 / D28 选项 2：路由由插件用 `ctx.llm` 一次性调用判定，不再往单会话里投 routePrompt。
 * 超时/无模型/格式错回退规则（route='rules'），并记 lastError，不静默。
 * 只做路由，不写代码、不给实现计划——和原版 dispatch 约束一致。
 */

import { callHostModel, withTimeout } from './host-model.js'

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

/** 兼容旧调用：从会话 wait 结果里取最后一条 assistant 文本（v2.9 不再用于路由）。 */
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
  const llmOf = deps.llm ?? (() => ctx?.llm)
  const selectionOf = deps.defaultModel ?? (() => ctx?.agentDefaultModel?.currentSelection?.() ?? {})
  const call = deps.call ?? ((prompt, signal) => callHostModel({
    llm: llmOf(), selection: selectionOf(), config, system: SYSTEM, prompt, signal,
  }))
  const counters = { routed: 0, agent: 0, rules: 0, fallbacks: 0 }
  const controller = deps.controller ?? new AbortController()

  function openTicketsOf(thread) {
    return Object.values(store.state.tickets ?? {})
      .filter((item) => item.thread === thread && (item.status === 'running' || item.status === 'waiting'))
  }

  function rulesDecision(reason) {
    return { verdict: 'accept', preset: config.workerPreset, reason, mode: 'rules' }
  }

  async function route(ticket) {
    counters.routed += 1
    const mode = routeModeOf(config)
    if (mode === 'rules') {
      counters.rules += 1
      return rulesDecision('rules')
    }
    const timer = withTimeout(controller.signal, config?.orchestratorTimeoutMs || DEFAULT_TIMEOUT_MS)
    try {
      counters.agent += 1
      const text = await call(routePrompt(ticket, openTicketsOf(ticket.thread)), timer.signal)
      const parsed = parseRoute(text)
      if (!parsed) throw new Error(`orchestrator 判定不可解析：${String(text).slice(0, 120)}`)
      log?.(ticket.id, `route ${parsed.verdict}: ${parsed.reason}`)
      return { ...parsed, preset: parsed.preset || config.workerPreset, mode: 'agent' }
    } catch (error) {
      counters.fallbacks += 1
      const message = redact?.(error?.message ?? String(error)) ?? String(error)
      log?.(ticket.id, `orchestrator fallback rules: ${message}`)
      store.state.lastError = `orchestrator: ${message}`
      return { ...rulesDecision('fallback'), error: message }
    } finally {
      timer.done()
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
