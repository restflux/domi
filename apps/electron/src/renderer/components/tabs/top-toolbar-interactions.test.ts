import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const components = resolve(import.meta.dir, '..')

describe('现代 Work 顶部交互', () => {
  test('会话树由菜单关闭后的焦点交接打开，避免非模态 Dialog 被菜单的还焦立即关闭', () => {
    const source = readFileSync(resolve(components, 'SessionHeaderMenu.tsx'), 'utf8')
    expect(source).toContain("entry.action === 'sessionTree'")
    expect(source).toContain('onCloseAutoFocus={handleCloseAutoFocus}')
    expect(source).toContain('event.preventDefault()')
    expect(source).toContain("onAction('sessionTree')")
  })

  test('现代活动标签仅用文字区分，不再绘制灰色背景', () => {
    const css = readFileSync(resolve(components, '../styles/globals.css'), 'utf8')
    expect(css).toMatch(/:root\.ui-modern:not\(\.theme-terminal-dark\) \.main-tabbar \.chrome-tab\.app-tab-active \{\s*background: transparent;/)
  })
})
