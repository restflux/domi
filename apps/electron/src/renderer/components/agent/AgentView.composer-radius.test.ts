import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')

test('现代普通 Work 输入框聚焦前后保持 20px 圆角，Plan 与经典样式不变', () => {
  const resting = styles.match(/:root\.ui-modern \.agent-composer-surface:not\(\.plan-mode-border\),[\s\S]*?\{([^}]+)\}/)?.[1]
  const focused = styles.match(/:root\.ui-modern:not\(\.theme-terminal-dark\) \.agent-composer-surface:not\(\.plan-mode-border\):focus-within\s*\{([^}]+)\}/)?.[1]
  expect(resting).toContain('border-radius: 20px;')
  expect(focused).toContain('border-radius: 20px !important;')
  expect(focused).not.toContain('background:')
  expect(styles).toContain('.theme-forest-dark [data-agent-composer-surface="true"]:focus-within')
  expect(styles).toContain('.theme-ocean-dark [data-agent-composer-surface="true"]:focus-within')
  expect(styles).toContain('.theme-terminal-dark [class*="rounded"]:not(.sticky-return-question-button)')
})
