import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { containsObviousSecret, isSensitiveDataKey } from '../security/sensitive-data.ts'

export type ManagedWebAccessReason =
  | 'public_target'
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'url_credentials'
  | 'secret_in_url'
  | 'secret_in_request'
  | 'blocked_hostname'
  | 'non_public_address'
  | 'dns_resolution_failed'
  | 'dns_no_addresses'

export interface ManagedWebAccessDecision {
  decision: 'allow' | 'deny'
  reason: ManagedWebAccessReason
  hostname?: string
  normalizedUrl?: string
}

/**
 * URL policy 的审批 seam，不是网络隔离边界。
 * 实现可以在 fetch 前解析主机名，但该接口不会把解析结果绑定到连接；
 * 调用方必须保留 DNS check/use 间隙这一边界说明。
 */
export interface ManagedWebAccessPolicyLike {
  authorize(url: string): Promise<ManagedWebAccessDecision>
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>

export interface ManagedWebAccessPolicyOptions {
  resolver?: DnsResolver
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
  'metadata.digitalocean.com',
  '100.100.100.200',
  '168.63.129.16',
  '169.254.169.254',
  '169.254.170.2',
])

function ipv4Bytes(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined
  const bytes = address.split('.').map(Number)
  return bytes.length === 4 && bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : undefined
}

function isPublicIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address)
  if (!bytes) return false
  const [a = 0, b = 0, c = 0] = bytes

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 0 || b === 168)) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function ipv6Bytes(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined
  const [leftRaw = '', rightRaw = ''] = address.toLowerCase().split('::')
  const parseSide = (side: string): number[] => {
    if (!side) return []
    const words: number[] = []
    for (const part of side.split(':')) {
      const ipv4 = ipv4Bytes(part)
      if (ipv4) {
        words.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!)
      } else {
        words.push(Number.parseInt(part, 16))
      }
    }
    return words
  }

  const left = parseSide(leftRaw)
  const right = parseSide(rightRaw)
  const omitted = 8 - left.length - right.length
  if (omitted < 0 || (!address.includes('::') && omitted !== 0)) return undefined
  const words = address.includes('::') ? [...left, ...Array(omitted).fill(0), ...right] : left
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined
  return words.flatMap((word) => [word >> 8, word & 0xff])
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address)
  if (!bytes) return false

  const allZeroBeforeLast = bytes.slice(0, 12).every((byte) => byte === 0)
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (allZeroBeforeLast || ipv4Mapped) {
    return isPublicIpv4(bytes.slice(12).join('.'))
  }

  if ((bytes[0]! & 0xfe) === 0xfc) return false
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) >= 0x80) return false
  if (bytes[0] === 0xff) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPublicIpv4(bytes.slice(2, 6).join('.'))
  return true
}

function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address)
  if (isIP(address) === 6) return isPublicIpv6(address)
  return false
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, '')
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.has(hostname)
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.metadata.google.internal')
    || hostname.endsWith('.metadata.goog')
}

function hasObviousSecret(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (isSensitiveDataKey(key) && value.length > 0) return true
  }

  let decoded = `${url.hostname}${url.pathname}${url.search}${url.hash}`
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // 保守扫描原始编码内容。
  }
  return containsObviousSecret(decoded, { includeAssignments: true })
}

function defaultResolver(hostname: string): Promise<readonly string[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((results) => results.map((result) => result.address))
}

export class ManagedWebAccessPolicy implements ManagedWebAccessPolicyLike {
  private readonly resolver: DnsResolver

  constructor(options: ManagedWebAccessPolicyOptions = {}) {
    this.resolver = options.resolver ?? defaultResolver
  }

  async authorize(rawUrl: string): Promise<ManagedWebAccessDecision> {
    let parsed: URL
    try {
      parsed = new URL(rawUrl.trim())
    } catch {
      return { decision: 'deny', reason: 'invalid_url' }
    }

    const hostname = normalizeHostname(parsed.hostname)
    const normalizedUrl = parsed.toString()
    const deny = (reason: ManagedWebAccessReason): ManagedWebAccessDecision => ({
      decision: 'deny',
      reason,
      ...(hostname ? { hostname } : {}),
    })

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return deny('unsupported_protocol')
    if (parsed.username || parsed.password) return deny('url_credentials')
    if (isBlockedHostname(hostname)) return deny('blocked_hostname')
    if (hasObviousSecret(parsed)) return deny('secret_in_url')

    if (isIP(hostname) !== 0) {
      return isPublicIp(hostname)
        ? { decision: 'allow', reason: 'public_target', hostname, normalizedUrl }
        : deny('non_public_address')
    }

    let addresses: readonly string[]
    try {
      addresses = await this.resolver(hostname)
    } catch {
      return deny('dns_resolution_failed')
    }
    if (addresses.length === 0) return deny('dns_no_addresses')
    if (addresses.some((address) => !isPublicIp(address))) return deny('non_public_address')
    return { decision: 'allow', reason: 'public_target', hostname, normalizedUrl }
  }
}
