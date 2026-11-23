/**
 * 配置校验与默认值。
 * 原则：默认 dryRun，未启用源不注册；配置不合法就抛错（fail-closed），不静默降级。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SOURCE = {
  enabled: false,
}

export const DEFAULT_GITHUB = {
  ...DEFAULT_SOURCE,
  repo: '',
  labels: [],
  assignee: '',
  authors: [],
  token: '',
  apiBase: 'https://api.github.com',
  confirmWrites: false,
}

export const DEFAULT_FEISHU = {
  ...DEFAULT_SOURCE,
  appId: '',
  appSecret: '',
  chatIds: [],
  authors: [],
  botOpenId: '',
  requireMention: true,
  apiBase: 'https://open.feishu.cn',
  confirmWrites: false,
}

export const DEFAULT_QQ = {
  ...DEFAULT_SOURCE,
  mode: 'official',
}

export const DEFAULTS = {
  dryRun: true,
  stateDir: null,
  pollIntervalMs: 60_000,
  horizonDays: 14,
  maxWorkers: 1,
  mainSessionId: '',
  workerPreset: 'standard',
  workerTimeoutMs: 30 * 60 * 1000,
  maxTicketsPerHour: 10,
  cooldownMs: 60_000,
  repoPath: '',
  workRoot: null,
  baseRef: 'HEAD',
  sources: {
    github: DEFAULT_GITHUB,
    feishu: DEFAULT_FEISHU,
    qq: DEFAULT_QQ,
  },
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
const asStringList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [])

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function resolveStateDir(input) {
  if (input) return input
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-superagent-yh')
}

export function normalizeConfig(raw = {}) {
  if (!isObject(raw)) throw new ConfigError('config 必须是对象')
  const sourcesRaw = isObject(raw.sources) ? raw.sources : {}

  const github = { ...DEFAULT_GITHUB, ...(isObject(sourcesRaw.github) ? sourcesRaw.github : {}) }
  github.labels = asStringList(github.labels)
  github.authors = asStringList(github.authors)
  github.assignee = asString(github.assignee).trim()
  github.repo = asString(github.repo).trim()
  github.token = asString(github.token)
  github.apiBase = asString(github.apiBase, DEFAULT_GITHUB.apiBase).replace(/\/+$/, '')

  const feishu = { ...DEFAULT_FEISHU, ...(isObject(sourcesRaw.feishu) ? sourcesRaw.feishu : {}) }
  feishu.chatIds = asStringList(feishu.chatIds)
  feishu.authors = asStringList(feishu.authors)
  feishu.botOpenId = asString(feishu.botOpenId).trim()
  feishu.requireMention = feishu.requireMention !== false
  feishu.apiBase = asString(feishu.apiBase, DEFAULT_FEISHU.apiBase).replace(/\/+$/, '')

  const qq = { ...DEFAULT_QQ, ...(isObject(sourcesRaw.qq) ? sourcesRaw.qq : {}) }
  qq.mode = asString(qq.mode, 'official')

  const config = {
    dryRun: raw.dryRun !== false,
    stateDir: resolveStateDir(asString(raw.stateDir)),
    pollIntervalMs: Number.isFinite(raw.pollIntervalMs) ? Math.max(1000, Math.trunc(raw.pollIntervalMs)) : DEFAULTS.pollIntervalMs,
    horizonDays: Number.isFinite(raw.horizonDays) && raw.horizonDays > 0 ? raw.horizonDays : DEFAULTS.horizonDays,
    maxWorkers: Number.isFinite(raw.maxWorkers) ? Math.trunc(raw.maxWorkers) : DEFAULTS.maxWorkers,
    mainSessionId: asString(raw.mainSessionId).trim(),
    workerPreset: asString(raw.workerPreset, DEFAULTS.workerPreset).trim() || DEFAULTS.workerPreset,
    workerTimeoutMs: Number.isFinite(raw.workerTimeoutMs) && raw.workerTimeoutMs > 0 ? Math.trunc(raw.workerTimeoutMs) : DEFAULTS.workerTimeoutMs,
    maxTicketsPerHour: Number.isFinite(raw.maxTicketsPerHour) && raw.maxTicketsPerHour > 0 ? Math.trunc(raw.maxTicketsPerHour) : DEFAULTS.maxTicketsPerHour,
    cooldownMs: Number.isFinite(raw.cooldownMs) && raw.cooldownMs >= 0 ? Math.trunc(raw.cooldownMs) : DEFAULTS.cooldownMs,
    repoPath: asString(raw.repoPath).trim(),
    workRoot: asString(raw.workRoot).trim() || null,
    baseRef: asString(raw.baseRef, DEFAULTS.baseRef).trim() || DEFAULTS.baseRef,
    sources: { github, feishu, qq },
  }
  config.workRoot = config.workRoot || join(config.stateDir, 'work')

  validate(config)
  return config
}

export function validate(config) {
  if (config.maxWorkers !== 1) {
    throw new ConfigError(`maxWorkers 目前只支持 1（串行执行），收到 ${config.maxWorkers}`)
  }
  const enabled = Object.entries(config.sources).filter(([, source]) => source.enabled)
  if (enabled.length === 0) return config

  if (!config.repoPath && !config.dryRun) {
    throw new ConfigError('enabled 源且 dryRun=false 时必须配置 repoPath（worker 需要本地克隆做 worktree）')
  }

  for (const [kind, source] of enabled) {
    if (kind === 'github') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(source.repo)) {
        throw new ConfigError(`sources.github.repo 必须是 owner/name，收到 "${source.repo}"`)
      }
    }
    if (kind === 'feishu') {
      if (!source.appId || !source.appSecret) {
        throw new ConfigError('sources.feishu 启用时必须配置 appId 与 appSecret')
      }
      if (source.chatIds.length === 0) {
        throw new ConfigError('sources.feishu 启用时至少配置一个 chatIds')
      }
    }
    if (kind === 'qq') {
      // 预留源：启用即 fail-closed，不静默降级（M3 只出空实现）。
      throw new ConfigError(
        source.mode === 'personal'
          ? 'QQ 个人号源未接入：等用户交付插件后按 docs/source-qq.md 移植（fail-closed）'
          : 'QQ 官方机器人源未接入：见 docs/source-qq.md（fail-closed）',
      )
    }
  }
  return config
}

/** 把配置里出现过的密钥交给 redact 预登记，保证日志不落明文。 */
export function secretsOf(config) {
  const list = []
  for (const source of Object.values(config.sources)) {
    if (source.token) list.push(source.token)
    if (source.appSecret) list.push(source.appSecret)
  }
  return list.filter(Boolean)
}
