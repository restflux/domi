import type { AuditEvent, AuditWriteResult } from '../audit/audit-writer.ts'
import { containsObviousSecret, isSensitiveDataKey } from '../security/sensitive-data.ts'
import type {
  ManagedWebAccessDecision,
  ManagedWebAccessPolicyLike,
} from './managed-web-access-policy.ts'

export interface ManagedWebAuditWriter {
  record(event: AuditEvent): Promise<AuditWriteResult>
}

export interface ManagedWebFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface ManagedWebAccessOptions {
  policy: ManagedWebAccessPolicyLike
  auditWriter: ManagedWebAuditWriter
  fetchImpl?: ManagedWebFetch
  maxRedirects?: number
}

export type ManagedWebEntrypoint = 'web_search' | 'web_fetch' | 'custom_http' | string

export interface ManagedWebRequestContent {
  text?: readonly string[]
  headers?: HeadersInit
  body?: BodyInit | null
  /** 仅供 main-owned executor 提交各注入 header 移除 credential references 后的精确模板结果。 */
  trustedCredentialHeaderTemplates?: Readonly<Record<string, string>>
  /** 仅供 main-owned executor 提交同一 body 移除 credential references 后的精确模板结果。 */
  trustedCredentialBodyTemplate?: string
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class ManagedWebAccessDeniedError extends Error {
  constructor(readonly decision: ManagedWebAccessDecision) {
    super(`Managed Web Access denied: ${decision.reason}`)
    this.name = 'ManagedWebAccessDeniedError'
  }
}

function targetForAudit(decision: ManagedWebAccessDecision): Record<string, string> {
  if (!decision.hostname) return { hostname: '<invalid>' }
  let protocol = ''
  let port = ''
  if (decision.normalizedUrl) {
    try {
      const parsed = new URL(decision.normalizedUrl)
      protocol = parsed.protocol.replace(':', '')
      port = parsed.port
    } catch {
      // 决策已携带稳定 hostname；审计不需要回退到原始 URL。
    }
  }
  return {
    hostname: decision.hostname,
    ...(protocol ? { protocol } : {}),
    ...(port ? { port } : {}),
  }
}

function sensitiveRequestDecision(rawUrl: string, content: ManagedWebRequestContent): ManagedWebAccessDecision | undefined {
  const hasSecretText = content.text?.some((value) => (
    containsObviousSecret(value, { includeAssignments: true })
  )) ?? false
  const bodyForSecretScan = content.trustedCredentialBodyTemplate
    ?? (typeof content.body === 'string' ? content.body : '')
  const hasSecretBody = Boolean(bodyForSecretScan)
    && containsObviousSecret(bodyForSecretScan, { includeAssignments: true })
  let hasSensitiveHeader = false
  try {
    const trustedHeaderTemplates = new Map(
      Object.entries(content.trustedCredentialHeaderTemplates ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    )
    hasSensitiveHeader = [...new Headers(content.headers).entries()]
      .some(([key, value]) => {
        if (!value) return false
        const trustedTemplate = trustedHeaderTemplates.get(key.toLowerCase())
        const valueForSecretScan = trustedTemplate ?? value
        if (containsObviousSecret(valueForSecretScan, { includeAssignments: true })) return true
        return isSensitiveDataKey(key) && trustedTemplate === undefined
      })
  } catch {
    // 非法的不可信 header 不能削弱预检守卫。
    hasSensitiveHeader = true
  }
  if (!hasSecretText && !hasSecretBody && !hasSensitiveHeader) return undefined

  let hostname: string | undefined
  try {
    hostname = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    // 非敏感但格式错误的 URL 由 URL policy 单独报告。
  }
  return {
    decision: 'deny',
    reason: 'secret_in_request',
    ...(hostname ? { hostname } : {}),
  }
}

function errorCategory(error: unknown): string {
  if (error instanceof ManagedWebAccessDeniedError) return 'policy_denied'
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted'
  if (error instanceof Error && /timeout/i.test(error.name + error.message)) return 'timeout'
  if (error instanceof Error && error.message === 'Managed Web Access redirect limit exceeded') return 'redirect_limit'
  return 'network_error'
}

function redirectedInit(
  init: RequestInit,
  status: number,
  previousUrl: string,
  nextUrl: string,
  credentialHeaderNames: ReadonlySet<string>,
  hasCredentialBody: boolean,
): { init: RequestInit, blockedCredentialBody: boolean } {
  const next: RequestInit = { ...init, redirect: 'manual' }
  const method = (next.method ?? 'GET').toUpperCase()
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    next.method = 'GET'
    delete next.body
  }

  const crossesOrigin = new URL(previousUrl).origin !== new URL(nextUrl).origin
  if (crossesOrigin) {
    const headers = new Headers(next.headers)
    headers.delete('authorization')
    headers.delete('cookie')
    headers.delete('proxy-authorization')
    for (const name of credentialHeaderNames) headers.delete(name)
    next.headers = headers
  }
  return {
    init: next,
    blockedCredentialBody: crossesOrigin && hasCredentialBody && next.body != null,
  }
}

export class ManagedWebAccess {
  private readonly policy: ManagedWebAccessPolicyLike
  private readonly auditWriter: ManagedWebAuditWriter
  private readonly fetchImpl: ManagedWebFetch
  private readonly maxRedirects: number

