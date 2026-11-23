/**
 * QQ 源：personal（OneBot v11）/ official（roost-host/1）两模式。
 * 方案见《子计划书-M3-QQ.md》；都不移植第三方 bot 代码，只按公开协议实现客户端。
 */
import { SourceError } from './contract.js'
import { createPersonalQqSource } from './qq/personal.js'
import { createOfficialQqSource } from './qq/official.js'

export const QQ_MODES = ['official', 'personal']

export function createQqSource(cfg, deps = {}) {
  if (cfg?.mode === 'personal') return createPersonalQqSource(cfg, deps)
  if (cfg?.mode === 'official') return createOfficialQqSource(cfg, deps)
  throw new SourceError(`QQ mode 不支持："${cfg?.mode}"（只能是 personal / official）`)
}

/** 一致性套件用的空实现：任何调用都必须明确报“未接入”，不许静默返回空数组。 */
export function createQqPlaceholder(kind = 'official') {
  const fail = () => {
    throw new SourceError(`QQ ${kind} 源未接入（fail-closed）`)
  }
  return {
    kind: 'qq',
    mode: kind,
    capabilities: { write: true, comments: false, threads: true },
    poll: async () => fail(),
    send: async () => fail(),
    ack: async () => fail(),
  }
}
