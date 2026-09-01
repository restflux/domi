import { describe, expect, mock, test } from 'bun:test'
import { copyTextToClipboard } from './clipboard'

describe('copyTextToClipboard', () => {
  test('uses the Electron main-process writer first', async () => {
    const native = mock(async () => {})
    const browser = mock(async () => {})

    await copyTextToClipboard('hello', { native, browser })

    expect(native).toHaveBeenCalledWith('hello')
    expect(browser).not.toHaveBeenCalled()
  })

  test('falls back to the browser writer when the native bridge fails', async () => {
    const native = mock(async () => { throw new Error('IPC unavailable') })
    const browser = mock(async () => {})

    await copyTextToClipboard('fallback', { native, browser })

    expect(native).toHaveBeenCalledWith('fallback')
    expect(browser).toHaveBeenCalledWith('fallback')
  })

  test('supports browser-only environments', async () => {
    const browser = mock(async () => {})

    await copyTextToClipboard('browser', { browser })

    expect(browser).toHaveBeenCalledWith('browser')
  })

  test('rejects when no clipboard writer is available', async () => {
    expect(copyTextToClipboard('missing', {})).rejects.toThrow('当前环境不支持写入剪贴板')
  })
})
