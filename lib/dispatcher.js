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
 * - 这里只 warn 不抛错：工具面收敛失败不应该让整个会话起不来；整批被拒时逐个重试。
 */

export const name = 'dsh-superagent-yh-dispatcher'

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const keep = new Set(Array.isArray(config?.keep) ? config.keep : [])
  let denied

  try {
    denied = ctx.tools
      .definitions()
      .map((tool) => tool?.name)
      .filter((toolName) => typeof toolName === 'string')
      .filter((toolName) => toolName !== 'run_code' && !keep.has(toolName))
  } catch (error) {
    ctx.logger?.warn?.('dispatcher: cannot list global tools: %s', error?.message ?? String(error))
    return
  }

  if (denied.length === 0) {
    ctx.logger?.info?.('dispatcher: no global tool to hide')
    return
  }

  const hide = (names) => ctx.effect(() => ctx.tools.restrict({ deny: names }))

  try {
    hide(denied)
    ctx.logger?.info?.('dispatcher: hid %d global tool(s): %s', denied.length, denied.join(','))
    return
  } catch (error) {
    ctx.logger?.warn?.('dispatcher: batch restrict failed (%s), retrying one by one', error?.message ?? String(error))
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
  if (failed.length > 0) ctx.logger?.warn?.('dispatcher: could not hide %s', failed.join(' | '))
}
