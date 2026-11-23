/**
 * 源契约：GitHub / 飞书 / QQ 共用。
 * 每个源实现 kind、capabilities、poll(since) -> { triggers, since }、send(thread,text)、ack(ticket)。
 * poll 必须把各家原始数据规范化成 Trigger：{ id, thread, actor, title, body, url, at, kind }。
 */

export class SourceError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message)
    this.name = 'SourceError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export class CapabilityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CapabilityError'
  }
}

const REQUIRED_TRIGGER_FIELDS = ['id', 'thread', 'actor', 'title', 'at', 'kind']

export function normalizeTrigger(raw, sourceKind) {
  for (const field of REQUIRED_TRIGGER_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === '') {
      throw new SourceError(`${sourceKind} 源返回的 Trigger 缺少 ${field}`)
    }
  }
  const at = new Date(raw.at)
  if (Number.isNaN(at.getTime())) throw new SourceError(`${sourceKind} 源返回的 Trigger.at 非法：${raw.at}`)
  return {
    id: String(raw.id),
    thread: String(raw.thread),
    actor: String(raw.actor),
    title: String(raw.title).slice(0, 300),
    body: String(raw.body ?? '').slice(0, 20_000),
    url: String(raw.url ?? ''),
    at: at.toISOString(),
    kind: String(raw.kind),
  }
}

export function assertSource(source, expectedKind) {
  if (!source || typeof source !== 'object') throw new Error('源实现必须是对象')
  if (expectedKind && source.kind !== expectedKind) throw new Error(`源 kind 不匹配：期望 ${expectedKind}，实际 ${source.kind}`)
  for (const method of ['poll']) {
    if (typeof source[method] !== 'function') throw new Error(`源 ${source.kind} 缺少 ${method}()`)
  }
  const caps = source.capabilities ?? {}
  return {
    kind: source.kind,
    capabilities: {
      write: caps.write === true,
      comments: caps.comments === true,
      threads: caps.threads === true,
    },
    poll: source.poll.bind(source),
    send: typeof source.send === 'function' ? source.send.bind(source) : null,
    ack: typeof source.ack === 'function' ? source.ack.bind(source) : null,
  }
}

/** 一致性套件的断言辅助：任何源实现都要能通过这组最小检查。 */
export function contractCheck(source, { since = null } = {}) {
  const problems = []
  const caps = source.capabilities ?? {}
  if (typeof source.kind !== 'string' || !source.kind) problems.push('kind 必须是非空字符串')
  if (typeof source.poll !== 'function') problems.push('poll 必须是函数')
  if (caps.write === true && typeof source.send !== 'function') problems.push('capabilities.write=true 时必须实现 send()')
  if (caps.comments === true && typeof source.send !== 'function') problems.push('capabilities.comments=true 时必须实现 send()')
  if (typeof source.ack !== 'function') problems.push('ack 必须是函数（无能力时内部静默跳过）')
  if (since !== null) problems.push('since 由调用方传入，源不得自己保存水位')
  return problems
}
