import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendJournal, notesBlock, notesDirOf, readNotes } from '../../lib/role-notes.js'

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roles-notes-'))
}

test('role-notes：目录落在 <workspace>/docs/角色笔记/<role>', () => {
  const ws = tempWorkspace()
  assert.equal(notesDirOf(ws, 'plugin-engineer'), path.join(ws, 'docs', '角色笔记', 'plugin-engineer'))
})

test('role-notes：没有笔记时读出来是空的，notesBlock 也是空串', () => {
  const ws = tempWorkspace()
  const notes = readNotes(ws, 'qa')
  assert.equal(notes.facts, '')
  assert.deepEqual(notes.journal, [])
  assert.equal(notesBlock(ws, 'qa'), '')
})

test('role-notes：appendJournal 只追加，一条一行', () => {
  const ws = tempWorkspace()
  appendJournal(ws, 'qa', '第一条')
  appendJournal(ws, 'qa', '第二条')
  const file = path.join(notesDirOf(ws, 'qa'), '日记.md')
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('- '))
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\- \d{4}-\d{2}-\d{2}T.*第一条$/)
  assert.match(lines[1], /第二条$/)
})

test('role-notes：notesBlock 带事实全文与最近日记（默认 5 条）', () => {
  const ws = tempWorkspace()
  fs.mkdirSync(notesDirOf(ws, 'qa'), { recursive: true })
  fs.writeFileSync(path.join(notesDirOf(ws, 'qa'), '事实.md'), '# 事实\n- 单测先跑\n- 不碰 profile\n')
  for (let index = 1; index <= 7; index += 1) appendJournal(ws, 'qa', `第 ${index} 条`)
  const block = notesBlock(ws, 'qa')
  assert.match(block, /【事实】/)
  assert.match(block, /单测先跑/)
  assert.match(block, /【最近日记】/)
  assert.match(block, /第 7 条/)
  assert.doesNotMatch(block, /第 2 条/)
})
