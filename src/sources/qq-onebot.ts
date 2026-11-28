/**
 * OneBot v11 client: HTTP for calls and a Universal WebSocket for events, reconnecting on its own.
 * Ported from the plugin's earlier OneBot client (MIT, aurabot authors); the retry, fallback, and reconnect
 * semantics are unchanged. Only Node's global `fetch` and `WebSocket` are used.
 */

const RECONNECT_MIN = 2_000
const RECONNECT_MAX = 30_000
const RETRY_DELAYS = [1_000, 3_000, 5_000] as const

export type OneBotState = 'stopped' | 'connecting' | 'connected' | 'disconnected' | 'unconfigured' | 'unsupported'
export interface OneBotEndpoint { httpUrl?: string; wsUrl?: string; httpToken?: string; wsToken?: string }
export interface OneBotClientOptions {
  /** Read on every connection attempt, so a settings change needs no client restart. */
  endpoint: () => OneBotEndpoint
  onEvent: (event: Record<string, unknown>) => void
  onState?: (state: OneBotState, detail?: string) => void
  fetchImpl?: typeof fetch
  retryDelays?: readonly number[]
}

interface PendingCall { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; action: string }

/** An OneBot action failed; `transport` marks a gateway that could not be reached, which is worth retrying. */
export class OneBotError extends Error {
  readonly action: string
  readonly data: unknown
  readonly transport: boolean
  readonly uncertain: boolean
  constructor(action: string, data: unknown, options: { transport?: boolean; uncertain?: boolean } = {}) {
    const detail = data as { message?: unknown; wording?: unknown; retcode?: unknown } | null | undefined
    const why = detail?.message ?? detail?.wording ?? detail?.retcode ?? 'unknown error'
    super(`${action} failed: ${String(why)}`)
    this.name = 'OneBotError'
    this.action = action
    this.data = data
    this.transport = options.transport ?? false
    this.uncertain = options.uncertain ?? false
  }
}

