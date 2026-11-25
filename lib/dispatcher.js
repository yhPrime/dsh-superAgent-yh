/**
 * 单会话「纯调度」preset 的守卫（D30 / D47）。
 *
 * 这个插件只挂进 `dsh-superagent-yh-dispatcher` preset，所以它的 ctx 就是单会话的
 * agent scope。它把 profile 级全局工具（`ops_bash`、`exp_recall` 等 preset 管不到的
 * 工具）在这个会话里全部隐藏，只留下 preset 自己挂的工具和明确放行集。
 *
 * 注意：
 * - `tools.restrict` 只作用于当前 scope，spawn 出来的子智能体有自己的 scope，不受影响（E12.21）。
 * - `run_code` 是 PTC 传输的保留名，restrict 不允许出现，必须排除。
 * - 这里只告警不抛错：工具面收敛失败不应该让整个会话起不来；整批被拒时逐个重试。
 * - 告警除 ctx.logger 外，还要经 diagnostics 落到插件自己的日志与 state.lastError，保证可见。
 * - D47：apply 时只挡得住当时已注册的全局工具；`compress`/`acp_*` 等是 manifest 就绪后
 *   异步注册的，必须订阅 `ctx.root` 的 `tools/change` 做增量重放。`applied` 去重，
 *   否则新增 restriction 本身再次触发 tools/change → 死循环。
 */

import { reportDispatcherFailure } from './diagnostics.js'

export const name = 'dsh-superagent-yh-dispatcher'

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const keep = new Set(Array.isArray(config?.keep) ? config.keep : [])
  // 已成功 restrict 的名字：重放只 deny 新增的，防止 tools/change 自触发死循环。
  const applied = new Set()
  // 既有 ctx.logger 告警 + 插件自己的日志/状态，两路都留痕。
  const fail = (message, level = 'warn') => {
    ctx.logger?.warn?.(`dispatcher: ${message}`)
    reportDispatcherFailure(message, level)
  }
  const hide = (names) => ctx.effect(() => ctx.tools.restrict({ deny: names }))
  const mark = (names) => {
    for (const toolName of names) applied.add(toolName)
  }
  /** 当前 scope 里「还没被挡、也不在 keep」的全局工具名。 */
  const pendingDenials = () =>
    ctx.tools
      .definitions()
      .map((tool) => tool?.name)
      .filter((toolName) => typeof toolName === 'string')
      .filter((toolName) => toolName !== 'run_code' && !keep.has(toolName) && !applied.has(toolName))

  /**
   * 注册变化后的增量重放：只处理快照之后才出现、且不在 keep 里的名字。
   * 逐个失败不抛出（只 warn），下一次 tools/change 还会再试。
   */
  const denyNow = (reason = 'tools/change') => {
    let names
    try {
      names = pendingDenials()
    } catch (error) {
      fail(`cannot list global tools after ${reason}: ${error?.message ?? String(error)}`)
      return 0
    }
    if (names.length === 0) return 0
    try {
      hide(names)
      mark(names)
      ctx.logger?.info?.('dispatcher: hid %d global tool(s) after %s: %s', applied.size, reason, names.join(','))
      return names.length
    } catch (error) {
      fail(`batch restrict failed after ${reason} (${error?.message ?? String(error)}), retrying one by one`)
    }
    let hidden = 0
    const failed = []
    for (const toolName of names) {
      try {
        hide([toolName])
        applied.add(toolName)
        hidden += 1
      } catch (error) {
        failed.push(`${toolName}: ${error?.message ?? String(error)}`)
      }
    }
    if (hidden > 0) {
      ctx.logger?.info?.('dispatcher: hid %d/%d new global tool(s) individually after %s', hidden, names.length, reason)
    }
    if (failed.length > 0) {
      fail(`could not hide ${failed.length}/${names.length} new global tool(s) after ${reason}: ${failed.join(' | ')}`, 'error')
    }
    return hidden
  }

  // 第一段：apply 时刻的立即收敛（与 0.9.4 相同）。
  let denied = []
  try {
    denied = pendingDenials()
  } catch (error) {
    // 列不出工具也要继续订阅：注册事件到达后还能补收敛。
    fail(`cannot list global tools: ${error?.message ?? String(error)}`)
  }

  if (denied.length === 0) {
    // 完全没收敛：没有可隐藏的工具也记一条 warn，不静默 fail-open。
    fail('no global tool to hide (nothing converged)')
  } else {
    try {
      hide(denied)
      mark(denied)
      ctx.logger?.info?.('dispatcher: hid %d global tool(s): %s', denied.length, denied.join(','))
    } catch (error) {
      fail(`batch restrict failed (${error?.message ?? String(error)}), retrying one by one`)
      let hidden = 0
      const failed = []
      for (const toolName of denied) {
        try {
          hide([toolName])
          applied.add(toolName)
          hidden += 1
        } catch (error2) {
          failed.push(`${toolName}: ${error2?.message ?? String(error2)}`)
        }
      }
      ctx.logger?.info?.('dispatcher: hid %d/%d global tool(s) individually', hidden, denied.length)
      if (failed.length > 0) {
        fail(`could not hide ${failed.length}/${denied.length} global tool(s): ${failed.join(' | ')}`, 'error')
      }
    }
  }

  // 第二段：订阅根 ctx 的注册变化（`ctx.on` 收不到父级事件，必须 `ctx.root.on`）。
  // `ctx.effect` 保证 preset 卸载时把监听一起回收。
  try {
    if (!ctx.root?.on) throw new Error('ctx.root.on is unavailable')
    ctx.effect(() => ctx.root.on('tools/change', denyNow), 'dispatcher-tools-replay')
  } catch (error) {
    fail(`cannot subscribe tools/change: ${error?.message ?? String(error)}`)
  }
}
