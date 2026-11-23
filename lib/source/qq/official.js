/**
 * QQ 官方机器人源（roost-host/1）：从 qq-bot-roost 的事件流收消息，用 msg.send 回写。
 * 不抄 AGPL 代码，只按公开协议实现客户端；能力不足就 fail-closed。
 */
import { SourceError, normalizeTrigger } from '../contract.js'
import { createRoostHostClient } from './roost-host.js'

const QUEUE_LIMIT = 1000
const KINDS = new Set(['group', 'c2c', 'guild', 'dm'])

const str = (value) => (value === undefined || value === null ? '' : String(value))

export function normalizeOfficialFrame(frame, cfg) {
  if (!frame || frame.type !== 'message') return null
  const data = frame.data ?? {}
  const chat = data.chat ?? {}
  const kind = str(chat.kind)
  if (!KINDS.has(kind)) return null
  const chatId = str(chat.chatId ?? chat.groupId)
  if (!chatId) return null
  const sender = data.sender ?? {}
  const actor = str(sender.openid ?? sender.identityId ?? sender.uin)
  if (!actor) return null
  if (cfg.authors.length > 0 && !cfg.authors.includes(actor) && !cfg.authors.includes(str(sender.uin))) return null
  if (cfg.allowedGroups.length > 0) {
    const allowed = [str(chat.chatId), str(chat.groupId), str(chat.groupUin)]
    if (!cfg.allowedGroups.some((id) => allowed.includes(id))) return null
  }
  if ((kind === 'group' || kind === 'guild') && cfg.requireAt) {
    if (data.addressed !== true && data.mentioned !== true) return null
  }
  const content = str(data.content).trim()
  if (!content) return null
  const atMs = Number(data.at ?? frame.at)
  const at = Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : new Date().toISOString()
  const title = content.split('\n')[0].slice(0, 120) || '[QQ 消息]'
  return normalizeTrigger({
    id: `msg-${str(data.eventId) || str(data.msgId) || `seq-${str(frame.seq)}`}`,
    thread: `chat:${kind}:${chatId}`,
    actor,
    title,
    body: content.slice(0, 20_000),
    url: '',
    at,
    kind: 'message',
  }, 'qq')
}

export function createOfficialQqSource(cfg, { log, clientFactory = createRoostHostClient } = {}) {
  const queue = []
  let dropped = 0
  let connection = 'starting'
  let capabilities = null
  let capabilityError = null

  const client = clientFactory({
    baseUrl: `http://${cfg.official.host}:${cfg.official.port}`,
    token: cfg.official.token,
    onEvent: (frame) => {
      if (frame?.type === 'gap') {
        capabilityError = 'roost-host 事件缓冲出现 gap，可能丢了消息'
        log?.(capabilityError)
        return
      }
      if (frame?.type !== 'message') return
      queue.push(frame)
      if (queue.length > QUEUE_LIMIT) {
        queue.shift()
        dropped += 1
      }
    },
    onState: (state, detail) => {
      connection = detail ? `${state}: ${detail}` : state
      log?.(`qq official ${connection}`)
    },
    log: (message) => log?.(String(message)),
  })
  client.start()

  async function ensureCapabilities() {
    if (capabilities) return capabilities
    if (capabilityError) throw new SourceError(`roost-host 不可用：${capabilityError}`)
    try {
      const result = await client.call('system.capabilities', {})
      const text = JSON.stringify(result)
      if (!text.includes('msg.send')) {
        throw new SourceError('roost-host 不支持 msg.send（message scope 或版本不满足）')
      }
      capabilities = result
      return result
    } catch (error) {
      capabilityError = error.message
      throw error
    }
  }

  return {
    kind: 'qq',
    mode: 'official',
    capabilities: { write: true, comments: false, threads: true },
    async poll(since = null) {
      await ensureCapabilities()
      const sinceMs = since ? new Date(since).getTime() : 0
      const batch = queue.splice(0, queue.length)
      const triggers = []
      let watermark = since
      for (const frame of batch) {
        const trigger = normalizeOfficialFrame(frame, cfg)
        if (!trigger) continue
        if (sinceMs && new Date(trigger.at).getTime() <= sinceMs) continue
        triggers.push(trigger)
        if (!watermark || new Date(trigger.at) > new Date(watermark)) watermark = trigger.at
      }
      if (dropped > 0) {
        log?.(`qq official 队列溢出，丢弃 ${dropped} 条最旧事件`)
        dropped = 0
      }
      return { triggers, since: watermark }
    },
    async send(thread, text, options = {}) {
      if (!cfg.confirmWrites) throw new SourceError('QQ 回写未开启（sources.qq.confirmWrites=false）')
      const parts = String(thread).split(':')
      if (parts[0] !== 'chat' || !KINDS.has(parts[1]) || !parts[2]) throw new SourceError(`未知 QQ 会话：${thread}`)
      const kind = parts[1]
      const chatId = parts.slice(2).join(':')
      const params = { kind, chatId, content: String(text) }
      if (options.msgId) params.msgId = options.msgId
      if (options.eventId) params.eventId = options.eventId
      if (Number.isFinite(options.receivedAt)) params.receivedAt = options.receivedAt
      if (options.requestId) params.requestId = options.requestId
      return client.call('msg.send', params)
    },
    async ack() {
      return { skipped: true, reason: 'roost-host 消息没有 ack 语义（水位去重）' }
    },
    get state() {
      return { connection, queue: queue.length }
    },
    dispose() {
      client.stop()
    },
  }
}
