/**
 * 工单状态机：queued → running → waiting | done | failed。
 * 只在这里改工单字段，其它模块通过函数操作，保证迁移可审计。
 */
export const TICKET_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
})

const ALLOWED = {
  queued: ['running', 'failed'],
  running: ['waiting', 'done', 'failed'],
  waiting: ['running', 'failed', 'done'],
  done: [],
  failed: ['queued'],
}

export function ticketIdOf(sourceKind, trigger) {
  return `${sourceKind}:${trigger.id}`
}

export function safeSessionId(ticketId) {
  const safe = ticketId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return `worker-${safe}`.slice(0, 64)
}

export function createTicket(trigger, { source, now = Date.now() } = {}) {
  return {
    id: ticketIdOf(source, trigger),
    source,
    kind: trigger.kind,
    thread: trigger.thread,
    actor: trigger.actor,
    title: trigger.title,
    body: trigger.body,
    url: trigger.url,
    at: trigger.at,
    status: TICKET_STATUS.QUEUED,
    createdAt: now,
    updatedAt: now,
    sessionId: null,
    workdir: null,
    branch: null,
    attempts: 0,
    lastError: null,
    report: null,
    relayed: {},
  }
}

export function canTransition(from, to) {
  return (ALLOWED[from] ?? []).includes(to)
}

export function transition(ticket, to, patch = {}, now = Date.now()) {
  if (!canTransition(ticket.status, to)) {
    throw new Error(`工单 ${ticket.id} 非法状态迁移 ${ticket.status} → ${to}`)
  }
  ticket.status = to
  ticket.updatedAt = now
  Object.assign(ticket, patch)
  return ticket
}

export function markQueued(ticket, now = Date.now()) {
  return transition(ticket, TICKET_STATUS.QUEUED, { lastError: null }, now)
}

export function markRunning(ticket, patch, now = Date.now()) {
  ticket.attempts += 1
  return transition(ticket, TICKET_STATUS.RUNNING, patch, now)
}

export function markWaiting(ticket, report, now = Date.now()) {
  return transition(ticket, TICKET_STATUS.WAITING, { report }, now)
}

export function markDone(ticket, report, now = Date.now()) {
  return transition(ticket, TICKET_STATUS.DONE, { report }, now)
}

export function markFailed(ticket, error, now = Date.now()) {
  const message = error && error.message ? error.message : String(error)
  return transition(ticket, TICKET_STATUS.FAILED, { lastError: message, report: null }, now)
}

export function ticketStats(tickets) {
  const stats = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0 }
  for (const ticket of Object.values(tickets)) {
    if (stats[ticket.status] !== undefined) stats[ticket.status] += 1
  }
  return stats
}

/** 最近 1 小时创建的工单数（每小时唤醒上限用）。 */
export function hourlyCount(tickets, now = Date.now()) {
  const cutoff = now - 3_600_000
  return Object.values(tickets).filter((ticket) => ticket.createdAt >= cutoff).length
}

/** 同一 source+thread 在冷却窗口内已有工单时返回那张工单，否则 null。 */
export function threadCoolingDown(tickets, source, thread, cooldownMs, now = Date.now()) {
  if (!cooldownMs || cooldownMs <= 0) return null
  let latest = null
  for (const ticket of Object.values(tickets)) {
    if (ticket.source !== source || ticket.thread !== thread) continue
    if (!latest || ticket.createdAt > latest.createdAt) latest = ticket
  }
  if (!latest) return null
  return latest.createdAt + cooldownMs > now ? latest : null
}

export const TERMINAL_STATUSES = Object.freeze([TICKET_STATUS.DONE, TICKET_STATUS.FAILED])
export const TICKET_PRUNE_KEEP_TERMINAL = 20

export function isTerminal(ticket) {
  return TERMINAL_STATUSES.includes(ticket?.status)
}

/** 「已 relay 的终态」= 终态，且 done/failed 至少有一条 relay 记账。 */
export function isRelayedTerminal(ticket) {
  if (!isTerminal(ticket)) return false
  return Boolean(ticket.relayed?.done || ticket.relayed?.failed)
}

const numOr = (value, fallback) => (Number.isFinite(value) ? value : fallback)
const ticketTime = (ticket) => numOr(ticket?.updatedAt, numOr(ticket?.createdAt, 0))

/**
 * 服务端工单裁剪（v2.11 R3/D34）：只裁「已终态且已 relay」的旧工单，保留最近 keepTerminal 条；
 * 未终态与「终态但还没 relay」的一律保留（未回写就删会丢结果）。必须在终态 relay 成功之后调用。
 * 直接改写 state.tickets；返回 { removed, kept }，调用方负责 store.save()。
 */
export function pruneTickets(state, { keepTerminal = TICKET_PRUNE_KEEP_TERMINAL } = {}) {
  const tickets = state?.tickets
  if (!tickets) return { removed: 0, kept: 0 }
  const relayedTerminal = Object.values(tickets).filter(isRelayedTerminal)
  if (relayedTerminal.length <= keepTerminal) return { removed: 0, kept: relayedTerminal.length }
  const keepIds = new Set(
    relayedTerminal
      .slice()
      .sort((a, b) => ticketTime(b) - ticketTime(a))
      .slice(0, keepTerminal)
      .map((ticket) => ticket.id),
  )
  let removed = 0
  for (const ticket of relayedTerminal) {
    if (keepIds.has(ticket.id)) continue
    delete tickets[ticket.id]
    removed += 1
  }
  return { removed, kept: keepIds.size }
}
