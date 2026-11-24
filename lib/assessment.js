/**
 * 监管者（Eval Assessment）：决定一条工单值不值得开工。
 * 按源选实现：QQ 消息五花八门 → 模型研判；GitHub/飞书结构清楚 → 规则直通（零调用）。
 * 失败一律回退 accept：宁可派错，不丢活；原因记进 lastError / 面板计数。
 */

const VERDICTS = new Set(['accept', 'ignore', 'stop'])
const DEFAULT_TIMEOUT_MS = 20_000

const SYSTEM = [
  '你是工单准入研判器。判断这条消息是否值得派一个执行器去做。',
  '只输出一行 JSON：{"verdict":"accept|ignore|stop","reason":"≤40字","preset":"可选"}',
  'accept=确实要做事；ignore=闲聊/寒暄/与工作无关；stop=明确要求停下或别做。',
].join('\n')

/** 该源用哪种研判：显式配置优先，缺省 QQ=agent、其它=off。 */
export function assessmentModeOf(config, sourceKind) {
  const explicit = config?.sources?.[sourceKind]?.assessment
  if (explicit === 'agent' || explicit === 'off') return explicit
  return sourceKind === 'qq' ? 'agent' : 'off'
}

/** 从模型输出里抠出判定；不合法返回 null。 */
export function parseVerdict(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    if (!value || typeof value !== 'object') return null
    if (!VERDICTS.has(value.verdict)) return null
    return {
      verdict: value.verdict,
      reason: String(value.reason ?? '').slice(0, 120),
      preset: typeof value.preset === 'string' && value.preset.trim() ? value.preset.trim() : undefined,
    }
  } catch {
    return null
  }
}

function promptOf(ticket) {
  return [
    `来源：${ticket.source} ${ticket.thread}`,
    `发起人：${ticket.actor}`,
    `标题：${ticket.title}`,
    `正文：${(ticket.body || '（无正文）').slice(0, 2000)}`,
  ].join('\n')
}

function withTimeout(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('assessment timeout')), ms)
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** 默认模型调用：复用宿主 llm + 默认模型路由，不自建会话。 */
async function callHostModel(ctx, config, prompt, signal) {
  const llm = ctx?.llm
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const selection = ctx.agentDefaultModel?.currentSelection?.() ?? {}
  const provider = config?.assessment?.provider || selection.provider
  const model = config?.assessment?.model || selection.model
  if (!provider || !model) throw new Error('拿不到默认模型路由（provider/model）')
  let text = ''
  const stream = llm.stream({
    provider,
    model,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0,
    maxTokens: 200,
    signal,
  })
  for await (const chunk of stream) {
    if (typeof chunk?.text === 'string') text += chunk.text
    else if (typeof chunk?.delta?.text === 'string') text += chunk.delta.text
    else if (typeof chunk?.content === 'string') text += chunk.content
  }
  return text
}

export function createAssessment({ ctx, config, log, redact, deps = {} }) {
  const call = deps.call ?? ((prompt, signal) => callHostModel(ctx, config, prompt, signal))
  const counters = { calls: 0, ignored: 0, stopped: 0, fallbacks: 0 }

  async function assess(ticket, signal) {
    const mode = assessmentModeOf(config, ticket.source)
    if (mode === 'off') return { verdict: 'accept', mode, reason: 'rules' }
    counters.calls += 1
    const timer = withTimeout(signal, config?.assessment?.timeoutMs || DEFAULT_TIMEOUT_MS)
    try {
      const text = await call(promptOf(ticket), timer.signal)
      const parsed = parseVerdict(text)
      if (!parsed) throw new Error(`研判输出不可解析：${String(text).slice(0, 120)}`)
      if (parsed.verdict === 'ignore') counters.ignored += 1
      if (parsed.verdict === 'stop') counters.stopped += 1
      log?.(ticket.id, `assessment ${parsed.verdict}: ${parsed.reason}`)
      return { ...parsed, mode }
    } catch (error) {
      counters.fallbacks += 1
      const message = redact?.(error?.message ?? String(error)) ?? String(error)
      log?.(ticket.id, `assessment fallback accept: ${message}`)
      return { verdict: 'accept', mode, reason: 'fallback', error: message }
    } finally {
      timer.done()
    }
  }

  return {
    assess,
    modeOf: (sourceKind) => assessmentModeOf(config, sourceKind),
    stats: () => ({ ...counters }),
  }
}
