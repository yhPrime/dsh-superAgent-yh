/**
 * The QQ Source: OneBot and roost-host normalization, the kind's settings/scope/policy, both clients'
 * request semantics, and an end-to-end run against a fake OneBot gateway (HTTP calls and a WebSocket) whose
 * group mention opens a Ticket and whose replies go back to the same group.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { setQqSender, clearQqSender, sendQq, qqAddressFields, type QqSender } from '../src/sources/qq-channel.ts'
import { connectionProblem, retryDelay, runQq } from '../src/sources/qq-loops.ts'
import { createOneBotClient, OneBotError } from '../src/sources/qq-onebot.ts'
import { createRoostHostClient, feedSse, RoostError } from '../src/sources/qq-roost.ts'
import { officialTrigger, oneBotText, personalTrigger, qqThread } from '../src/sources/qq-trigger.ts'
import { QqConfigSchema, qqKind } from '../src/sources/qq.ts'
import { startRuntime } from './fixtures/host.ts'

const SELF = '999'
const GROUP = '10001'
const ALICE = '12345'
const ok = (data: unknown) => new Response(JSON.stringify({ status: 'ok', retcode: 0, data }), { status: 200,
  headers: { 'content-type': 'application/json' } })
const failed = (retcode: number, message: string) => new Response(JSON.stringify({ status: 'failed', retcode, message }), { status: 200,
  headers: { 'content-type': 'application/json' } })

describe('qq trigger normalization', () => {
  const groupEvent = (id = '5001', overrides: Record<string, unknown> = {}) => ({
    post_type: 'message', message_type: 'group', group_id: GROUP, user_id: ALICE, message_id: id, time: 1_700_000_000,
    sender: { card: 'Alice', nickname: 'alice' }, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' fix the title' } }], ...overrides })

  it('turns a group mention into a Trigger addressed to the bot', () => {
    const trigger = personalTrigger(groupEvent(), { selfId: SELF })!
    expect(trigger).toMatchObject({
      id: key('qq', 'group', GROUP, '5001'), source: 'qq', threads: [{ source: 'qq', id: qqThread('group', GROUP) }],
      actor: { source: 'qq', id: ALICE }, human: true, addressed: 'mention', at: '2023-11-14T22:13:20.000Z', text: '@999 fix the title',
      channel: { source: 'qq', thread: 'group:10001', address: { chatKind: 'group', chatId: GROUP, providerKind: 'group', messageId: '5001' } },
      meta: { chatKind: 'group', chatId: GROUP, messageId: '5001', mentioned: true, direct: false, senderName: 'Alice' },
    })
  })
  it('turns a direct message into a direct Trigger and strips CQ codes from raw text', () => {
    const trigger = personalTrigger({ post_type: 'message', message_type: 'private', user_id: ALICE, message_id: 'm1', time: 1_700_000_000,
      raw_message: '[CQ:face,id=1]hi there', sender: { nickname: 'Alice' } }, { selfId: SELF })!
    expect(trigger).toMatchObject({ addressed: 'direct', text: 'hi there', threads: [{ source: 'qq', id: 'private:12345' }],
      channel: { address: { chatKind: 'private', chatId: ALICE, providerKind: 'private', messageId: 'm1' } } })
    expect(personalTrigger({ post_type: 'message', message_type: 'private', user_id: ALICE, message_id: 'm2', time: 1,
      raw_message: '[CQ:image,file=a.png]' }, { selfId: SELF })!.text).toBe('[non-text message]')
  })
  it("drops the bot's own messages, non-message events, and messages without a conversation", () => {
    expect(personalTrigger(groupEvent(undefined, { user_id: SELF }), { selfId: SELF })).toBeUndefined()
    expect(personalTrigger({ post_type: 'notice', notice_type: 'group_increase' }, { selfId: SELF })).toBeUndefined()
    expect(personalTrigger({ post_type: 'message', message_type: 'group', group_id: GROUP, user_id: ALICE, time: 1 }, { selfId: SELF }))
      .toMatchObject({ id: key('qq', 'group', GROUP, ALICE + '-1'), meta: { mentioned: false } })
    expect(oneBotText('plain', undefined)).toBe('plain')
    expect(oneBotText('', [{ type: 'image', data: {} }, { type: 'face', data: {} }])).toBe('[image][face]')
  })
  it('normalizes roost-host frames, keeping its group/c2c/guild spelling in the reply address', () => {
    const frame = { type: 'message', seq: 7, at: 1_700_000_000_000, data: { chat: { kind: 'group', chatId: 'g1' },
      sender: { openid: 'u1', name: 'Alice' }, content: ' fix ', mentioned: true, eventId: 'e1' } }
    expect(officialTrigger(frame)).toMatchObject({ id: key('qq', 'official', 'group', 'g1', 'e1'), addressed: 'mention', human: true,
      text: 'fix', at: '2023-11-14T22:13:20.000Z', threads: [{ source: 'qq', id: 'chat:group:g1' }],
      channel: { address: { chatKind: 'group', chatId: 'g1', providerKind: 'group', messageId: 'e1' } } })
    expect(officialTrigger({ ...frame, data: { ...frame.data, chat: { kind: 'c2c', chatId: 'u2' }, mentioned: false } }))
      .toMatchObject({ addressed: 'direct', meta: { chatKind: 'private', providerKind: 'c2c' }, threads: [{ id: 'chat:c2c:u2' }] })
    expect(officialTrigger({ ...frame, data: { ...frame.data, sender: { openid: 'b1', bot: true } } })).toMatchObject({ human: false })
    expect(officialTrigger({ ...frame, data: { ...frame.data, eventId: undefined, msgId: undefined } })).toMatchObject({ id: key('qq', 'official', 'group', 'g1', 'seq-7') })
    expect(officialTrigger({ ...frame, data: { ...frame.data, content: '   ' } })).toBeUndefined()
    expect(officialTrigger({ type: 'gap', seq: 8 })).toBeUndefined()
    expect(officialTrigger({ ...frame, data: { ...frame.data, chat: { kind: 'unknown', chatId: 'x' } } })).toBeUndefined()
  })
})

describe('qq source kind', () => {
  it('parses its settings with defaults and rejects unknown keys', () => {
    expect(QqConfigSchema.parse({})).toMatchObject({ mode: 'onebot', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3000',
      chats: [], directMessages: true, otherChats: 'none' })
    expect(() => QqConfigSchema.parse({ nope: true })).toThrow()
    expect(() => QqConfigSchema.parse({ chats: [{ chatId: 'g1', listen: 'mentions' }, { chatId: 'g1', listen: 'all' }] })).toThrow('Duplicate chat IDs')
  })
  it('decides which conversations it listens to, what it observes, and whether a reply may go there', () => {
    const config = QqConfigSchema.parse({ chats: [{ chatId: GROUP, name: 'Team', listen: 'all' }], otherChats: 'mentions', directMessages: false })
    expect(qqKind.scope!({ meta: { chatId: GROUP, direct: false } }, config)).toEqual({ listened: true, observed: true, row: GROUP })
    expect(qqKind.scope!({ meta: { chatId: '20002', direct: false } }, config)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(qqKind.scope!({ meta: { direct: true } }, config)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(qqKind.channel!.allowed!({ chatId: '20002', chatKind: 'group' }, config)).toBe(true)
    expect(qqKind.channel!.allowed!({ chatId: ALICE, chatKind: 'private' }, config)).toBe(false)
    // With other chats off, an unlisted group is not a source of work at all.
    const closed = QqConfigSchema.parse({ chats: [], otherChats: 'none' })
    expect(qqKind.scope!({ meta: { chatId: '30003', direct: false } }, closed)).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(qqKind.channel!.allowed!({ chatId: '30003', chatKind: 'group' }, closed)).toBe(false)
  })
  it('shows each conversation row with its admission cells', () => {
    const config = QqConfigSchema.parse({ chats: [{ chatId: GROUP, listen: 'all' }], otherChats: 'mentions', directMessages: true })
    const rows = qqKind.policy!.rows!(config)
    expect(rows.map(row => row.id)).toEqual([GROUP, 'other', 'direct'])
    expect(rows[0]!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
    expect(rows[1]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    expect(rows[2]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    expect(qqKind.health).toEqual(['qq'])
    expect(qqKind.environment!.values({ trigger: { source: 'qq', meta: { chatId: GROUP } } as unknown as Trigger } as never))
      .toEqual({ DSH_SUPERAGENT_QQ_CHAT: GROUP })
    expect(qqKind.environment!.values({ trigger: undefined } as never)).toEqual({ DSH_SUPERAGENT_QQ_CHAT: '' })
  })
  it('keeps a reply until a connection is live, then sends it through that connection', async () => {
    await expect(sendQq({ chatId: GROUP, chatKind: 'group' }, 'hi')).rejects.toThrow('not connected')
    const first: QqSender = { send: vi.fn(async () => {}) }
    const second: QqSender = { send: vi.fn(async () => {}) }
    setQqSender(first)
    setQqSender(second)
    // Retiring the replaced connection leaves the replacement in place.
    clearQqSender(first)
    await expect(sendQq({ chatId: GROUP, chatKind: 'group' }, 'hi')).resolves.toBe('sent')
    expect(second.send).toHaveBeenCalledWith({ chatId: GROUP, chatKind: 'group' }, 'hi')
    clearQqSender(second)
    await expect(sendQq({ chatId: GROUP }, 'hi')).rejects.toThrow('not connected')
    expect(() => qqAddressFields({ chatKind: 'group' })).toThrow('names no chat')
    expect(qqAddressFields({ chatId: GROUP, chatKind: 'private', providerKind: 'c2c' })).toEqual({ chatKind: 'private', chatId: GROUP, providerKind: 'c2c' })
  })
  it('names what keeps a mode from connecting and backs off between attempts', () => {
    expect(connectionProblem(QqConfigSchema.parse({ mode: 'onebot', httpUrl: '', wsUrl: '' }))).toContain('HTTP or WebSocket')
    expect(connectionProblem(QqConfigSchema.parse({ mode: 'onebot' }))).toBeUndefined()
    expect(connectionProblem(QqConfigSchema.parse({ mode: 'official' }))).toContain('base URL and a token')
    expect(connectionProblem(QqConfigSchema.parse({ mode: 'official', baseUrl: 'https://host', token: 't' }))).toBeUndefined()
    expect(retryDelay(undefined, 10)).toBe(1_000)
    expect(retryDelay(1_000, 10)).toBe(2_000)
    expect(retryDelay(40_000, 10)).toBe(60_000)
    expect(retryDelay(5_000, 60_000)).toBe(1_000)
  })
})

describe('onebot client', () => {
  it('posts actions to the HTTP API with its token and returns the data', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return ok({ message_id: 42 })
    }) as unknown as typeof fetch
    const client = createOneBotClient({ endpoint: () => ({ httpUrl: 'http://gw:3000/', httpToken: 'secret' }), onEvent: () => {}, fetchImpl, retryDelays: [] })
    await expect(client.call('send_group_msg', { group_id: 1, message: 'hi' })).resolves.toEqual({ message_id: 42 })
    expect(calls[0]!.url).toBe('http://gw:3000/send_group_msg')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ group_id: 1, message: 'hi' })
  })
  it('passes a business failure through untouched and retries only an unreachable gateway', async () => {
    const refused = () => Object.assign(new Error('connect failed'), { cause: { code: 'ECONNREFUSED' } })
    const business = createOneBotClient({ endpoint: () => ({ httpUrl: 'http://gw:3000' }), onEvent: () => {}, retryDelays: [1, 1],
      fetchImpl: (async () => failed(100, 'bad group')) as unknown as typeof fetch })
    await expect(business.call('send_group_msg', {})).rejects.toMatchObject({ action: 'send_group_msg', transport: false })
    const attempts = vi.fn(async () => { throw refused() })
    const unreachable = createOneBotClient({ endpoint: () => ({ httpUrl: 'http://gw:3000' }), onEvent: () => {}, retryDelays: [1, 1],
      fetchImpl: attempts as unknown as typeof fetch })
    await expect(unreachable.call('send_group_msg', {})).rejects.toMatchObject({ transport: true })
    expect(attempts).toHaveBeenCalledTimes(3)
    const unconfigured = createOneBotClient({ endpoint: () => ({}), onEvent: () => {} })
    await expect(unconfigured.call('get_status')).rejects.toBeInstanceOf(OneBotError)
  })
})

describe('roost-host client', () => {
  it('parses SSE frames, tracks the sequence, and skips malformed data', () => {
    const first = feedSse('', 'id: 5\ndata: {"type":"message"}\n\nid: 6\ndata: not json\n\nid: 7\nda', 0)
    expect(first.frames).toEqual([{ type: 'message' }])
    expect(first.lastSeq).toBe(6)
    const second = feedSse(first.rest, 'ta: {"type":"gap"}\n\n', first.lastSeq)
    expect(second.frames).toEqual([{ type: 'gap' }])
    expect(second.lastSeq).toBe(7)
  })
  it('calls /rpc with its token and reports a refused payload', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ ok: true, data: { message_id: 'm1' } }), { status: 200 })
    }) as unknown as typeof fetch
    const client = createRoostHostClient({ baseUrl: 'https://host/', token: 'secret', onEvent: () => {}, fetchImpl })
    await expect(client.call('msg.send', { kind: 'group', chatId: 'g1', content: 'hi' })).resolves.toEqual({ message_id: 'm1' })
    expect(calls[0]!.url).toBe('https://host/rpc')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ method: 'msg.send', params: { kind: 'group', chatId: 'g1', content: 'hi' } })
    const refusing = createRoostHostClient({ baseUrl: 'https://host', token: 't', onEvent: () => {},
      fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: { code: 'denied', message: 'no' } }), { status: 200 })) as unknown as typeof fetch })
    await expect(refusing.call('msg.send', {})).rejects.toBeInstanceOf(RoostError)
    await expect(refusing.call('msg.send', {})).rejects.toThrow('denied')
  })
  it('streams events, persists the sequence, and reconnects after the stream ends', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode('id: 11\ndata: {"type":"message","seq":11}\n\n'))
    } })
    const since: string[] = []
    const events: Record<string, unknown>[] = []
    const seqs: number[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      since.push(String(url))
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const client = createRoostHostClient({ baseUrl: 'https://host', token: 't', onEvent: frame => events.push(frame),
      onSeq: seq => seqs.push(seq), since: 3, fetchImpl, reconnectMinMs: 10_000 })
    client.start()
    await vi.waitFor(() => expect(events).toEqual([{ type: 'message', seq: 11 }]), { timeout: 5_000 })
    expect(seqs).toEqual([11])
    expect(since[0]).toBe('https://host/events?since=3')
    client.stop()
    expect(client.state).toBe('stopped')
  })
})

/** The fake OneBot Universal WebSocket: records outbound actions and lets a test push events in. */
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  readonly sent: { action?: string; params?: Record<string, unknown>; echo?: string }[] = []
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  send(text: string): void {
    const frame = JSON.parse(text) as { action?: string; params?: Record<string, unknown>; echo?: string }
    this.sent.push(frame)
    if (frame.echo) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 }, echo: frame.echo }) }))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.onclose?.())
  }
  /** Delivers one OneBot event, as the gateway's WebSocket would. */
  push(event: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(event) }) }
}

