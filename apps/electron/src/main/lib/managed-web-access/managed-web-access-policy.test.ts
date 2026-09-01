import { describe, expect, test } from 'bun:test'
import { ManagedWebAccessPolicy } from './managed-web-access-policy.ts'

describe('ManagedWebAccessPolicy', () => {
  test('公开 HTTP(S) 地址可访问，私有 IPv4 地址被拒绝', async () => {
    const policy = new ManagedWebAccessPolicy()

    expect(await policy.authorize('https://8.8.8.8/docs')).toMatchObject({
      decision: 'allow',
      reason: 'public_target',
      hostname: '8.8.8.8',
    })

    for (const url of [
      'http://0.0.0.0',
      'http://127.20.30.40',
      'http://10.1.2.3',
      'http://172.31.255.1',
      'http://192.168.1.8/admin',
      'http://169.254.1.1',
      'http://2130706433',
      'http://0x7f000001',
      'http://127.0x0.0.1',
    ]) {
      expect(await policy.authorize(url)).toMatchObject({
        decision: 'deny',
        reason: 'non_public_address',
      })
    }
  })

  test('公开 IPv6 可访问，环回、私网、link-local 与 mapped 私网被拒绝', async () => {
    const policy = new ManagedWebAccessPolicy()

    expect(await policy.authorize('https://[2606:4700:4700::1111]/')).toMatchObject({
      decision: 'allow',
      reason: 'public_target',
    })

    for (const url of [
      'http://[::1]',
      'http://[fc00::1]',
      'http://[fd12::1]',
      'http://[fe80::1234]',
      'http://[fec0::1234]',
      'http://[2002:7f00:1::]',
      'http://[::ffff:127.0.0.1]',
      'http://[::ffff:192.168.1.2]',
    ]) {
      expect(await policy.authorize(url)).toMatchObject({
        decision: 'deny',
        reason: 'non_public_address',
      })
    }
  })

  test('拒绝 credentials、metadata、非 HTTP 协议和 URL 中的明显秘密', async () => {
    const policy = new ManagedWebAccessPolicy({ resolver: async () => ['8.8.8.8'] })

    expect((await policy.authorize('https://user:pass@example.com/path')).reason).toBe('url_credentials')
    expect((await policy.authorize('https://metadata.google.internal/computeMetadata/v1')).reason).toBe('blocked_hostname')
    expect((await policy.authorize('https://alias.metadata.google.internal/computeMetadata/v1')).reason).toBe('blocked_hostname')
    expect((await policy.authorize('https://100.100.100.200/latest/meta-data')).reason).toBe('blocked_hostname')
    expect((await policy.authorize('file:///etc/passwd')).reason).toBe('unsupported_protocol')
    const secretDecision = await policy.authorize('https://example.com/?api_key=sk-secret-value')
    expect(secretDecision.reason).toBe('secret_in_url')
    expect(secretDecision.normalizedUrl).toBeUndefined()
    expect((await policy.authorize('https://example.com/?x-api-key=opaque-value')).reason).toBe('secret_in_url')
    expect((await policy.authorize('https://ghp_abcdefghijklmnopqrstuvwxyz123456.example.com/')).reason).toBe('secret_in_url')
    expect((await policy.authorize('https://example.com/Bearer%20ghp_abcdefghijklmnopqrstuvwxyz123456')).reason).toBe('secret_in_url')
  })

  test('域名解析失败时 fail closed，且任一 A/AAAA 非公开即拒绝', async () => {
    const mixedPolicy = new ManagedWebAccessPolicy({
      resolver: async () => ['93.184.216.34', '10.0.0.2'],
    })
    const publicPolicy = new ManagedWebAccessPolicy({
      resolver: async () => ['93.184.216.34', '2606:4700:4700::1111'],
    })
    const failingPolicy = new ManagedWebAccessPolicy({
      resolver: async () => { throw new Error('offline') },
    })

    expect(await mixedPolicy.authorize('https://example.com')).toMatchObject({
      decision: 'deny',
      reason: 'non_public_address',
    })
    expect(await publicPolicy.authorize('https://example.com')).toMatchObject({
      decision: 'allow',
      reason: 'public_target',
    })
    expect(await failingPolicy.authorize('https://example.com')).toMatchObject({
      decision: 'deny',
      reason: 'dns_resolution_failed',
    })
  })
})
