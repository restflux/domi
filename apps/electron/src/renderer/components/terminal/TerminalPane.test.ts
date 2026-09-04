import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('TerminalPane 焦点行为', () => {
  test('给定终端会话恢复，当历史输出加载完成时，不应主动抢占当前页面焦点', () => {
    const source = readFileSync(resolve(import.meta.dir, 'TerminalPane.tsx'), 'utf8')

    expect(source).toContain('requestAnimationFrame(fit)')
    expect(source).not.toContain('xterm.focus()')
  })
})
