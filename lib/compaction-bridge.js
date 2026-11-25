/**
 * compaction 桥（D48）：把 preset 组内（隔离 realm）的 `ctx.compaction` 暴露给 preset 外的单会话维护器。
 *
 * 背景：`cordis:group` + `isolate: { compaction: true }` 之后，compaction 服务只在该组子 ctx 里可见；
 * 单会话维护器跑在插件根 ctx，`agentPresets.serviceFor(agent, 'compaction')` 在真机上拿不到。
 * 桥插件挂进同一个 group，按 `config.preset` 把服务登记到模块级 Map，维护器再按 preset id 取。
 *
 * 这是「读」侧补充，不改变 compaction 的挂载方式。
 */

export const name = 'dsh-superagent-yh-compaction-bridge'

export const inject = ['compaction']

/** presetId → compaction 服务；同一 preset 重载时就地替换。 */
const engines = new Map()

/**
 * 登记一个 preset 的 compaction 引擎，返回注销函数。
 * 注销时只在 Map 里仍是同一个引擎才删，避免旧 ctx 卸载把新 ctx 的服务删掉。
 */
export function registerCompactionEngine(presetId, engine) {
  if (!presetId || !engine) return () => {}
  engines.set(presetId, engine)
  return () => {
    if (engines.get(presetId) === engine) engines.delete(presetId)
  }
}

/** 按 preset id 取桥登记的 compaction 引擎；没有就返回 null。 */
export function compactionEngineFor(presetId) {
  if (!presetId) return null
  return engines.get(presetId) ?? null
}

export function apply(ctx, config = {}) {
  const presetId = config?.preset
  if (!presetId) {
    ctx.logger?.warn?.('compaction-bridge: config.preset 为空，桥不生效')
    return
  }
  const engine = ctx.compaction
  if (!engine) {
    ctx.logger?.warn?.(`compaction-bridge: preset ${presetId} 没有 compaction 服务`)
    return
  }
  // ctx.effect 保证 preset 卸载/重载时把登记一起撤掉。
  ctx.effect(() => registerCompactionEngine(presetId, engine), 'compaction-bridge-register')
}
