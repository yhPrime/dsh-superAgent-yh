/**
 * 脱敏：所有离开插件的文本（日志、state、面板、主线消息）都先过 redact()。
 * 规则宁多勿少：已知密钥整串替换；常见 token 形态按前缀替换。
 */
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<=(?:token|secret|password|appSecret|apiKey)\s*[=:：]\s*)[^\s,;'"]{6,}/gi,
  /(?<="(?:token|secret|password|appSecret|apiKey)"\s*:\s*")[^"]{6,}/gi,
]

export function createRedactor(secrets = []) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= 4)
  return function redact(value) {
    if (typeof value === 'string') {
      let text = value
      for (const secret of known) text = text.split(secret).join('[REDACTED]')
      for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[REDACTED]')
      return text
    }
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) out[key] = redact(item)
      return out
    }
    return value
  }
}
