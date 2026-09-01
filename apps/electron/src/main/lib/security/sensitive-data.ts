const SENSITIVE_DATA_KEY = /^(?:(?:x[-_])?api[-_]?key|auth(?:orization)?|cookie|set-cookie|password|passwd|secret|session|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|x[-_]auth[-_]?token|proxy-authorization)$/i

interface TokenRule {
  detect: RegExp
  redact: RegExp
  replacement: string
}

const TOKEN_RULES: readonly TokenRule[] = [
  {
    detect: /\bAKIA[0-9A-Z]{16}\b/,
    redact: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED]',
  },
  {
    detect: /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    redact: /\b(?:gh[oprsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
    replacement: '[REDACTED]',
  },
  {
    detect: /\bsk-[A-Za-z0-9_-]{16,}\b/,
    redact: /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    replacement: '[REDACTED]',
  },
  {
    detect: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
    redact: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    detect: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    redact: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED]',
  },
]

const ASSIGNED_SECRET_SOURCE = String.raw`(api[-_]?key|access[-_]?token|password|secret|token)(\s*[:=]\s*)[^&\s"']+`
const ASSIGNED_SECRET_DETECTION = /(?:api[-_]?key|access[-_]?token|password|secret|token)\s*[:=]\s*([^&\s"']{12,})/gi

function containsAssignedSecret(value: string): boolean {
  for (const match of value.matchAll(ASSIGNED_SECRET_DETECTION)) {
    const candidate = match[1] ?? ''
    if (/^(?:process\.env\.|import\.meta\.env\.|env\.|os\.environ|\$\{|<|\[)/i.test(candidate)) continue
    if (/(?:example|placeholder|your[_-])/i.test(candidate)) continue
    return true
  }
  return false
}

export function isSensitiveDataKey(key: string): boolean {
  return SENSITIVE_DATA_KEY.test(key)
}

/** 只识别高置信度凭据形态，普通文本和代码标识符继续放行。 */
export function containsObviousSecret(value: string, options: { includeAssignments?: boolean } = {}): boolean {
  if (TOKEN_RULES.some(({ detect }) => detect.test(value))) return true
  return options.includeAssignments === true && containsAssignedSecret(value)
}

function redactHttpUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return value
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return value
  if (parsed.username || parsed.password) {
    parsed.username = ''
    parsed.password = ''
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveDataKey(key)) parsed.searchParams.set(key, '[REDACTED]')
  }
  return parsed.toString()
}

/** 脱敏已识别凭据，同时保留周边诊断文本。 */
export function redactSensitiveString(raw: string): string {
  let value = redactHttpUrl(raw)
  for (const { redact, replacement } of TOKEN_RULES) value = value.replace(redact, replacement)
  return value.replace(new RegExp(ASSIGNED_SECRET_SOURCE, 'gi'), '$1$2[REDACTED]')
}
