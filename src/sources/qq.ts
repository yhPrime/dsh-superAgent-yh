/** QQ source kind definition (OneBot v11 and roost-host modes), its Policy part, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sendQq } from './qq-channel.ts'
import { runQq } from './qq-loops.ts'
import { SOURCE, qqThread } from './qq-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

const chatIdPattern = '[0-9A-Za-z_:-]{1,128}'
const senderIdPattern = /^[0-9A-Za-z_:-]{1,128}$/
export const QqConfigSchema = z.object({
  mode: z.enum(['onebot', 'official']).default('onebot'),
  httpUrl: z.string().trim().max(500).default('http://127.0.0.1:3000'),
  wsUrl: z.string().trim().max(500).default('ws://127.0.0.1:3000'),
  httpToken: z.string().max(500).default(''),
  wsToken: z.string().max(500).default(''),
  selfId: z.string().trim().max(64).default(''),
  baseUrl: z.string().trim().max(500).default(''),
  token: z.string().max(500).default(''),
  chats: z.array(z.object({ chatId: z.string().trim().regex(new RegExp(`^${chatIdPattern}$`)), name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type QqConfig = z.infer<typeof QqConfigSchema>

const modeField = { key: 'mode', type: 'select' as const, label: { zh: '接入方式', en: 'Mode' },
  options: [{ value: 'onebot', label: { zh: 'OneBot v11（个人号）', en: 'OneBot v11 (personal account)' } },
    { value: 'official', label: { zh: 'roost-host（官方机器人）', en: 'roost-host (official bot)' } }],
  hint: { zh: 'OneBot v11 连本地网关（如 SnowLuma）；roost-host 连官方宿主协议。切换后重启 dsh-superagent-yh。', en: 'OneBot v11 talks to a local gateway (such as SnowLuma); roost-host talks to the official host protocol. Restart dsh-superagent-yh after switching.' } }

export const qqKind: SourceKind<QqConfig> = {
  kind: SOURCE,
  title: { zh: 'QQ', en: 'QQ' },
  description: { zh: '接收 QQ 群和私聊里的消息，按策略接单并把结果回到原会话。', en: 'Receives messages in QQ groups and direct chats, opens Tickets under the Policy, and replies in the same conversation.' },
  schema: QqConfigSchema,
  fields: [
    modeField,
    { key: 'httpUrl', type: 'text', label: { zh: 'OneBot HTTP 地址', en: 'OneBot HTTP URL' }, hint: { zh: 'OneBot v11 的 HTTP 接口根地址，例如 http://127.0.0.1:3000；发表格走这里。', en: 'The root URL of the OneBot v11 HTTP API, such as http://127.0.0.1:3000; replies go here.' } },
    { key: 'wsUrl', type: 'text', label: { zh: 'OneBot WebSocket 地址', en: 'OneBot WebSocket URL' }, hint: { zh: 'OneBot v11 的 Universal WebSocket 地址，例如 ws://127.0.0.1:3000；消息从这里收。', en: 'The OneBot v11 Universal WebSocket URL, such as ws://127.0.0.1:3000; messages arrive here.' } },
    { key: 'httpToken', type: 'text', label: { zh: 'HTTP access token', en: 'HTTP access token' }, advanced: true },
    { key: 'wsToken', type: 'text', label: { zh: 'WebSocket access token', en: 'WebSocket access token' }, advanced: true },
    { key: 'selfId', type: 'text', label: { zh: '机器人 QQ 号', en: 'Bot QQ id' }, hint: { zh: '用来认出 @ 机器人的消息，也避免把机器人自己的消息当成请求。', en: 'Identifies messages that mention the bot, and keeps the bot\'s own messages from becoming requests.' } },
    { key: 'baseUrl', type: 'text', label: { zh: 'roost-host 地址', en: 'roost-host URL' }, hint: { zh: '官方机器人宿主的根地址；SSE 走 /events，调用走 /rpc。', en: 'The official bot host root; events come from /events and calls go to /rpc.' } },
    { key: 'token', type: 'text', label: { zh: 'roost-host token', en: 'roost-host token' }, advanced: true },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群号', en: 'Group' }, pattern: chatIdPattern },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other groups' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Groups the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
  ],
  health: ['qq'],
  scope({ meta }, config) {
    if (meta.direct === true || meta.chatKind === 'private') return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a conversation the Source still receives.
  channel: {
    allowed: (address, config) => qqKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.chatKind === 'private' } }, config).listened,
    send: (_host, message) => sendQq(message.channel.address, message.text),
    link: (_address, _links) => ({ url: '', label: { zh: 'QQ', en: 'QQ' } as Localized }),
  },
  policy: {
    unnamed: { person: { zh: 'QQ 用户', en: 'QQ user' }, bot: { zh: 'QQ 机器人', en: 'QQ bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(senderIdPattern), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate sender ids').default([]),
      bots: z.array(z.object({ id: z.string().regex(senderIdPattern), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 QQ 用户', en: 'QQ users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'QQ 号或 openid', en: 'QQ id or openid' }, pattern: chatIdPattern }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。', en: 'Messages of a bot on this list become inferred candidates for an assessment; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'QQ 号或 openid', en: 'QQ id or openid' }, pattern: chatIdPattern },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = QqConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_QQ_CHAT', description: { zh: '接下工单的 QQ 会话；工单不是从 QQ 来的时为空', en: 'The QQ conversation that started the ticket; empty when the ticket did not start on QQ' } },
    ],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_QQ_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
}

export const name = 'dsh-superagent-yh-qq'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(qqKind), 'qq: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runQq(sourceContext(ctx.orchestrator, qqKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
export { SOURCE, qqThread }
