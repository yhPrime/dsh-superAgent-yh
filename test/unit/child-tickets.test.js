import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyChild, firstTaskPrompt, childTicketDoc, childTicketId, labelIsPlaceholder, textOfContent, CHILD_TICKET_PREFIX,
} from '../../lib/child-tickets.js'

const userMessage = (text) => ({ event: { type: 'user/message', data: { content: [{ type: 'text', text }] } } })
const toolCall = { event: { type: 'tool/call', data: { name: 'ops_bash' } } }

test('firstTaskPrompt：取首条真人任务，跳过宿主提醒尾段与元信息', () => {
  const records = [
    userMessage('<system reminder>忽略我</system reminder>'),
    userMessage('把 README 的安装说明补齐，并跑一遍单测确认没红。\nYour final answer is delivered automatically: done'),
  ]
  assert.equal(firstTaskPrompt(records), '把 README 的安装说明补齐，并跑一遍单测确认没红。')
  assert.equal(firstTaskPrompt([]), '')
})

test('textOfContent：字符串与 blocks 都能取文本', () => {
  assert.equal(textOfContent('abc'), 'abc')
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOfContent(undefined), '')
})

test('classifyChild：有工具调用就是真工单（哪怕 prompt 很短）', () => {
  const out = classifyChild({ records: [userMessage('修一下'), toolCall], label: '修一下' })
  assert.equal(out.ticket, true)
  assert.equal(out.reason, 'tools')
  assert.equal(out.toolCalls, 1)
})

test('classifyChild：回声/占位是噪音', () => {
  const echo = classifyChild({
    records: [userMessage('只回复「ok」。Your final answer is delivered automatically: done')],
    label: '空占位',
  })
  assert.equal(echo.ticket, false)
  assert.equal(echo.reason, 'echo')
})

test('classifyChild：够长的任务且 label 像样 → 工单；太薄 → 噪音', () => {
  const long = '把控制台里工作空间卡的占用进度条改成按字节显示，并补一条单测覆盖空上下文的情况。'
  const longer = `${long}${long}`
  assert.equal(classifyChild({ records: [userMessage(long)], label: '控制台占用显示' }).ticket, true)
  assert.equal(classifyChild({ records: [userMessage(longer)], label: '空占位' }).ticket, true, '占位 label 时内容 ≥ 80 字符也认')
  assert.equal(classifyChild({ records: [userMessage(long)], label: '空占位' }).ticket, false, '占位 label + 仅 40 字符不认')
  assert.equal(classifyChild({ records: [userMessage('算一下 1+1')], label: '算一下' }).reason, 'too-thin')
  const unknown = classifyChild({ records: [], label: '空' })
  assert.equal(unknown.reason, 'no-events')
  assert.equal(unknown.unknown, true, '读不到事件不能当噪音')
})

test('childTicketDoc：字段与工单一致，带 childSessionId/targetSessionId', () => {
  const doc = childTicketDoc({
    childSessionId: 'c1',
    parentSessionId: 's1',
    workspaceId: 'w1',
    label: '修标题风暴',
    records: [toolCall],
    running: true,
    now: 100,
  })
  assert.equal(doc.id, `${CHILD_TICKET_PREFIX}c1`)
  assert.equal(childTicketId('c1'), 'subagent:c1')
  assert.equal(doc.source, 'subagent')
  assert.equal(doc.kind, 'task')
  assert.equal(doc.status, 'running')
  assert.equal(doc.childSessionId, 'c1')
  assert.equal(doc.targetSessionId, 's1')
  assert.equal(doc.workspaceId, 'w1')
  assert.equal(doc.title, '修标题风暴')
  assert.equal(doc.report, null)
  assert.equal(doc.adopted, true)
})

test('labelIsPlaceholder：占位 label 不拿来当标题', () => {
  assert.equal(labelIsPlaceholder('空占位'), true)
  assert.equal(labelIsPlaceholder('  '), true)
  assert.equal(labelIsPlaceholder('修标题风暴'), false)
})
