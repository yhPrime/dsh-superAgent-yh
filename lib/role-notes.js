/**
 * 常驻角色的记忆笔记（D47）：
 * - `<workspace>/docs/角色笔记/<role>/日记.md`：一行一条，只追加，不重写；
 * - `<workspace>/docs/角色笔记/<role>/事实.md`：提炼后的结论，角色自己维护（插件只读）。
 * 派活前注入「事实全文 + 最近 5 条日记」，减少每次重新交代背景；压缩前由维护器补日记。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const NOTES_DIR = 'docs/角色笔记'
const JOURNAL = '日记.md'
const FACTS = '事实.md'
const TAIL_LINES = 5

export function notesDirOf(workspacePath, role) {
  return join(resolve(workspacePath), NOTES_DIR, String(role).replace(/[\\/:*?"<>|]/g, '-'))
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/** 读取笔记：事实全文 + 最近 N 条日记（空行/标题不算）。 */
export function readNotes(workspacePath, role, { tail = TAIL_LINES } = {}) {
  const dir = notesDirOf(workspacePath, role)
  const facts = readText(join(dir, FACTS)).trim()
  const lines = readText(join(dir, JOURNAL))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return { facts, journal: lines.slice(-tail), dir }
}

/** 追加一条日记（自动建目录）；失败不阻断派活，返回 false 交给调用方记日志。 */
export function appendJournal(workspacePath, role, text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return false
  try {
    const dir = notesDirOf(workspacePath, role)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, JOURNAL), `- ${new Date().toISOString()} ${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 派活前注入的上下文块；没有笔记返回空串（worker 不因缺笔记而多读一圈）。 */
export function notesBlock(workspacePath, role) {
  const { facts, journal, dir } = readNotes(workspacePath, role)
  if (!facts && journal.length === 0) return ''
  const parts = [`以下是角色「${role}」的长期笔记（目录：${dir}），请继续沿用，不要重新摸索：`]
  if (facts) parts.push(`【事实】\n${facts}`)
  if (journal.length) parts.push(`【最近日记】\n${journal.map((line) => `- ${line}`).join('\n')}`)
  return parts.join('\n\n')
}
