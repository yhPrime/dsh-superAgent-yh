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
  assessment: 'off',
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
  assessment: 'off',
}

export const DEFAULT_QQ = {
  ...DEFAULT_SOURCE,
  mode: 'official',
  requireAt: true,
  allowedGroups: [],
  authors: [],
  confirmWrites: false,
  // QQ 消息五花八门：默认让模型研判是不是真任务（D22）。
  assessment: 'agent',
  personal: {
    httpUrl: '',
    wsUrl: '',
    httpToken: '',
    wsToken: '',
    selfId: '',
    snowLumaDir: '',
  },
  official: {
    host: '127.0.0.1',
    port: 0,
    token: '',
    allowRemote: false,
  },
}

export const DEFAULT_SINGLE_SESSION = {
  enabled: false,
  idleMinutes: 30,
  pressureRatio: 0.5,
  aggressive: false,
  keepRecentTurns: 2,
  autoCreate: true,
  sessionIdPrefix: 'intake',
}

export const DEFAULTS = {
  dryRun: true,
  stateDir: null,
  pollIntervalMs: 60_000,
  startupDelayMs: 5000,
  horizonDays: 14,
  maxWorkers: 1,
  mainSessionId: '',
  workerPreset: 'dsh-superagent-yh-worker',
  workerTimeoutMs: 30 * 60 * 1000,
  maxTicketsPerHour: 10,
  cooldownMs: 60_000,
  repoPath: '',
  workRoot: null,
  baseRef: 'HEAD',
  orchestrator: 'agent',
  orchestratorTimeoutMs: 60_000,
  assessment: { provider: '', model: '', timeoutMs: 20_000 },
  singleSession: DEFAULT_SINGLE_SESSION,
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
  qq.requireAt = qq.requireAt !== false
  qq.allowedGroups = asStringList(qq.allowedGroups).map(String)
  qq.authors = asStringList(qq.authors).map(String)
  qq.confirmWrites = qq.confirmWrites === true
  qq.personal = { ...DEFAULT_QQ.personal, ...(isObject(qq.personal) ? qq.personal : {}) }
  qq.personal.httpUrl = asString(qq.personal.httpUrl).replace(/\/+$/, '')
  qq.personal.wsUrl = asString(qq.personal.wsUrl)
  qq.personal.httpToken = asString(qq.personal.httpToken)
  qq.personal.wsToken = asString(qq.personal.wsToken)
  qq.personal.selfId = asString(qq.personal.selfId).trim()
  qq.personal.snowLumaDir = asString(qq.personal.snowLumaDir).trim()
  qq.official = { ...DEFAULT_QQ.official, ...(isObject(qq.official) ? qq.official : {}) }
  qq.official.host = asString(qq.official.host, '127.0.0.1').trim() || '127.0.0.1'
  qq.official.port = Number.isFinite(qq.official.port) ? Math.trunc(qq.official.port) : 0
  qq.official.token = asString(qq.official.token)
  qq.official.allowRemote = qq.official.allowRemote === true

  github.assessment = github.assessment === 'agent' ? 'agent' : 'off'
  feishu.assessment = feishu.assessment === 'agent' ? 'agent' : 'off'
  qq.assessment = qq.assessment === 'off' ? 'off' : 'agent'

  const single = { ...DEFAULT_SINGLE_SESSION, ...(isObject(raw.singleSession) ? raw.singleSession : {}) }
  single.enabled = single.enabled === true
  single.aggressive = single.aggressive === true
  single.autoCreate = single.autoCreate !== false
  single.idleMinutes = Number.isFinite(single.idleMinutes) ? Math.trunc(single.idleMinutes) : DEFAULT_SINGLE_SESSION.idleMinutes
  single.pressureRatio = Number.isFinite(single.pressureRatio) ? single.pressureRatio : DEFAULT_SINGLE_SESSION.pressureRatio
  single.keepRecentTurns = Number.isFinite(single.keepRecentTurns) ? Math.trunc(single.keepRecentTurns) : DEFAULT_SINGLE_SESSION.keepRecentTurns
  single.sessionIdPrefix = asString(single.sessionIdPrefix, DEFAULT_SINGLE_SESSION.sessionIdPrefix).trim() || DEFAULT_SINGLE_SESSION.sessionIdPrefix

  const config = {
    dryRun: raw.dryRun !== false,
    stateDir: resolveStateDir(asString(raw.stateDir)),
    pollIntervalMs: Number.isFinite(raw.pollIntervalMs) ? Math.max(1000, Math.trunc(raw.pollIntervalMs)) : DEFAULTS.pollIntervalMs,
    startupDelayMs: Number.isFinite(raw.startupDelayMs) && raw.startupDelayMs >= 0 ? Math.trunc(raw.startupDelayMs) : DEFAULTS.startupDelayMs,
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
    orchestrator: raw.orchestrator === 'rules' ? 'rules' : 'agent',
    orchestratorTimeoutMs: Number.isFinite(raw.orchestratorTimeoutMs) && raw.orchestratorTimeoutMs > 0 ? Math.trunc(raw.orchestratorTimeoutMs) : DEFAULTS.orchestratorTimeoutMs,
    assessment: {
      provider: asString(raw.assessment?.provider).trim(),
      model: asString(raw.assessment?.model).trim(),
      timeoutMs: Number.isFinite(raw.assessment?.timeoutMs) && raw.assessment.timeoutMs > 0 ? Math.trunc(raw.assessment.timeoutMs) : DEFAULTS.assessment.timeoutMs,
    },
    singleSession: single,
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
  const single = config.singleSession
  if (single) {
    if (!(single.idleMinutes >= 1)) throw new ConfigError(`singleSession.idleMinutes 必须 ≥ 1，收到 ${single.idleMinutes}`)
    if (!(single.pressureRatio > 0 && single.pressureRatio <= 1)) {
      throw new ConfigError(`singleSession.pressureRatio 必须在 (0, 1] 内，收到 ${single.pressureRatio}`)
    }
    if (!(single.keepRecentTurns >= 0)) throw new ConfigError(`singleSession.keepRecentTurns 必须 ≥ 0，收到 ${single.keepRecentTurns}`)
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(single.sessionIdPrefix)) {
      throw new ConfigError(`singleSession.sessionIdPrefix 只能是字母开头的字母数字短横线，收到 "${single.sessionIdPrefix}"`)
    }
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
      if (source.mode === 'personal') {
        if (!source.personal.httpUrl && !source.personal.wsUrl) {
          throw new ConfigError('sources.qq.personal 至少配置 httpUrl 或 wsUrl（OneBot v11 网关地址）')
        }
        if (source.requireAt && !source.personal.selfId) {
          throw new ConfigError('sources.qq.personal.requireAt=true 时必须配置 selfId（用来判断 @ 的是不是机器人）')
        }
      } else if (source.mode === 'official') {
        if (!source.official.token) throw new ConfigError('sources.qq.official.token 必填（roost-host/1 鉴权；空 token 拒绝启动）')
        if (!source.official.port) throw new ConfigError('sources.qq.official.port 必填（qq-bot-roost 的外接协议端口）')
        const local = ['127.0.0.1', 'localhost', '::1', '[::1]']
        if (!source.official.allowRemote && !local.includes(source.official.host)) {
          throw new ConfigError(`sources.qq.official.host=${source.official.host} 不是回环地址；远程需显式 allowRemote: true`)
        }
      } else {
        throw new ConfigError(`sources.qq.mode 只能是 personal / official，收到 "${source.mode}"`)
      }
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
    if (source.personal?.httpToken) list.push(source.personal.httpToken)
    if (source.personal?.wsToken) list.push(source.personal.wsToken)
    if (source.official?.token) list.push(source.official.token)
  }
  return list.filter(Boolean)
}