/** fetch failures are not always "not connected": a dropped connection may already have reached the gateway. */
const notConnected = (error: unknown): boolean => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(String(code))
}
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createOneBotClient({ endpoint, onEvent, onState, retryDelays = RETRY_DELAYS, fetchImpl = globalThis.fetch }: OneBotClientOptions) {
  let ws: WebSocket | null = null
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let backoff = RECONNECT_MIN
  let state: OneBotState = 'stopped'
  let echoSeq = 0
  let stopGeneration = 0
  let explicitlyStopped = false
  const pending = new Map<string, PendingCall>()
  const retryWaits = new Set<() => void>()

  const setState = (next: OneBotState, detail?: string): void => {
    if (state === next) return
    state = next
    try { onState?.(next, detail) } catch { /* a state callback never breaks the connection */ }
  }
  const describeNetError = (error: unknown, ep: OneBotEndpoint): string => {
    const where = ep.httpUrl || ep.wsUrl || '(no address configured)'
    const why = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause?.code
      ?? (error as { cause?: { message?: unknown } } | null)?.cause?.message ?? messageOf(error)
    return `cannot reach the OneBot gateway (${where}): ${String(why)}`
  }

  /** One HTTP or WebSocket attempt; network failures are marked transport, business errors pass through. */
  async function callOnce(action: string, params: Record<string, unknown>, timeoutMs: number, generation: number): Promise<unknown> {
    const ep = endpoint()
    if (ep.httpUrl) {
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (ep.httpToken) headers.authorization = `Bearer ${ep.httpToken}`
        const response = await fetchImpl(`${ep.httpUrl.replace(/\/+$/, '')}/${action}`, { method: 'POST', headers, body: JSON.stringify(params), signal: controller.signal })
        let body: { status?: string; retcode?: number; data?: unknown; message?: string; wording?: string } | null
        try {
          body = await response.json() as typeof body
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error
          throw new OneBotError(action, { message: `the gateway answered HTTP ${response.status} with a body that is not JSON` }, { uncertain: true })
        }
        if (body?.status === 'ok' || body?.retcode === 0) return body.data
        throw new OneBotError(action, body)
      } catch (error) {
        if (error instanceof OneBotError) throw error
        // A timeout may mean the request went out and its receipt was lost; retrying would send the message twice.
        if ((error as Error).name === 'AbortError') throw new OneBotError(action, { message: 'timed out' }, { uncertain: true })
        if (!notConnected(error)) throw new OneBotError(action, { message: describeNetError(error, ep) }, { uncertain: true })
        if (generation !== stopGeneration) throw new OneBotError(action, { message: 'the OneBot client stopped' })
        if (ws && ws.readyState === WebSocket.OPEN) return callWs(action, params, timeoutMs)
        throw new OneBotError(action, { message: describeNetError(error, ep) }, { transport: true })
      } finally {
        clearTimeout(abort)
      }
    }
    return callWs(action, params, timeoutMs)
  }

  async function call(action: string, params: Record<string, unknown> = {}, { timeoutMs = 30_000, retries = retryDelays.length }: { timeoutMs?: number; retries?: number } = {}): Promise<unknown> {
    if (explicitlyStopped) throw new OneBotError(action, { message: 'the OneBot client stopped' })
    const ep = endpoint()
    if (!ep.httpUrl && !ep.wsUrl) throw new OneBotError(action, { message: 'no OneBot gateway address is configured' }, { transport: true })
    let lastError: unknown
    const generation = stopGeneration
    const stoppedError = () => new OneBotError(action, { message: 'the OneBot client stopped' })
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (generation !== stopGeneration) throw stoppedError()
      try {
        return await callOnce(action, params, timeoutMs, generation)
      } catch (error) {
        lastError = error
        if (generation !== stopGeneration) throw stoppedError()
        if (!(error instanceof OneBotError) || !error.transport) throw error
        if (attempt === retries) break
        const wait = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 0
        if (generation !== stopGeneration) throw stoppedError()
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(waitTimer); retryWaits.delete(done); resolve() }
          const waitTimer = setTimeout(done, wait)
          retryWaits.add(done)
        })
      }
    }
    throw lastError
  }

  function callWs(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new OneBotError(action, { message: 'not connected to the OneBot gateway' }, { transport: true }))
    const echo = `syh-${Date.now()}-${++echoSeq}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(echo)
        reject(new OneBotError(action, { message: 'timed out' }, { uncertain: true }))
      }, timeoutMs)
      pending.set(echo, { resolve, reject, timer: timeout, action })
      ws!.send(JSON.stringify({ action, params, echo }))
    })
  }

  function connect(): void {
    if (stopped) return
    const ep = endpoint()
    if (!ep.wsUrl) {
      setState('unconfigured', 'no WebSocket URL')
      schedule()
      return
    }
    if (typeof WebSocket !== 'function') {
      setState('unsupported', 'this runtime has no global WebSocket, so QQ events cannot be received')
      return
    }
    setState('connecting')
    let url = ep.wsUrl
    if (ep.wsToken) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ep.wsToken)
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      schedule()
      return
    }
    ws = socket
    socket.onopen = () => {
      backoff = RECONNECT_MIN
      setState('connected')
    }
    socket.onmessage = event => {
      let data: Record<string, unknown>
      try {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
        data = JSON.parse(text) as Record<string, unknown>
      } catch {
        return
      }
      const echo = data.echo
      if (typeof echo === 'string' && pending.has(echo)) {
        const call_ = pending.get(echo)!
        pending.delete(echo)
        clearTimeout(call_.timer)
        if (data.status === 'ok' || data.retcode === 0) call_.resolve(data.data)
        else call_.reject(new OneBotError(call_.action, data))
        return
      }
      if (typeof data.post_type === 'string') {
        try { onEvent(data) } catch { /* a handler failure never breaks the socket */ }
      }
    }
    socket.onclose = () => {
      if (ws === socket) ws = null
      for (const [echo, call_] of pending) {
        clearTimeout(call_.timer)
        call_.reject(new OneBotError(call_.action, { message: 'connection closed' }, { uncertain: true }))
        pending.delete(echo)
      }
      if (!stopped) {
        setState('disconnected')
        schedule()
      }
    }
    socket.onerror = () => {}
  }

  function schedule(): void {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(connect, backoff)
    backoff = Math.min(RECONNECT_MAX, backoff * 2)
  }

  return {
    call,
    start(): void {
      if (!stopped) return
      explicitlyStopped = false
      stopped = false
      backoff = RECONNECT_MIN
      connect()
    },
    stop(): void {
      stopped = true
      explicitlyStopped = true
      stopGeneration++
      for (const done of [...retryWaits]) done()
      clearTimeout(timer)
      setState('stopped')
      try { ws?.close() } catch { /* already closed */ }
      ws = null
    },
    get state(): OneBotState { return state },
  }
}
export type OneBotClient = ReturnType<typeof createOneBotClient>
