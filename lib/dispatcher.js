/**
 * 单会话「纯调度」preset 的守卫（D30）。
 *
 * 这个插件只挂进 `dsh-superagent-yh-dispatcher` preset，所以它的 ctx 就是单会话的
 * agent scope。它把 profile 级全局工具（`ops_bash`、`exp_recall` 等 preset 管不到的
 * 工具）在这个会话里全部隐藏，只留下 preset 自己挂的 `subagent` 和压缩命令。
 *
 * 注意：
 * - `tools.restrict` 只作用于当前 scope，spawn 出来的子智能体有自己的 scope，不受影响（E12.21）。
 * - `run_code` 是 PTC 传输的保留名，restrict 不允许出现，必须排除。
 * - 这里只告警不抛错：工具面收敛失败不应该让整个会话起不来；整批被拒时逐个重试。
 * - 告警除 ctx.logger 外，还要经 diagnostics 落到插件自己的日志与 state.lastError，保证可见。
 */

import { reportDispatcherFailure } from './diagnostics.js'

export const name = 'dsh-superagent-yh-dispatcher'

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const keep = new Set(Array.isArray(config?.keep) ? config.keep : [])
  // 既有 ctx.logger 告警 + 插件自己的日志/状态，两路都留痕。
  const fail = (message, level = 'warn') => {
    ctx.logger?.warn?.(`dispatcher: ${message}`)
    reportDispatcherFailure(message, level)
  }
  let denied

  try {
    denied = ctx.tools
      .definitions()
      .map((tool) => tool?.name)
      .filter((toolName) => typeof toolName === 'string')
      .filter((toolName) => toolName !== 'run_code' && !keep.has(toolName))
  } catch (error) {
    fail(`cannot list global tools: ${error?.message ?? String(error)}`)
    return
  }

  if (denied.length === 0) {
    // 完全没收敛：没有可隐藏的工具也记一条 warn，不静默 fail-open。
    fail('no global tool to hide (nothing converged)')
    return
  }

  const hide = (names) => ctx.effect(() => ctx.tools.restrict({ deny: names }))

  try {
    hide(denied)
    ctx.logger?.info?.('dispatcher: hid %d global tool(s): %s', denied.length, denied.join(','))
    return
  } catch (error) {
    fail(`batch restrict failed (${error?.message ?? String(error)}), retrying one by one`)
  }

  let hidden = 0
  const failed = []
  for (const toolName of denied) {
    try {
      hide([toolName])
      hidden += 1
    } catch (error) {
      failed.push(`${toolName}: ${error?.message ?? String(error)}`)
    }
  }
  ctx.logger?.info?.('dispatcher: hid %d/%d global tool(s) individually', hidden, denied.length)
  if (failed.length > 0) {
    fail(`could not hide ${failed.length}/${denied.length} global tool(s): ${failed.join(' | ')}`, 'error')
  }
}
