import { expect, test } from 'bun:test'
import { resolveTerminalSpawnEnv } from './terminal-spawn-env.ts'

test('Given a GUI launch with a narrow PATH and C locale When starting an interactive terminal Then ZCode shell defaults preserve user entries and restore UTF-8/color', () => {
  const inherited = { PATH: '/custom/bin:/usr/bin', TERM: 'dumb', CI: '1', LANG: 'C', LC_CTYPE: 'POSIX', LC_ALL: 'C' }
  const resolved = resolveTerminalSpawnEnv(inherited, 'darwin', 'interactive-shell')
  // PATH 语义跟随目标平台（darwin 为 ':'），与宿主无关，在任意平台断言都确定。
  expect(resolved.PATH?.split(':').slice(0, 2)).toEqual(['/custom/bin', '/usr/bin'])
  expect(resolved.PATH?.split(':').filter((path) => path === '/usr/bin')).toHaveLength(1)
  expect(resolved.PATH).toContain('/opt/homebrew/bin')
  expect(resolved.TERM).toBe('xterm-256color')
  expect(resolved.COLORTERM).toBe('truecolor')
  expect(resolved.CI).toBeUndefined()
  expect(resolved.LANG).toBe('en_US.UTF-8')
  expect(resolved.LC_CTYPE).toBe('en_US.UTF-8')
  expect(resolved.LC_ALL).toBe('en_US.UTF-8')
  expect(inherited.PATH).toBe('/custom/bin:/usr/bin')
})

test('Given a configured UTF-8 locale and existing terminal profile When starting a terminal Then user choices survive', () => {
  const inherited = { PATH: '/home/me/bin', LANG: 'zh_CN.UTF-8', LC_CTYPE: 'fr_FR.UTF-8', COLORTERM: 'my-colors', CI: '1', TERM: 'xterm' }
  const resolved = resolveTerminalSpawnEnv(inherited, 'linux', 'interactive-shell')
  expect(resolved.PATH).toBe(inherited.PATH)
  expect(resolved.LANG).toBe(inherited.LANG)
  expect(resolved.LC_CTYPE).toBe(inherited.LC_CTYPE)
  expect(resolved.CI).toBe('1')
  expect(resolved.COLORTERM).toBe('my-colors')
})

test('Given an Agent command with execution policy environment When starting its PTY Then interactive-only changes do not alter the command environment', () => {
  const inherited = { PATH: '/usr/bin', CI: '1', TERM: 'dumb', LANG: 'C' }
  const resolved = resolveTerminalSpawnEnv(inherited, 'darwin', 'agent-command')
  expect(resolved.PATH).toBe('/usr/bin')
  expect(resolved.CI).toBe('1')
  expect(resolved.LANG).toBe('C')
  expect(resolved.TERM).toBe('xterm-256color')
})
