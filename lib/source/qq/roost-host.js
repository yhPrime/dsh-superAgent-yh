/**
 * roost-host/1 客户端：SSE 收事件（GET /events）+ POST /rpc 调方法。
 * 协议文档：https://github.com/roost-qq/qq-bot-roost/blob/master/docs/宿主协议v1.md
 * 只实现本插件用到的子集：消息事件、system.capabilities、msg.send。
 */
import { SourceError } from '../contract.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createRoostHostClient({
  baseUrl,
  token,
  onEvent,
  onState,
  log,
  fetchImpl = globalThis.fetch,
  reconnectMinMs = 2000,
  reconnectMaxMs = 30000,
}) {
  let stopped = true
  let controller = null
  let lastSeq = 0
  let state = 'stopped'
  let rpcSeq = 0

  const setState = (next, detail) => {
    if (state === next) return
    state = next
    try {
      onState?.(next, detail)
    } catch {
      /* 状态回调不影响连接 */
    }
  }

  async function call(method, params = {}, { timeoutMs = 30000 } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: `syh-${++rpcSeq}`, method, params }),
        signal: ctrl.signal,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new SourceError(`roost-host RPC ${method} HTTP ${response.status}`, { status: response.status })
      }
      if (!payload?.ok) {
        const error = payload?.error ?? {}
        throw new SourceError(`roost-host RPC ${method} 失败：${error.code ?? ''} ${error.message ?? ''}`.trim(), { status: response.status })
      }
      return payload.data
    } catch (error) {
      if (error.name === 'AbortError') throw new SourceError(`roost-host RPC ${method} 超时`)
      if (error instanceof SourceError) throw error
      throw new SourceError(`roost-host RPC ${method} 连不上：${error?.cause?.code || error.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 解析 SSE：帧以空行分隔，id 是 seq，data 是完整帧 JSON。 */
  function feedSse(buffer, chunk) {
    let text = buffer + chunk
    const frames = []
    for (;;) {
      const at = text.indexOf('\n\n')
      if (at < 0) break
      const block = text.slice(0, at)
      text = text.slice(at + 2)
      let id = null
      let data = null
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim())
        else if (line.startsWith('data:')) data = (data === null ? '' : data + '\n') + line.slice(5).trimStart()
      }
      if (Number.isFinite(id) && id > lastSeq) lastSeq = id
      if (data) {
        try {
          frames.push(JSON.parse(data))
        } catch {
          /* 坏帧跳过 */
        }
      }
    }
    return { rest: text, frames }
  }

  async function run() {
    let backoff = reconnectMinMs
    while (!stopped) {
      controller = new AbortController()
      try {
        const response = await fetchImpl(`${baseUrl}/events?since=${lastSeq}`, {
          headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!response.ok) throw new SourceError(`roost-host /events HTTP ${response.status}`, { status: response.status })
        setState('connected')
        backoff = reconnectMinMs
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const parsed = feedSse(buffer, decoder.decode(value, { stream: true }))
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            try {
              onEvent(frame)
            } catch (error) {
              log?.(`处理 roost-host 事件出错：${error.message}`)
            }
          }
        }
        throw new SourceError('roost-host /events 连接结束')
      } catch (error) {
        if (stopped) return
        setState('disconnected', error?.message)
        log?.(`roost-host 断线，${backoff / 1000}s 后重连：${error?.message}`)
        await sleep(backoff)
        backoff = Math.min(reconnectMaxMs, backoff * 2)
      }
    }
  }

  return {
    call,
    start() {
      if (!stopped) return
      stopped = false
      run().catch((error) => log?.(`roost-host 事件循环退出：${error.message}`))
    },
    stop() {
      stopped = true
      controller?.abort()
      controller = null
      setState('stopped')
    },
    get state() {
      return state
    },
    get lastSeq() {
      return lastSeq
    },
  }
}
