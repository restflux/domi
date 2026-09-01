import type { ChatToolHttpConfig } from '@domi/shared'
import { containsObviousSecret, isSensitiveDataKey } from '../security/sensitive-data.ts'

const CREDENTIAL_REFERENCE = /\{\{credential\.([A-Za-z_][\w-]*)\}\}/g
const ARGUMENT_REFERENCE = /\{\{(\w+)\}\}/g
const HAS_ARGUMENT_REFERENCE = /\{\{\w+\}\}/

export class MissingHttpToolCredentialError extends Error {
  constructor(readonly credentialKey: string) {
    super(`Missing HTTP tool credential: ${credentialKey}`)
    this.name = 'MissingHttpToolCredentialError'
  }
}

export function listHttpCredentialKeys(config: ChatToolHttpConfig): string[] {
  const keys = new Set<string>()
  const collect = (value: string | undefined): void => {
    if (!value) return
    CREDENTIAL_REFERENCE.lastIndex = 0
    for (const match of value.matchAll(CREDENTIAL_REFERENCE)) {
      if (match[1]) keys.add(match[1])
    }
  }
  collect(config.urlTemplate)
  for (const value of Object.values(config.headers ?? {})) collect(value)
  collect(config.bodyTemplate)
  return [...keys].sort()
}

function containsCredentialReference(value: string): boolean {
  CREDENTIAL_REFERENCE.lastIndex = 0
  return CREDENTIAL_REFERENCE.test(value)
}

/**
 * 自定义 HTTP 配置只能保存 credential reference，不能保存明文凭据。
 * URL 禁止 credential reference，避免 secret 进入代理、历史、审计或服务端访问日志。
 */
export function assertSafeHttpToolConfig(config: ChatToolHttpConfig): void {
  if (containsCredentialReference(config.urlTemplate)) {
    throw new Error('HTTP 工具凭据不能注入 URL，请改用 header 或 POST body')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(config.urlTemplate.replace(ARGUMENT_REFERENCE, 'placeholder'))
  } catch {
    throw new Error('HTTP 工具 URL 模板无效')
  }
  if (parsedUrl.username || parsedUrl.password) throw new Error('HTTP 工具 URL 不得包含用户名或密码')
  for (const [key, value] of parsedUrl.searchParams) {
    if (value && isSensitiveDataKey(key)) throw new Error(`HTTP 工具 URL 不得包含敏感参数: ${key}`)
  }
  if (containsObviousSecret(config.urlTemplate, { includeAssignments: true })) {
    throw new Error('HTTP 工具 URL 不得包含明文凭据')
  }

  for (const [key, value] of Object.entries(config.headers ?? {})) {
    const hasReference = containsCredentialReference(value)
    const valueWithoutCredentials = value.replace(CREDENTIAL_REFERENCE, '')
    if (value && isSensitiveDataKey(key) && !hasReference) {
      throw new Error(`敏感 header ${key} 必须使用 {{credential.<key>}} 引用`)
    }
    if (isSensitiveDataKey(key) && HAS_ARGUMENT_REFERENCE.test(valueWithoutCredentials)) {
      throw new Error(`敏感 header ${key} 不得注入模型参数，只能使用 credential reference`)
    }
    if (containsObviousSecret(valueWithoutCredentials, { includeAssignments: true })) {
      throw new Error(`HTTP 工具 header ${key} 不得包含 credential reference 之外的明文凭据`)
    }
  }

  if (config.bodyTemplate && containsObviousSecret(config.bodyTemplate, { includeAssignments: true })) {
    throw new Error('HTTP 工具 bodyTemplate 不得包含明文凭据')
  }
}

export function resolveHttpTemplate(
  template: string,
  args: Record<string, unknown>,
  credentials: Record<string, string>,
  urlEncodeArgs: boolean,
): { value: string, credentialValues: string[], valueWithoutCredentials: string } {
  const credentialValues: string[] = []
  const withCredentials = template.replace(CREDENTIAL_REFERENCE, (_match, credentialKey: string) => {
    const credential = credentials[credentialKey]
    if (!credential) throw new MissingHttpToolCredentialError(credentialKey)
    credentialValues.push(credential)
    return credential
  })
  const replaceArguments = (value: string): string => value.replace(ARGUMENT_REFERENCE, (_match, paramName: string) => {
    const raw = args[paramName]
    const stringValue = raw != null ? String(raw) : ''
    return urlEncodeArgs ? encodeURIComponent(stringValue) : stringValue
  })
  return {
    value: replaceArguments(withCredentials),
    credentialValues,
    valueWithoutCredentials: replaceArguments(template.replace(CREDENTIAL_REFERENCE, '')),
  }
}

export function hasRequiredHttpToolCredentials(
  config: ChatToolHttpConfig,
  credentials: Record<string, string>,
): boolean {
  try {
    assertSafeHttpToolConfig(config)
  } catch {
    return false
  }
  return listHttpCredentialKeys(config).every((key) => Boolean(credentials[key]))
}
