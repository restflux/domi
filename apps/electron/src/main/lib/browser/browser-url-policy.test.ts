import { describe, expect, test } from 'bun:test'
import {
  BrowserNavigationPolicyError,
  normalizeBrowserUrlInput,
  validateBrowserNavigationUrl,
  validateBrowserRequestUrl,
} from './browser-url-policy.ts'

describe('浏览器 URL 策略', () => {
  test('Given a hostname without scheme When normalizing Then public hosts use HTTPS and loopback uses HTTP', () => {
    expect(normalizeBrowserUrlInput('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrlInput('localhost:5173/demo')).toBe('http://localhost:5173/demo')
    expect(normalizeBrowserUrlInput('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
  })

  test('Given a public HTTPS URL When DNS resolves publicly Then navigation is allowed', async () => {
    const result = await validateBrowserNavigationUrl('https://example.com/path', async () => ['93.184.216.34'])

    expect(result.url).toBe('https://example.com/path')
    expect(result.networkClass).toBe('public')
  })

  test('Given loopback URLs When validating Then localhost, IPv4 and IPv6 loopback are allowed without public DNS', async () => {
    const resolveUnexpectedly = async (): Promise<string[]> => {
      throw new Error('loopback validation must not require DNS')
    }

    await expect(validateBrowserNavigationUrl('http://localhost:5173', resolveUnexpectedly)).resolves.toMatchObject({ networkClass: 'loopback' })
    await expect(validateBrowserNavigationUrl('http://app.localhost:5173', resolveUnexpectedly)).resolves.toMatchObject({ networkClass: 'loopback' })
    await expect(validateBrowserNavigationUrl('http://127.255.0.1:4173', resolveUnexpectedly)).resolves.toMatchObject({ networkClass: 'loopback' })
    await expect(validateBrowserNavigationUrl('http://[::1]:4173', resolveUnexpectedly)).resolves.toMatchObject({ networkClass: 'loopback' })
    await expect(validateBrowserNavigationUrl('http://[::ffff:127.0.0.1]:4173', resolveUnexpectedly)).resolves.toMatchObject({ networkClass: 'loopback' })
  })

  test('Given dangerous protocols, URL credentials or private hosts When validating Then navigation fails closed', async () => {
    const resolvePublicly = async (): Promise<string[]> => ['93.184.216.34']
    const rejected = [
      'file:///tmp/demo.html',
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://user:secret@example.com',
      'http://0.0.0.0:5173',
      'http://10.0.0.8',
      'http://172.16.0.8',
      'http://192.168.1.8',
      'http://169.254.169.254/latest/meta-data',
      'http://host.local',
      'http://[::ffff:192.168.1.1]',
      'http://[::ffff:169.254.169.254]',
    ]

    for (const url of rejected) {
      await expect(validateBrowserNavigationUrl(url, resolvePublicly)).rejects.toBeInstanceOf(BrowserNavigationPolicyError)
    }
  })

  test('Given a public hostname begins with 127 text When validating Then it is not trusted as loopback', async () => {
    const resolvePublicly = async (): Promise<string[]> => ['93.184.216.34']

    await expect(validateBrowserNavigationUrl('http://127.evil.com', resolvePublicly))
      .resolves.toMatchObject({ networkClass: 'public' })
    await expect(validateBrowserRequestUrl('http://127.0.0.1:5173/api', 'http://127.evil.com', resolvePublicly))
      .rejects.toMatchObject({ code: 'cross_origin_loopback_denied' })
  })

  test('Given a public hostname that resolves to private or loopback addresses When validating Then DNS rebinding is rejected', async () => {
    await expect(validateBrowserNavigationUrl('https://public.example', async () => ['192.168.1.20']))
      .rejects.toMatchObject({ code: 'private_network_denied' })
    await expect(validateBrowserNavigationUrl('https://public.example', async () => ['127.0.0.1']))
      .rejects.toMatchObject({ code: 'private_network_denied' })
  })

  test('Given loopback requests lack a verified loopback first party When validating Then they fail closed', async () => {
    const resolvePublicly = async (): Promise<string[]> => ['93.184.216.34']

    await expect(validateBrowserRequestUrl('http://127.0.0.1:5173/api', undefined, resolvePublicly))
      .rejects.toMatchObject({ code: 'cross_origin_loopback_denied' })
    await expect(validateBrowserRequestUrl('http://127.0.0.1:5173/api', 'not a url', resolvePublicly))
      .rejects.toMatchObject({ code: 'cross_origin_loopback_denied' })
  })

  test('Given a public page When it requests loopback resources Then the request is denied while loopback pages remain usable', async () => {
    const resolvePublicly = async (): Promise<string[]> => ['93.184.216.34']

    await expect(validateBrowserRequestUrl('http://127.0.0.1:5173/api', 'https://public.example', resolvePublicly))
      .rejects.toMatchObject({ code: 'cross_origin_loopback_denied' })
    await expect(validateBrowserRequestUrl('http://127.0.0.1:5173/app.js', 'http://localhost:5173', resolvePublicly))
      .resolves.toMatchObject({ networkClass: 'loopback' })
  })
})