  constructor(options: ManagedWebAccessOptions) {
    this.policy = options.policy
    this.auditWriter = options.auditWriter
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxRedirects = options.maxRedirects ?? 10
  }

  async authorize(
    rawUrl: string,
    entrypoint: ManagedWebEntrypoint,
    content: ManagedWebRequestContent = {},
  ): Promise<ManagedWebAccessDecision> {
    const startedAt = Date.now()
    const decision = sensitiveRequestDecision(rawUrl, content) ?? await this.policy.authorize(rawUrl)
    await this.recordAudit({
      category: 'managed_web_access',
      action: `${entrypoint}.authorize`,
      data: {
        target: targetForAudit(decision),
        decision: decision.decision,
        reason: decision.reason,
        durationMs: Date.now() - startedAt,
        errorCategory: decision.decision === 'deny' ? 'policy_denied' : 'none',
      },
    })
    if (decision.decision === 'deny') throw new ManagedWebAccessDeniedError(decision)
    return decision
  }

  async run<T>(
    rawUrl: string,
    entrypoint: ManagedWebEntrypoint,
    operation: (normalizedUrl: string) => Promise<T>,
    content: ManagedWebRequestContent = {},
  ): Promise<T> {
    const requestStartedAt = Date.now()
    const decision = await this.authorize(rawUrl, entrypoint, content)
    try {
      const result = await operation(decision.normalizedUrl!)
      await this.recordRequest(entrypoint, decision, requestStartedAt, 'none')
      return result
    } catch (error) {
      await this.recordRequest(entrypoint, decision, requestStartedAt, errorCategory(error))
      throw error
    }
  }

  async fetch(
    rawUrl: string,
    init: RequestInit = {},
    entrypoint: ManagedWebEntrypoint = 'custom_http',
    content: ManagedWebRequestContent = {},
  ): Promise<Response> {
    const requestStartedAt = Date.now()
    let currentUrl = rawUrl
    let currentInit: RequestInit = { ...init, redirect: 'manual' }
    let lastDecision: ManagedWebAccessDecision | undefined
    const credentialHeaderNames = new Set(
      Object.keys(content.trustedCredentialHeaderTemplates ?? {}).map((name) => name.toLowerCase()),
    )
    const hasCredentialBody = content.trustedCredentialBodyTemplate !== undefined

    try {
      for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
        lastDecision = await this.authorize(currentUrl, entrypoint, redirectCount === 0 ? content : {})
        const response = await this.fetchImpl(lastDecision.normalizedUrl!, currentInit)
        const location = response.headers.get('location')
        if (!REDIRECT_STATUSES.has(response.status) || !location) {
          const category = response.ok ? 'none' : `http_${Math.floor(response.status / 100)}xx`
          await this.recordRequest(entrypoint, lastDecision, requestStartedAt, category)
          return response
        }
        if (redirectCount === this.maxRedirects) {
          throw new Error('Managed Web Access redirect limit exceeded')
        }

        const nextUrl = new URL(location, lastDecision.normalizedUrl).toString()
        const redirected = redirectedInit(
          currentInit,
          response.status,
          lastDecision.normalizedUrl!,
          nextUrl,
          credentialHeaderNames,
          hasCredentialBody,
        )
        if (redirected.blockedCredentialBody) {
          const denied: ManagedWebAccessDecision = {
            decision: 'deny',
            reason: 'secret_in_request',
            hostname: new URL(nextUrl).hostname.toLowerCase().replace(/\.$/, ''),
          }
          await this.recordAudit({
            category: 'managed_web_access',
            action: `${entrypoint}.authorize`,
            data: {
              target: targetForAudit(denied),
              decision: denied.decision,
              reason: denied.reason,
              durationMs: Date.now() - requestStartedAt,
              errorCategory: 'policy_denied',
            },
          })
          throw new ManagedWebAccessDeniedError(denied)
        }
        currentInit = redirected.init
        currentUrl = nextUrl
      }
    } catch (error) {
      if (!(error instanceof ManagedWebAccessDeniedError) && lastDecision) {
        await this.recordRequest(entrypoint, lastDecision, requestStartedAt, errorCategory(error))
      }
      throw error
    }

    throw new Error('Managed Web Access request ended unexpectedly')
  }

  private async recordRequest(
    entrypoint: ManagedWebEntrypoint,
    decision: ManagedWebAccessDecision,
    startedAt: number,
    category: string,
  ): Promise<void> {
    await this.recordAudit({
      category: 'managed_web_access',
      action: `${entrypoint}.request`,
      data: {
        target: targetForAudit(decision),
        decision: 'allow',
        reason: decision.reason,
        durationMs: Date.now() - startedAt,
        errorCategory: category,
      },
    })
  }

  private async recordAudit(event: AuditEvent): Promise<void> {
    try {
      await this.auditWriter.record(event)
    } catch {
      // Audit 只提供 best-effort 证据，失败不能替换策略或网络请求结果。
    }
  }
}
