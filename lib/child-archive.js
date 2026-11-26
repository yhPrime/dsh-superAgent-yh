/**
 * 子会话归档的共用实现（D40 单会话兜底 + D51 delegate 终态处置）。
 *
 * 宿主没有 retention / gc，子会话不会自己消失；插件这边只有一种收口方式：
 * `archiveSession(id, { stopActivity: true })`（软删，数据一行不删，可 unarchive 恢复）。
 * 失败按「3 次 + 10 分钟窗口」退避，避免每轮对同一个坏 id 刷日志；状态共用
 * `store.state.singleSessionChildArchive`，失败写 `state.lastError` 供状态面查看。
 */
const MAX_ATTEMPTS = 3
const BACKOFF_MS = 10 * 60_000

/**
 * @param {{ state: object, save: () => void, log?: (message: string) => void, redact?: (value: string) => string, archive: (sessionId: string) => Promise<unknown> }} deps
 * @param {string} sessionId
 * @param {string} reason 归档原因（`idle` / `noise:*` / `settled` / `stale`）
 * @returns {Promise<boolean>} 是否归档成功（退避中直接 false）
 */
export async function archiveChildSession({ state, save, log, redact, archive }, sessionId, reason) {
  // 幂等（0.9.7）：宿主归档是软删，`listSessions` 仍会返回已归档的会话，所以只靠
  // 「还在列表里」判断会每分钟对同一批 id 重复归档、重复刷日志。这里记住已归档的 id。
  const archived = (state.singleSessionChildArchived ??= {})
  if (archived[sessionId]) return true
  const failures = (state.singleSessionChildArchive ??= {})
  const record = failures[sessionId]
  if (record && record.attempts >= MAX_ATTEMPTS && Date.now() - record.at < BACKOFF_MS) return false
  try {
    await archive(sessionId)
    delete failures[sessionId]
    archived[sessionId] = Date.now()
    save()
    log?.(`archived child ${sessionId} (${reason})`)
    return true
  } catch (error) {
    const message = redact?.(error?.message) ?? error?.message ?? String(error)
    failures[sessionId] = { attempts: (record?.attempts ?? 0) + 1, at: Date.now() }
    state.lastError = `single-session: 子会话归档失败（${sessionId}）：${message}`
    save()
    log?.(`archive child ${sessionId} failed: ${message}`)
    return false
  }
}
