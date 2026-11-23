/**
 * QQ 个人号源（OneBot v11）：WS 收事件进队列，poll 时 drain；HTTP 发消息。
 * 网关：SnowLuma / NapCat / LLOneBot / Lagrange 均可；端点可手填，也可只读 SnowLuma 本地配置。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SourceError, normalizeTrigger } from '../contract.js'
import { createOneBotClient } from './onebot-client.js'

const QUEUE_LIMIT = 1000
const SEEN_LIMIT = 2000

const str = (value) => (value === undefined || value === null ? '' : String(value))

const cleanText = (text) => String(text ?? '').replace(/\[CQ:[^\]]+\]/g, '').trim()

/** 只读 SnowLuma 的 OneBot 配置（不写、不碰登录态）。 */
export function readSnowLumaEndpoint(dir, uin = '') {
  if (!dir) return {}
  const read = (name) => {
    const file = join(dir, 'config', name)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const global = read('onebot.json')
  const per = uin ? read(`onebot_${uin}.json`) : null
  const networks = []
  for (const cfg of [global, per]) {
    if (!cfg) continue
    networks.push(cfg)
  }
  let http = null
  let ws = null
  for (const cfg of networks) {
    const nets = cfg.network || cfg.networks || cfg
    const h = (nets.httpServers || []).find((x) => x && x.enable !== false) || (nets.httpServers || [])[0]
    const w = (nets.wsServers || []).find((x) => x && x.enable !== false) || (nets.wsServers || [])[0]
    if (h && !http) http = h
    if (w && !ws) ws = w
  }
  const host = (value) => (['0.0.0.0', '::', ''].includes(str(value)) ? '127.0.0.1' : str(value) || '127.0.0.1')
  return {
    httpUrl: http ? `http://${host(http.host)}:${http.port}${http.path && http.path !== '/' ? http.path : ''}` : '',
    httpToken: http?.accessToken || '',
    wsUrl: ws ? `ws://${host(ws.host)}:${ws.port}${ws.path && ws.path !== '/' ? ws.path : ''}` : '',
    wsToken: ws?.accessToken || '',
  }
}

/** 把一条 OneBot message 事件规范化为 Trigger；不匹配返回 null。 */
export function normalizePersonalEvent(event, cfg) {
  if (!event || event.post_type !== 'message') return null
  if (event.message_type !== 'group' && event.message_type !== 'private') return null
  const userId = str(event.user_id ?? event.sender?.user_id)
  if (!userId) return null
  if (cfg.personal.selfId && userId === cfg.personal.selfId) return null
  if (cfg.authors.length > 0 && !cfg.authors.includes(userId)) return null

  let thread
  let titleSource
  if (event.message_type === 'group') {
    const groupId = str(event.group_id)
    if (!groupId) return null
    if (cfg.allowedGroups.length > 0 && !cfg.allowedGroups.includes(groupId)) return null
    if (cfg.requireAt) {
      const mentioned = Array.isArray(event.message)
        && event.message.some((segment) => segment?.type === 'at' && str(segment.data?.qq) === cfg.personal.selfId)
      if (!mentioned) return null
    }
    thread = `group:${groupId}`
    titleSource = cleanText(event.raw_message)
  } else {
    thread = `private:${userId}`
    titleSource = cleanText(event.raw_message)
  }
  const time = Number(event.time)
  const at = Number.isFinite(time) && time > 0 ? new Date(time * 1000).toISOString() : new Date().toISOString()
  const body = cleanText(event.raw_message) || '[非文本消息]'
  return normalizeTrigger({
    id: `msg-${str(event.message_id) || `${userId}-${time}`}`,
    thread,
    actor: userId,
    title: titleSource.split('\n')[0].slice(0, 120) || '[QQ 消息]',
    body,
    url: '',
    at,
    kind: 'message',
  }, 'qq')
}

export function createPersonalQqSource(cfg, { log, clientFactory = createOneBotClient } = {}) {
  const queue = []
  const seen = new Set()
  let dropped = 0
  let connection = 'starting'

  const snow = readSnowLumaEndpoint(cfg.personal.snowLumaDir, cfg.personal.selfId)
  const endpoint = () => ({
    httpUrl: cfg.personal.httpUrl || snow.httpUrl || '',
    httpToken: cfg.personal.httpToken || snow.httpToken || '',
    wsUrl: cfg.personal.wsUrl || snow.wsUrl || '',
    wsToken: cfg.personal.wsToken || snow.wsToken || '',
  })

  function remember(id) {
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > SEEN_LIMIT) {
      const first = seen.values().next().value
      seen.delete(first)
    }
    return true
  }

  const client = clientFactory({
    endpoint,
    onEvent: (event) => {
      const id = str(event?.message_id) || `${event?.user_id}-${event?.time}`
      if (!remember(id)) return
      queue.push(event)
      if (queue.length > QUEUE_LIMIT) {
        queue.shift()
        dropped += 1
      }
    },
    onState: (state, detail) => {
      connection = detail ? `${state}: ${detail}` : state
      log?.(`qq personal ${connection}`)
    },
    log: {
      info: (message) => log?.(String(message)),
      warn: (message) => log?.(`warn: ${message}`),
      debug: () => {},
    },
  })
  client.start()

  return {
    kind: 'qq',
    mode: 'personal',
    capabilities: { write: true, comments: false, threads: true },
    async poll(since = null) {
      const sinceMs = since ? new Date(since).getTime() : 0
      const batch = queue.splice(0, queue.length)
      const triggers = []
      let watermark = since
      for (const event of batch) {
        const trigger = normalizePersonalEvent(event, cfg)
        if (!trigger) continue
        if (sinceMs && new Date(trigger.at).getTime() <= sinceMs) continue
        triggers.push(trigger)
        if (!watermark || new Date(trigger.at) > new Date(watermark)) watermark = trigger.at
      }
      if (dropped > 0) {
        log?.(`qq personal 队列溢出，丢弃 ${dropped} 条最旧事件`)
        dropped = 0
      }
      return { triggers, since: watermark }
    },
    async send(thread, text) {
      if (!cfg.confirmWrites) throw new SourceError('QQ 回写未开启（sources.qq.confirmWrites=false）')
      const [kind, ...rest] = String(thread).split(':')
      const id = rest.join(':')
      if (kind === 'group') await client.call('send_group_msg', { group_id: Number(id), message: String(text) })
      else if (kind === 'private') await client.call('send_private_msg', { user_id: Number(id), message: String(text) })
      else throw new SourceError(`未知 QQ 会话：${thread}`)
    },
    async ack() {
      return { skipped: true, reason: 'OneBot 消息没有 ack 语义（水位去重）' }
    },
    get state() {
      return { connection, queue: queue.length }
    },
    dispose() {
      client.stop()
    },
  }
}
