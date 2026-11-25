/**
 * 跨 preset 诊断通道。
 *
 * dispatcher 守卫跑在单会话的 agent scope 里（preset 插件），拿不到主插件的 store / log；
 * 主插件 apply 时注册一个 sink，dispatcher 的失败信息经这里落到同一个 state.lastError
 * 与日志文件（<stateDir>/logs/dispatcher.log），面板和 /status 都能看到。
 *
 * 同一进程内同一模块实例共享（ESM 模块缓存）。没有 sink 时调用方只保留 ctx.logger 告警。
 */
let sink = null

/** 主插件注册落地通道；返回注销函数。 */
export function registerDiagnostics(next) {
  sink = typeof next === 'function' ? next : null
  return () => {
    if (sink === next) sink = null
  }
}

/** 记录一次 dispatcher 失败；返回带 `dispatcher:` 前缀的文案。 */
export function reportDispatcherFailure(message, level = 'warn') {
  const text = `dispatcher: ${String(message ?? 'unknown error')}`
  try {
    sink?.({ message: text, level })
  } catch {
    /* 诊断通道自身失败不能影响会话 */
  }
  return text
}
