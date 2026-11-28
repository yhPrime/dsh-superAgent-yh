/** Normalizes OneBot v11 events and roost-host frames into Triggers; filters nothing the Policy decides. */
import { key } from '../core/ids.ts'
import type { Trigger } from '../core/model.ts'

export const SOURCE = 'qq'
/** The conversation a QQ trigger belongs to: a group, or a direct conversation. */
export type QqChatKind = 'group' | 'private'

type Json = Record<string, unknown>
const record = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
const cqCode = /\[CQ:[^\]]+\]/g
const NOT_TEXT = '[non-text message]'

/** The native conversation id used as a Thread id; group and private conversations never share one. */
export const qqThread = (chatKind: QqChatKind, chatId: string): string => `${chatKind}:${chatId}`
/** The address a reply goes back to; `providerKind` keeps roost-host's group/c2c/guild/dm spelling. */
export const qqAddress = (chatKind: QqChatKind, chatId: string, providerKind: string, messageId: string): Record<string, string> =>
  ({ chatKind, chatId, providerKind, messageId })

const timestamp = (value: unknown, scale: number): string => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric * scale).toISOString()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

/** Reads OneBot's message array (preferred) or strips CQ codes from `raw_message`. */
export function oneBotText(raw: unknown, message: unknown): string {
  const segments = Array.isArray(message) ? message.map(record) : []
  if (segments.length) {
    const parts = segments.flatMap(segment => {
      const data = record(segment.data)
      switch (segment.type) {
        case 'text': return [text(data.text)]
        case 'at': return [`@${text(data.qq)}`]
        case 'image': return ['[image]']
        case 'face': return ['[face]']
        case 'reply': return []
        default: return [`[${text(segment.type) || 'segment'}]`]
      }
    }).join('').trim()
    return parts || NOT_TEXT
  }
  return text(raw).replace(cqCode, '').trim() || NOT_TEXT
}

const mentionedInOneBot = (message: unknown, selfId: string): boolean => {
  if (!selfId || !Array.isArray(message)) return false
  return message.some(segment => {
    const item = record(segment)
    return item.type === 'at' && text(record(item.data).qq) === selfId
  })
}

/** A OneBot v11 `message` event becomes a Trigger; everything else (heartbeats, notices) is ignored. */
export function personalTrigger(event: Json, options: { selfId?: string; now?: string } = {}): Trigger | undefined {
  if (event.post_type !== 'message') return undefined
  const chatKind: QqChatKind | undefined = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined
  if (!chatKind) return undefined
  const selfId = text(options.selfId)
  const sender = record(event.sender)
  const senderId = text(event.user_id) || text(sender.user_id)
  if (!senderId || (selfId && senderId === selfId)) return undefined
  const chatId = chatKind === 'group' ? text(event.group_id) : senderId
  if (!chatId) return undefined
  const messageId = text(event.message_id) || `${senderId}-${text(event.time)}`
  const mentioned = chatKind === 'group' && mentionedInOneBot(event.message, selfId)
  const direct = chatKind === 'private'
  const thread = qqThread(chatKind, chatId)
  const senderName = text(sender.card) || text(sender.nickname) || undefined
  return {
    id: key('qq', chatKind, chatId, messageId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: senderId },
    human: true,
    ...direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {},
    at: timestamp(event.time, 1000),
    text: oneBotText(event.raw_message, event.message),
    channel: { source: SOURCE, thread, address: qqAddress(chatKind, chatId, chatKind, messageId) },
    meta: { chatKind, chatId, messageId, mentioned, direct, ...senderName ? { senderName } : {} },
  }
}

const KINDS = new Set(['group', 'c2c', 'guild', 'dm'])

/** A roost-host message frame becomes a Trigger; other frames (capabilities, gap) are the loop's concern. */
export function officialTrigger(frame: Json): Trigger | undefined {
  if (frame.type !== 'message') return undefined
  const data = record(frame.data)
  const chat = record(data.chat)
  const providerKind = text(chat.kind)
  if (!KINDS.has(providerKind)) return undefined
  const chatKind: QqChatKind = providerKind === 'group' || providerKind === 'guild' ? 'group' : 'private'
  const chatId = text(chat.chatId) || text(chat.groupId)
  const sender = record(data.sender)
  const actor = text(sender.openid) || text(data.identityId) || text(sender.uin)
  if (!chatId || !actor) return undefined
  const body = text(data.content).trim()
  if (!body) return undefined
  const messageId = text(data.eventId) || text(data.msgId) || (frame.seq === undefined ? '' : `seq-${text(frame.seq)}`)
  if (!messageId) return undefined
  const mentioned = data.addressed === true || data.mentioned === true
  const direct = chatKind === 'private'
  const thread = `chat:${providerKind}:${chatId}`
  const human = sender.bot !== true && sender.isBot !== true && data.bot !== true
  const senderName = text(sender.name) || text(sender.nickname) || undefined
  return {
    id: key('qq', 'official', providerKind, chatId, messageId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: actor },
    human,
    ...direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {},
    at: timestamp(data.at ?? frame.at, 1),
    text: body,
    channel: { source: SOURCE, thread, address: qqAddress(chatKind, chatId, providerKind, messageId) },
    meta: { chatKind, chatId, messageId, providerKind, mentioned, direct, ...senderName ? { senderName } : {} },
  }
}
