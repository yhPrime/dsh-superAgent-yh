/**
 * QQ 源（预留）：只出契约与空实现，启用即 fail-closed。
 * 两种模式：official（官方 QQ 机器人）/ personal（QQ 号，等用户交付插件后按 docs/source-qq.md 移植）。
 */
import { SourceError } from './contract.js'

export const QQ_MODES = ['official', 'personal']

export function createQqSource(cfg) {
  if (cfg?.mode === 'personal') {
    throw new SourceError('QQ 个人号源未接入：等用户交付插件后按 docs/source-qq.md 移植（fail-closed）')
  }
  throw new SourceError('QQ 官方机器人源未接入：见 docs/source-qq.md（fail-closed）')
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
