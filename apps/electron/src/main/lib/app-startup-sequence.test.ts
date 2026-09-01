import { describe, expect, test } from 'bun:test'
import { runAppStartupSequence } from './app-startup-sequence.ts'

describe('应用启动顺序', () => {
  test('先显示主窗口，再执行可能耗时的后台初始化', async () => {
    const calls: string[] = []
    let releaseWindow: (() => void) | undefined
    const windowVisible = new Promise<void>((resolve) => {
      releaseWindow = resolve
    })

    const startup = runAppStartupSequence({
      prepareWindow: () => {
        calls.push('prepare-window')
      },
      createWindow: async () => {
        calls.push('create-window')
        await windowVisible
        calls.push('window-visible')
      },
      initializeServices: async () => {
        calls.push('initialize-services')
      },
    })

    await Promise.resolve()
    expect(calls).toEqual(['prepare-window', 'create-window'])
    expect(calls).not.toContain('initialize-services')

    releaseWindow?.()
    await startup

    expect(calls).toEqual([
      'prepare-window',
      'create-window',
      'window-visible',
      'initialize-services',
    ])
  })
})
