/**
 * 宿主一次性模型调用（不自建会话）。
 * 监管者研判与调度者路由共用：严格 JSON、短输出、失败由调用方回退，不静默。
 */

/** 给外部 signal 叠一层超时，返回 signal 与清理函数。 */
export function withTimeout(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('host model timeout')), ms)
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

/**
 * 调一次宿主默认模型，拼回文本。
 * provider/model 优先取配置覆盖（assessment.provider/model），否则用宿主默认路由。
 */
export async function callHostModel({ llm, selection, config, system, prompt, signal, maxTokens = 200 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const provider = config?.assessment?.provider || selection?.provider
  const model = config?.assessment?.model || selection?.model
  if (!provider || !model) throw new Error('拿不到默认模型路由（provider/model）')
  let text = ''
  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0,
    maxTokens,
    signal,
  })
  for await (const chunk of stream) {
    if (typeof chunk?.text === 'string') text += chunk.text
    else if (typeof chunk?.delta?.text === 'string') text += chunk.delta.text
    else if (typeof chunk?.content === 'string') text += chunk.content
  }
  return text
}
