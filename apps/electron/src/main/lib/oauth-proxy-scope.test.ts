import { describe, expect, test } from 'bun:test'
import { buildOAuthNoProxy, readNoProxyEnvironment, runWithOAuthProxyScope } from './oauth-proxy-scope'
import { getPiRequestProxyDispatcher } from './adapters/pi-request-proxy'

describe('OAuth proxy scope', () => {
  test('preserves user exclusions and includes every loopback host', () => {
    expect(buildOAuthNoProxy('internal.example,localhost')).toBe('internal.example,localhost,127.0.0.1,[::1]')
  })

  test('preserves a NO_PROXY wildcard', () => {
    expect(buildOAuthNoProxy('*')).toBe('*')
  })

  test('prefers lowercase no_proxy like Undici', () => {
    expect(readNoProxyEnvironment({
      NO_PROXY: 'uppercase.example',
      no_proxy: 'lowercase.example',
    })).toBe('lowercase.example')
  })

  test('scopes an application proxy to the entire OAuth operation', async () => {
    await expect(runWithOAuthProxyScope(async () => {
      expect(getPiRequestProxyDispatcher()).toBeDefined()
      return 'token'
    }, async () => 'http://127.0.0.1:7890')).resolves.toBe('token')

    expect(getPiRequestProxyDispatcher()).toBeUndefined()
  })

  test('keeps direct networking when no proxy is configured', async () => {
    await expect(runWithOAuthProxyScope(async () => {
      expect(getPiRequestProxyDispatcher()).toBeUndefined()
      return 'token'
    }, async () => undefined)).resolves.toBe('token')
  })
})