describe('qq source end to end', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeSocket.instances = [] })

  it('opens a Ticket from a mentioned group message, replies in that group, and ignores a replay after a restart', async () => {
    const delivered: { url: string; body: Record<string, unknown> }[] = []
    const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      delivered.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} })
      return ok({ message_id: 9001 })
    })
    vi.stubGlobal('fetch', http)
    vi.stubGlobal('WebSocket', FakeSocket)
    const host = await startRuntime()
    try {
      host.runtime.sources.register(qqKind)
      const settings = host.runtime.store.settings()
      host.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
        sources: { ...settings.sources, qq: { enabled: true, config: { mode: 'onebot', httpUrl: 'http://fake', wsUrl: 'ws://fake',
          selfId: SELF, chats: [{ chatId: GROUP, name: 'Team', listen: 'mentions' }], directMessages: true } } },
        policy: { ...settings.policy, sources: { ...settings.policy.sources, qq: { allowed: [{ id: ALICE, name: 'Alice' }] } } } })
      const running = new AbortController()
      const loop = runQq(host.runtime.context(qqKind), running.signal)
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1), { timeout: 10_000 })
      const socket = FakeSocket.instances[0]!
      await vi.waitFor(() => expect(socket.readyState).toBe(1), { timeout: 5_000 })
      const event = { post_type: 'message', message_type: 'group', group_id: GROUP, user_id: ALICE, message_id: '5001', time: 1_700_000_000,
        sender: { nickname: 'Alice' }, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' fix the title' } }] }
      socket.push(event)
      const id = key('qq', 'group', GROUP, '5001')
      await vi.waitFor(() => expect(host.runtime.store.triggers.get(id)).toBeDefined(), { timeout: 10_000 })
      const trigger = host.runtime.store.triggers.get(id)!
      expect(trigger.channel).toMatchObject({ source: 'qq', address: { chatId: GROUP, messageId: '5001' } })
      const { ticket } = await host.acceptedTicket(trigger)
      expect(ticket.channels[0]).toMatchObject({ source: 'qq', thread: qqThread('group', GROUP) })
      // The acknowledgement goes back to the group the message came from.
      await vi.waitFor(() => expect(delivered.some(call => call.url.endsWith('/send_group_msg') && call.body.group_id === Number(GROUP)
        && String(call.body.message).includes('修复回归'))).toBe(true), { timeout: 10_000 })
      // A reply the Executor sends later takes the same address.
      const reply: OutboundMessage = { id: 'reply-1', channel: trigger.channel!, text: '已修好', kind: 'reply', ticketId: ticket.id }
      await expect(qqKind.channel!.send({} as never, reply)).resolves.toBe('sent')
      await vi.waitFor(() => expect(delivered.some(call => call.url.endsWith('/send_group_msg') && call.body.message === '已修好')).toBe(true), { timeout: 5_000 })

      const decisions = host.runtime.store.decisions.byThread('qq:' + qqThread('group', GROUP)).length
      running.abort()
      await loop
      // A restart reconnects and replays the same event; its deterministic ID makes it a duplicate, not new work.
      const again = new AbortController()
      const restarted = runQq(host.runtime.context(qqKind), again.signal)
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 })
      const second = FakeSocket.instances.at(-1)!
      await vi.waitFor(() => expect(second.readyState).toBe(1), { timeout: 5_000 })
      second.push(event)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(host.runtime.store.decisions.byThread('qq:' + qqThread('group', GROUP)).length).toBe(decisions)
      expect(host.runtime.store.triggers.get(id)).toBeDefined()
      again.abort()
      await restarted
    } finally {
      await host.stop()
    }
  }, 60_000)
})
