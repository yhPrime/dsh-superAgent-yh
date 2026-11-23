/**
 * 状态落盘：state.json + 跨进程单写者锁 + 版本迁移。
 * 只有一个宿主进程写它；锁是防御性的，抢不到锁就 fail-closed 报错，不并发写。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_VERSION = 1

export class StoreLockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StoreLockedError'
  }
}

export function emptyState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    watermark: {},
    tickets: {},
    sourceStatus: {},
    lastError: null,
  }
}

export function migrate(state) {
  if (!state || typeof state !== 'object') return emptyState()
  if (!Number.isFinite(state.version)) return emptyState()
  // 未来版本不能降级读写。
  if (state.version > STATE_VERSION) throw new Error(`state.json 版本 ${state.version} 高于插件支持的 ${STATE_VERSION}`)
  state.watermark ??= {}
  state.tickets ??= {}
  state.sourceStatus ??= {}
  state.lastError ??= null
  state.version = STATE_VERSION
  return state
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function acquireLock(lockPath, staleMs = 30_000) {
  const body = JSON.stringify({ pid: process.pid, at: Date.now() })
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, body)
    closeSync(fd)
    return () => {
      try {
        unlinkSync(lockPath)
      } catch {
        /* 已被清理 */
      }
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  // 锁已存在：stale（进程已死或超时）才接管。
  let info = null
  try {
    info = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    info = null
  }
  const mtime = (() => {
    try {
      return statSync(lockPath).mtimeMs
    } catch {
      return 0
    }
  })()
  const stale = !info || !alive(info.pid) || Date.now() - mtime > staleMs
  if (!stale) throw new StoreLockedError(`state 目录被进程 ${info?.pid ?? '?'} 占用：${lockPath}`)
  try {
    unlinkSync(lockPath)
  } catch {
    /* 竞态下另一个进程先删了 */
  }
  const fd = openSync(lockPath, 'wx')
  writeSync(fd, body)
  closeSync(fd)
  return () => {
    try {
      unlinkSync(lockPath)
    } catch {
      /* 已被清理 */
    }
  }
}

export function openStore({ dir, lock = true, now = Date.now }) {
  mkdirSync(dir, { recursive: true })
  const logsDir = join(dir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const file = join(dir, 'state.json')
  const release = lock ? acquireLock(join(dir, '.lock')) : () => {}

  let state
  if (existsSync(file)) {
    state = migrate(JSON.parse(readFileSync(file, 'utf8')))
  } else {
    state = emptyState(now())
    atomicWrite(file, JSON.stringify(state, null, 2))
  }

  let closed = false
  return {
    dir,
    logsDir,
    file,
    get state() {
      return state
    },
    save() {
      state.updatedAt = now()
      atomicWrite(file, JSON.stringify(state, null, 2))
    },
    update(mutate) {
      const result = mutate(state)
      state.updatedAt = now()
      atomicWrite(file, JSON.stringify(state, null, 2))
      return result
    },
    close() {
      if (closed) return
      closed = true
      release()
    },
  }
}
