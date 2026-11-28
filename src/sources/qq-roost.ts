/**
 * roost-host/1 client: SSE over `GET /events` and `POST /rpc`, reconnecting on its own.
 * Implements only the subset this Source needs: message events, `system.capabilities`, and `msg.send`.
 * Protocol: https://github.com/roost-qq/qq-bot-roost/blob/master/docs/宿主协议v1.md
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type RoostState = 'stopped' | 'connecting' | 'connected' | 'disconnected'
export interface RoostClientOptions {
  baseUrl: string
  token: string
  onEvent: (frame: Record<string, unknown>) => void
  onState?: (state: RoostState, detail?: string) => void
  /** Resume after this sequence number; persisted by the caller so a restart replays at most once. */
  since?: number
  onSeq?: (seq: number) => void
  fetchImpl?: typeof fetch
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

/** A roost-host call or stream failed. */
export class RoostError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'RoostError'
    this.status = status
  }
}

/** Parses SSE frames: blocks end at a blank line; `id` is the sequence and `data` the whole JSON frame. */
export function feedSse(buffer: string, chunk: string, lastSeq: number): { rest: string; frames: Record<string, unknown>[]; lastSeq: number } {
  let text = buffer + chunk
  const frames: Record<string, unknown>[] = []
  let seq = lastSeq
  for (;;) {
    const at = text.indexOf('\n\n')
    if (at < 0) break
    const block = text.slice(0, at)
    text = text.slice(at + 2)
    let id: number | undefined
    let data: string | undefined
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim())
      else if (line.startsWith('data:')) data = (data === undefined ? '' : data + '\n') + line.slice(5).trimStart()
    }
    if (Number.isFinite(id) && (id as number) > seq) seq = id as number
    if (data !== undefined && data !== '') {
      try { frames.push(JSON.parse(data) as Record<string, unknown>) } catch { /* skip a bad frame */ }
    }
  }
  return { rest: text, frames, lastSeq: seq }
}

export function createRoostHostClient({ baseUrl, token, onEvent, onState, since = 0, onSeq, fetchImpl = globalThis.fetch, reconnectMinMs = 2_000, reconnectMaxMs = 30_000 }: RoostClientOptions) {
  let stopped = true
  let controller: AbortController | null = null
  let lastSeq = since
  let state: RoostState = 'stopped'
  let rpcSeq = 0

  const setState = (next: RoostState, detail?: string): void => {
    if (state === next) return
    state = next
    try { onState?.(next, detail) } catch { /* a state callback never breaks the stream */ }
  }

  async function call(method: string, params: Record<string, unknown> = {}, { timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<unknown> {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: `syh-${++rpcSeq}`, method, params }),
        signal: abort.signal,
      })
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null
      if (!response.ok) throw new RoostError(`roost-host RPC ${method} answered HTTP ${response.status}`, response.status)
      if (!payload?.ok) {
        const error = payload?.error ?? {}
        throw new RoostError(`roost-host RPC ${method} failed: ${error.code ?? ''} ${error.message ?? ''}`.trim(), response.status)
      }
      return payload.data
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new RoostError(`roost-host RPC ${method} timed out`)
      if (error instanceof RoostError) throw error
      throw new RoostError(`roost-host RPC ${method} cannot connect: ${String((error as { cause?: { code?: unknown } } | null)?.cause?.code ?? (error as Error).message)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  async function run(): Promise<void> {
    let backoff = reconnectMinMs
    while (!stopped) {
      controller = new AbortController()
      try {
        setState('connecting')
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/events?since=${lastSeq}`, {
          headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!response.ok) throw new RoostError(`roost-host /events answered HTTP ${response.status}`, response.status)
        setState('connected')
        backoff = reconnectMinMs
        const body = response.body
        if (!body) throw new RoostError('roost-host /events returned no body')
        const reader = body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const parsed = feedSse(buffer, decoder.decode(value, { stream: true }), lastSeq)
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            try { onEvent(frame) } catch { /* a handler failure never breaks the stream */ }
          }
          if (parsed.lastSeq !== lastSeq) {
            lastSeq = parsed.lastSeq
            onSeq?.(lastSeq)
          }
        }
        throw new RoostError('roost-host /events stream ended')
      } catch (error) {
        if (stopped) return
        setState('disconnected', error instanceof Error ? error.message : String(error))
        await sleep(backoff)
        backoff = Math.min(reconnectMaxMs, backoff * 2)
      }
    }
  }

  return {
    call,
    start(): void {
      if (!stopped) return
      stopped = false
      void run()
    },
    stop(): void {
      stopped = true
      controller?.abort()
      controller = null
      setState('stopped')
    },
    get state(): RoostState { return state },
    get lastSeq(): number { return lastSeq },
  }
}
export type RoostHostClient = ReturnType<typeof createRoostHostClient>
