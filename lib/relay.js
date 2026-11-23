/**
 * 主线三条短消息：开工 1 条、需要人 1 条（含问题）、完成 1 条（含链接）。
 * 单工单对主线上下文增量目标 ≤ 1K token；同一 kind 只投递一次（ticket.relayed 记账）。
 */
const LIMIT = { title: 80, question: 200, summary: 300, reason: 200 }

const clip = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

export function startText(ticket) {
  return `【superagent】开工 ${ticket.id}｜${clip(ticket.title, LIMIT.title)}｜${ticket.url}`
}

export function needHumanText(ticket) {
  const question = ticket.report?.question || '执行器在等人回复'
  return `【superagent】需要人 ${ticket.id}｜${clip(question, LIMIT.question)}｜${ticket.url}`
}

export function doneText(ticket) {
  const summary = ticket.report?.summary || '已完成'
  const link = ticket.report?.link ? `｜${ticket.report.link}` : ''
  return `【superagent】完成 ${ticket.id}｜${clip(summary, LIMIT.summary)}${link}`
}

export function failedText(ticket) {
  return `【superagent】失败 ${ticket.id}｜${clip(ticket.lastError, LIMIT.reason)}｜${ticket.url}`
}

export function textFor(ticket, kind) {
  if (kind === 'started') return startText(ticket)
  if (kind === 'needHuman') return needHumanText(ticket)
  if (kind === 'done') return doneText(ticket)
  if (kind === 'failed') return failedText(ticket)
  throw new Error(`未知 relay kind: ${kind}`)
}

export function createRelay({ ctx, store, config, redact, log }) {
  const controller = new AbortController()

  async function ensureMainSession() {
    if (!config.mainSessionId) return null
    let result = await ctx.sessionController.resolveAgent(config.mainSessionId)
    if (!('error' in result)) return result.agent
    if (result.error.code !== 'session/not-found') throw new Error(`主线会话不可用：${result.error.code}`)
    await ctx.sessionController.create({ sessionId: config.mainSessionId, cwd: config.repoPath || process.cwd() })
    result = await ctx.sessionController.resolveAgent(config.mainSessionId)
    if ('error' in result) throw new Error(`主线会话创建后仍不可用：${result.error.code}`)
    return result.agent
  }

  return {
    async send(ticket, kind) {
      if (ticket.relayed?.[kind]?.at) return { skipped: true, reason: 'already relayed' }
      const text = redact(textFor(ticket, kind))
      let delivered = false
      if (config.mainSessionId) {
        await ensureMainSession()
        await ctx.sessionController.prompt(
          {
            requestId: `relay:${ticket.id}:${kind}`,
            sessionId: config.mainSessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          controller.signal,
        )
        delivered = true
      }
      ticket.relayed[kind] = { at: Date.now(), text, delivered }
      if (log) log(ticket.id, `relay ${kind}: ${text}`)
      return { delivered, text }
    },
    dispose() {
      controller.abort()
    },
  }
}
