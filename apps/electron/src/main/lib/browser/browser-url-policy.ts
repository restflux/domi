import { isIP } from 'node:net'

export type BrowserNetworkClass = 'public' | 'loopback'
export type BrowserAddressResolver = (hostname: string) => Promise<string[]>

export class BrowserNavigationPolicyError extends Error {
  constructor(
    readonly code:
      | 'invalid_url'
      | 'protocol_denied'
      | 'credentials_denied'
      | 'private_network_denied'
      | 'cross_origin_loopback_denied'
      | 'dns_resolution_failed',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserNavigationPolicyError'
  }
}

export interface ValidatedBrowserNavigation {
  url: string
  networkClass: BrowserNetworkClass
}

export function normalizeBrowserUrlInput(input: string): string {
  const value = input.trim()
  if (!value) throw new BrowserNavigationPolicyError('invalid_url', '请输入要打开的网址。')
  const looksLikeHostWithPort = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i.test(value)
    || /^\[[0-9a-f:]+\]:\d+(?:[/?#]|$)/i.test(value)
  if (!looksLikeHostWithPort && /^[a-z][a-z\d+.-]*:/i.test(value)) return new URL(value).toString()

  const hostname = value.startsWith('[')
    ? value.slice(1, value.indexOf(']')).toLowerCase()
    : value.split(/[/:?#]/, 1)[0]?.toLowerCase() ?? ''
  const protocol = isLoopbackHostname(hostname) ? 'http' : 'https'
  try {
    return new URL(`${protocol}://${value}`).toString()
  } catch {
    throw new BrowserNavigationPolicyError('invalid_url', '网址格式无效。')
  }
}

export async function validateBrowserNavigationUrl(
  input: string,
  resolveAddresses: BrowserAddressResolver,
): Promise<ValidatedBrowserNavigation> {
  let url: URL
  try {
    url = new URL(normalizeBrowserUrlInput(input))
  } catch (error) {
    if (error instanceof BrowserNavigationPolicyError) throw error
    throw new BrowserNavigationPolicyError('invalid_url', '网址格式无效。')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserNavigationPolicyError('protocol_denied', '内置浏览器只允许 HTTP 和 HTTPS 网页。')
  }
  if (url.username || url.password) {
    throw new BrowserNavigationPolicyError('credentials_denied', '网址中不能包含用户名或密码。')
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase()
  if (isLoopbackHostname(hostname)) return { url: url.toString(), networkClass: 'loopback' }
  if (isDeniedHostname(hostname) || isPrivateOrReservedAddress(hostname)) {
    throw new BrowserNavigationPolicyError('private_network_denied', '内置浏览器不允许访问非 loopback 私网地址。')
  }

  if (!isIP(hostname)) {
    let addresses: string[]
    try {
      addresses = await resolveAddresses(hostname)
    } catch {
      throw new BrowserNavigationPolicyError('dns_resolution_failed', '无法安全解析该网址。')
    }
    if (addresses.length === 0) {
      throw new BrowserNavigationPolicyError('dns_resolution_failed', '无法安全解析该网址。')
    }
    if (addresses.some((address) => {
      const resolvedAddress = stripIpv6Brackets(address)
      return isLoopbackHostname(resolvedAddress) || isPrivateOrReservedAddress(resolvedAddress)
    })) {
      throw new BrowserNavigationPolicyError('private_network_denied', '该网址解析到了非 loopback 私网地址。')
    }
  }

  return { url: url.toString(), networkClass: 'public' }
}

export async function validateBrowserRequestUrl(
  requestUrl: string,
  firstPartyUrl: string | undefined,
  resolveAddresses: BrowserAddressResolver,
): Promise<ValidatedBrowserNavigation> {
  const request = await validateBrowserNavigationUrl(requestUrl, resolveAddresses)
  if (request.networkClass !== 'loopback') return request

  let firstPartyHostname = ''
  try {
    firstPartyHostname = firstPartyUrl ? new URL(firstPartyUrl).hostname : ''
  } catch {
    // 缺失或无效来源不能为 public 页面扩大 loopback 权限。
  }
  if (!isLoopbackHostname(firstPartyHostname)) {
    throw new BrowserNavigationPolicyError('cross_origin_loopback_denied', '公共网页不能探测本机 loopback 服务。')
  }
  return request
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.split('.')[0] === '127'
  const mapped = parseIpv4MappedAddress(normalized)
  return mapped?.split('.')[0] === '127'
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const value = stripIpv6Brackets(address).toLowerCase()
  const ipVersion = isIP(value)
  if (ipVersion === 4) return isPrivateOrReservedIpv4(value)
  if (ipVersion === 6) {
    if (value === '::1') return false
    if (value === '::') return true
    if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true
    const mapped = parseIpv4MappedAddress(value)
    return mapped ? isPrivateOrReservedIpv4(mapped) : false
  }
  return false
}

function parseIpv4MappedAddress(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (dotted && isIP(dotted) === 4) return dotted
  const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hexadecimal) return undefined
  const high = Number.parseInt(hexadecimal[1]!, 16)
  const low = Number.parseInt(hexadecimal[2]!, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const a = parts[0]!
  const b = parts[1]!
  if (a === 127) return false
  return a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function isDeniedHostname(hostname: string): boolean {
  return hostname.endsWith('.local')
    || hostname === 'metadata.google.internal'
    || hostname.endsWith('.internal')
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}
