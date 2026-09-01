import { describe, expect, test } from 'bun:test'
import { redactProxyUrl } from './proxy-settings-service'

describe('proxy settings logging', () => {
  test('redacts both username and password from authenticated proxy URLs', () => {
    const value = redactProxyUrl('http://alice:secret@127.0.0.1:7890')

    expect(value).not.toContain('alice')
    expect(value).not.toContain('secret')
    expect(value).toContain('127.0.0.1:7890')
  })

  test('never echoes malformed or unsupported proxy URLs', () => {
    expect(redactProxyUrl('alice:secret@not a url')).toBe('[invalid proxy URL]')
    expect(redactProxyUrl('file:///tmp/proxy')).toBe('[invalid proxy URL]')
  })

  test('preserves safe proxy URLs without credentials', () => {
    expect(redactProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
  })
})
