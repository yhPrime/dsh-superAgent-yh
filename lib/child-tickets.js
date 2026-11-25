/**
 * 单会话直派的子智能体 → 工单（v2.12 / D40）。
 *
 * 背景：单会话（dispatcher preset）用 `subagent` 工具直派的子会话不经过插件管线，
 * 宿主也不会归档它们，于是子会话越挂越多。这里用确定性信号把「真的是工单」的挑出来
 * 登记成工单（可见、可汇报、可清理），噪音（回声/占位测试）不建工单，空闲即归档。
 *
 * 判定只看子会话自己的事件，不猜：
 * - 有任意一次 `tool/call` → 真在干活 → 工单
 * - 首条任务 prompt ≥ 40 字符（且有像样的 label，或内容 ≥ 80 字符）→ 工单
 * - 只是「只回复 ok」这类回声、或 prompt 太薄 → 噪音
 */
export const CHILD_SOURCE = 'subagent'
export const CHILD_KIND = 'task'
export const CHILD_TICKET_PREFIX = 'subagent:'

const PLACEHOLDER_LABELS = new Set(['', '空', '空占位', '新会话', 'subagent', 'untitled', '测试', 'test'])
// 宿主给子智能体追加的尾段，判「任务内容」长度时不算。
const HOST_TAIL = /Your final answer is delivered automatically[\s\S]*$/i
const ECHO = /^(?:只|请)?(?:回复|回答|说|答)[^。！!?\n]{0,8}(?:ok|okay|好|收到)/i
const META_PREFIX = /^(?:<|MNEMON|Time sampled|Your final answer|Current working directory|The following information)/

export function eventOf(record) {
  return record?.event ?? record ?? null
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 子会话的首条任务 prompt（跳过宿主注入的提醒/元信息）。 */
export function firstTaskPrompt(records) {
  for (const record of records ?? []) {
    const event = eventOf(record)
    if (event?.type !== 'user/message') continue
    const text = textOfContent(event.data?.content).replace(HOST_TAIL, '').trim()
    if (!text || META_PREFIX.test(text)) continue
    return text
  }
  return ''
}

/** 判定子会话是不是「真的工单」。返回 ticket/reason/证据，方便日志与测试。 */
export function classifyChild({ records, label }) {
  const events = (records ?? []).map(eventOf).filter(Boolean)
  const toolCalls = events.filter((event) => event?.type === 'tool/call').length
  const prompt = firstTaskPrompt(records)
  const labelText = String(label ?? '').trim()
  const meaningfulLabel = !PLACEHOLDER_LABELS.has(labelText)
  if (toolCalls >= 1) {
    return { ticket: true, reason: 'tools', toolCalls, prompt, promptChars: prompt.length }
  }
  if (ECHO.test(prompt)) {
    return { ticket: false, reason: 'echo', toolCalls, prompt, promptChars: prompt.length }
  }
  if (prompt.length >= 40 && (meaningfulLabel || prompt.length >= 80)) {
    return { ticket: true, reason: 'prompt', toolCalls, prompt, promptChars: prompt.length }
  }
  return { ticket: false, reason: prompt ? 'too-thin' : 'empty', toolCalls, prompt, promptChars: prompt.length }
}

export function childTicketId(childSessionId) {
  return `${CHILD_TICKET_PREFIX}${childSessionId}`
}

export function labelIsPlaceholder(label) {
  return PLACEHOLDER_LABELS.has(String(label ?? '').trim())
}

/** 工单文档：字段与 lib/ticket.js 的工单一致，另外带 childSessionId/targetSessionId/adopted。 */
export function childTicketDoc({ childSessionId, parentSessionId, workspaceId, label, records, running, now = Date.now() }) {
  const cls = classifyChild({ records, label })
  const cleanLabel = String(label ?? '').trim()
  const title = (!labelIsPlaceholder(cleanLabel) ? cleanLabel : (cls.prompt.split('\n').find(Boolean) ?? '子智能体任务'))
    .slice(0, 80)
  return {
    id: childTicketId(childSessionId),
    source: CHILD_SOURCE,
    kind: CHILD_KIND,
    thread: childSessionId,
    actor: 'subagent',
    title,
    body: cls.prompt.slice(0, 400),
    url: '',
    at: now,
    status: running ? 'running' : 'done',
    createdAt: now,
    updatedAt: now,
    sessionId: null,
    workdir: null,
    branch: null,
    attempts: 1,
    lastError: null,
    report: running ? null : { status: 'done', summary: `子智能体已完成：${title}`, question: '', link: '' },
    relayed: {},
    childSessionId,
    targetSessionId: parentSessionId,
    workspaceId,
    adopted: true,
    seenAt: now,
    ended: running ? null : now,
    archivedAt: null,
  }
}
