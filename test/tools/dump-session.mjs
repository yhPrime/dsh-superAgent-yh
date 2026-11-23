/**
 * 调试/验收用：解码 DSH 的 session.v4.jsonl.zstd（多 zstd frame 拼接），打印关键事件。
 * 用法：node test/tools/dump-session.mjs <session.v4.jsonl.zstd 路径|会话目录> [--all]
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const input = process.argv[2]
const all = process.argv.includes('--all')
if (!input) {
  console.error('用法：node dump-session.mjs <session.v4.jsonl.zstd|会话目录> [--all]')
  process.exit(2)
}

const file = statSync(input).isDirectory() ? join(input, 'session.v4.jsonl.zstd') : input
const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
for (let i = 0; i <= buf.length - 4; i++) if (buf.subarray(i, i + 4).equals(MAGIC)) frames.push(i)

let text = ''
for (let k = 0; k < frames.length; k++) {
  const end = k + 1 < frames.length ? frames[k + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(frames[k], end)).toString('utf8')
  } catch (error) {
    console.error(`frame ${k} decode failed: ${error.message}`)
  }
}

const events = text
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const textOf = (message) => (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')

for (const event of events) {
  const { type, seq, data } = event
  if (!all && !['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(type)) continue
  let detail = ''
  if (type === 'user/message') detail = textOf(data).slice(0, 160)
  else if (type === 'assistant/message') detail = textOf(data.message).slice(0, 160)
  else if (type === 'tool/call') detail = `${data.name} ${String(data.arguments).slice(0, 160)}`
  else if (type === 'tool/result') detail = textOf(data.message).slice(0, 200)
  else if (type === 'turn/end') detail = JSON.stringify(data.reason)
  console.log(`#${seq} ${type} ${detail}`)
}
