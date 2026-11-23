/**
 * 飞书源：插件内直连飞书 HTTP API（不依赖 lark-cli）。
 * 轮询群里/私聊的消息 → Trigger；回写走发消息接口，默认关闭，必须 confirmWrites。
 * 说明：本机没有真实飞书凭证，当前只用本地假飞书服务验证协议形状；真实环境需 appId/appSecret。
 */
import { SourceError, normalizeTrigger } from './contract.js'

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const MESSAGES_PATH = '/open-apis/im/v1/messages'

export function createFeishuSource(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const base = cfg.apiBase.replace(/\/+$/, '')
  let cached = { token: null, expiresAt: 0 }

  async function tenantToken() {
    if (cached.token && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await fetchImpl(`${base}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload || payload.code !== 0 || !payload.tenant_access_token) {
      throw new SourceError(`飞书取 tenant_access_token 失败：HTTP ${response.status} ${payload?.msg ?? ''}`.trim(), { status: response.status })
    }
    cached = { token: payload.tenant_access_token, expiresAt: Date.now() + (Number(payload.expire) || 3600) * 1000 }
    return cached.token
  }

  async function request(path, { method = 'GET', body, retry = true } = {}) {
    const token = await tenantToken()
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload) {
      if (response.status === 401 && retry) {
        cached = { token: null, expiresAt: 0 }
        return request(path, { method, body, retry: false })
      }
      throw new SourceError(`飞书 API 失败：HTTP ${response.status} ${path}`, { status: response.status })
    }
    if (payload.code === 99991663 && retry) {
      cached = { token: null, expiresAt: 0 }
      return request(path, { method, body, retry: false })
    }
    if (payload.code !== 0) throw new SourceError(`飞书 API 业务错误 ${payload.code}：${payload.msg ?? ''}`, { status: response.status })
    return payload.data ?? {}
  }

  function textOf(message) {
    try {
      const content = JSON.parse(message.body?.content ?? '{}')
      return typeof content.text === 'string' ? content.text : ''
    } catch {
      return ''
    }
  }

  function matches(message, text) {
    if (cfg.authors.length > 0 && !cfg.authors.includes(message.sender?.id)) return false
    if (cfg.requireMention) {
      const mentions = message.mentions ?? []
      if (mentions.length === 0) return false
      if (cfg.botOpenId && !mentions.some((mention) => mention.id?.open_id === cfg.botOpenId || mention.id?.user_id === cfg.botOpenId)) return false
      if (!text.includes('@')) return false
    }
    return true
  }

  const source = {
    kind: 'feishu',
    capabilities: { write: true, comments: false, threads: true },
    async poll(since = null) {
      const triggers = []
      let watermark = since
      const sinceMs = since ? new Date(since).getTime() : 0
      for (const chatId of cfg.chatIds) {
        const query = new URLSearchParams({
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: 'ByCreateTimeAsc',
          page_size: '50',
        })
        if (sinceMs > 0) query.set('start_time', String(Math.floor(sinceMs / 1000)))
        let pageToken = ''
        for (let page = 0; page < 5; page += 1) {
          if (pageToken) query.set('page_token', pageToken)
          const data = await request(`${MESSAGES_PATH}?${query}`)
          for (const message of data.items ?? []) {
            if (message.msg_type !== 'text') continue
            if (message.sender?.sender_type === 'app') continue
            const at = Number(message.create_time)
            if (!Number.isFinite(at)) continue
            const atIso = new Date(at).toISOString()
            if (since && at <= sinceMs) continue
            const text = textOf(message)
            if (!text) continue
            if (!matches(message, text)) continue
            triggers.push(normalizeTrigger({
              id: `msg-${message.message_id}`,
              thread: `chat:${chatId}`,
              actor: message.sender?.id ?? 'unknown',
              title: text.split('\n')[0].slice(0, 120),
              body: text,
              url: '',
              at: atIso,
              kind: 'message',
            }, 'feishu'))
            if (!watermark || new Date(atIso) > new Date(watermark)) watermark = atIso
          }
          if (!data.has_more || !data.page_token) break
          pageToken = data.page_token
        }
      }
      return { triggers, since: watermark }
    },
    async send(thread, text) {
      if (!cfg.confirmWrites) throw new SourceError('飞书回写未开启（sources.feishu.confirmWrites=false）')
      const chatId = String(thread).replace(/^chat:/, '').replace(/^chat-/, '')
      await request(`${MESSAGES_PATH}?receive_id_type=chat_id`, {
        method: 'POST',
        body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
    },
    async ack() {
      return { skipped: true, reason: '飞书消息没有 ack 语义（水位去重）' }
    },
  }
  return source
}
