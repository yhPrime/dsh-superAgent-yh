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
