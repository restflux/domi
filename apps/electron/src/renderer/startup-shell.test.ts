import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('主窗口在 React 加载前显示启动反馈', () => {
  const html = readFileSync(join(import.meta.dir, 'index.html'), 'utf-8')

  expect(html).toContain('domi-startup-shell')
  expect(html).toContain('正在启动')
  expect(html).toContain('src="/assets/brand/domi-mark-small.png"')
  expect(html).toContain("new URLSearchParams(window.location.search).has('window')")
  expect(html).not.toContain('aria-hidden="true">D</div>')
  expect(html.indexOf('domi-startup-shell')).toBeLessThan(html.indexOf('src="/main.tsx"'))
})
