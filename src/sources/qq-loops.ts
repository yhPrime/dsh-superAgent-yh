/** QQ background loop: one live connection (OneBot WebSocket or roost-host SSE) feeding Triggers, plus its reply path. */
import { setTimeout as delay } from 'node:timers/promises'
import { threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { clearQqSender, qqAddressFields, setQqSender, type QqSender } from './qq-channel.ts'
import { health, type SourceContext } from './host.ts'
import { createOneBotClient, type OneBotState } from './qq-onebot.ts'
import { createRoostHostClient, type RoostState } from './qq-roost.ts'
import { officialTrigger, personalTrigger, SOURCE } from './qq-trigger.ts'
import type { QqConfig } from './qq.ts'

const CONNECTION_CHECK_MS = 5_000
const enabled = (ctx: SourceContext): QqConfig | undefined => ctx.config<QqConfig>(SOURCE)
const waitAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))

/** What keeps the configured mode from connecting; undefined when it can. */
export const connectionProblem = (config: QqConfig): string | undefined => {
  if (config.mode === 'onebot') return config.httpUrl || config.wsUrl ? undefined : 'The OneBot mode needs an HTTP or WebSocket URL'
  return config.baseUrl && config.token ? undefined : 'The roost-host mode needs a base URL and a token'
}

/** Runs the QQ connection only while the Source is enabled; disabling it stops the connection within five seconds. */
export async function runQq(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent-yh once it resolves the deployment; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('qq', health('paused', 'sourceOff'))
      await delay(CONNECTION_CHECK_MS, undefined, { signal }).catch(() => {})
      continue
    }
    if (connectionProblem(config)) {
      ctx.report('qq', health('paused', 'qqUnset'))
      await delay(CONNECTION_CHECK_MS, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, CONNECTION_CHECK_MS)
    const stop = (): void => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try {
      await connect(ctx, config, running.signal)
    } catch (error) {
      if (!running.signal.aborted) ctx.report('qq', { state: 'error', detail: String(error) })
    } finally {
      clearInterval(check)
      signal.removeEventListener('abort', stop)
    }
    if (running.signal.aborted) continue
    retry = retryDelay(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}

function available(ctx: SourceContext): boolean {
  if (ctx.configured()) return true
  ctx.report('qq', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'setupPending'))
  return false
}

/** Wait before reconnecting: 1s after a connection that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const retryDelay = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1_000 : Math.min(previous * 2, 60_000)

async function connect(ctx: SourceContext, config: QqConfig, signal: AbortSignal): Promise<void> {
  return config.mode === 'onebot' ? connectOneBot(ctx, config, signal) : connectRoost(ctx, config, signal)
}

function queueReceive(ctx: SourceContext, config: QqConfig): { chain: Promise<void>; push(trigger: Trigger): void } {
  let chain: Promise<void> = Promise.resolve()
  return {
    get chain() { return chain },
    push(trigger) {
      chain = chain.then(async () => {
        if (!enabled(ctx)) return
        await receive(ctx, config, trigger)
      }).catch(error => { ctx.report('qq', { state: 'error', detail: String(error) }) })
    },
  }
}

async function receive(ctx: SourceContext, config: QqConfig, trigger: Trigger): Promise<void> {
  const chatId = String(trigger.meta.chatId ?? '')
  const name = config.chats.find(chat => chat.chatId === chatId)?.name
  const label = trigger.meta.direct === true
    ? `QQ ${String(trigger.meta.senderName ?? chatId)}`
    : `QQ ${name || chatId}`
  await ctx.receive(trigger)
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label })
}

async function connectOneBot(ctx: SourceContext, config: QqConfig, signal: AbortSignal): Promise<void> {
  const feed = queueReceive(ctx, config)
  const client = createOneBotClient({
    endpoint: () => ({ httpUrl: config.httpUrl || undefined, wsUrl: config.wsUrl || undefined,
      httpToken: config.httpToken || undefined, wsToken: config.wsToken || undefined }),
    onEvent: event => {
      const trigger = personalTrigger(event, { selfId: config.selfId })
      if (trigger) feed.push(trigger)
    },
    onState: (state, detail) => reportOneBot(ctx, state, detail),
  })
  const sender: QqSender = {
    async send(address, body) {
      const { chatKind, chatId } = qqAddressFields(address)
      const id = Number(chatId)
      if (!Number.isSafeInteger(id)) throw new Error(`The QQ chat id ${chatId} is not an OneBot numeric id`)
      if (chatKind === 'group') await client.call('send_group_msg', { group_id: id, message: body })
      else await client.call('send_private_msg', { user_id: id, message: body })
    },
  }
  setQqSender(sender)
  try {
    client.start()
    await waitAbort(signal)
  } finally {
    client.stop()
    clearQqSender(sender)
  }
  await feed.chain
}

async function connectRoost(ctx: SourceContext, config: QqConfig, signal: AbortSignal): Promise<void> {
  const feed = queueReceive(ctx, config)
  const client = createRoostHostClient({
    baseUrl: config.baseUrl,
    token: config.token,
    since: ctx.state.get(KV.qq.since) ?? 0,
    onSeq: seq => ctx.state.set(KV.qq.since, seq),
    onEvent: frame => {
      if (frame.type === 'gap') {
        ctx.report('qq', { state: 'paused', detail: 'The roost-host event buffer dropped frames; QQ messages may be missing' })
        return
      }
      const trigger = officialTrigger(frame)
      if (trigger) feed.push(trigger)
    },
    onState: (state, detail) => reportRoost(ctx, state, detail),
  })
  const sender: QqSender = {
    async send(address, body) {
      const { chatId, providerKind } = qqAddressFields(address)
      await client.call('msg.send', { kind: providerKind, chatId, content: body })
    },
  }
  setQqSender(sender)
  try {
    client.start()
    await waitAbort(signal)
  } finally {
    client.stop()
    clearQqSender(sender)
  }
  await feed.chain
}

function reportOneBot(ctx: SourceContext, state: OneBotState, detail?: string): void {
  switch (state) {
    case 'connected': ctx.report('qq', { state: 'ready', detail: detail || 'Connected to the OneBot gateway' }); break
    case 'connecting': ctx.report('qq', { state: 'starting', detail: detail || 'Connecting to the OneBot gateway' }); break
    case 'disconnected': ctx.report('qq', { state: 'paused', detail: detail || 'The OneBot gateway connection closed; reconnecting' }); break
    case 'unconfigured': ctx.report('qq', health('paused', 'qqUnset')); break
    case 'unsupported': ctx.report('qq', { state: 'error', detail: detail || 'This runtime has no global WebSocket' }); break
    case 'stopped': break
  }
}

function reportRoost(ctx: SourceContext, state: RoostState, detail?: string): void {
  switch (state) {
    case 'connected': ctx.report('qq', { state: 'ready', detail: detail || 'Connected to roost-host' }); break
    case 'connecting': ctx.report('qq', { state: 'starting', detail: detail || 'Connecting to roost-host' }); break
    case 'disconnected': ctx.report('qq', { state: 'paused', detail: detail || 'The roost-host stream closed; reconnecting' }); break
    case 'stopped': break
  }
}
