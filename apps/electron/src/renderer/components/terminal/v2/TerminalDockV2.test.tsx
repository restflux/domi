import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TerminalSessionView } from '@domi/shared'
import { terminalDockOpenMapAtom, terminalStateMapAtom } from '@/atoms/terminal-atoms.ts'
import { TerminalDockV2, buildZCodeDockTerminalInput } from './TerminalDockV2'

const terminal = (terminalId: string, ownerSessionId: string): TerminalSessionView => ({
  terminalId, ownerSessionId, kind: 'user-shell', presentation: 'dock', title: terminalId,
  cwd: '/proj/alpha', profile: 'bash', status: 'running', startedAt: 1,
})

test('Given the v2 Dock When creating an interactive shell Then it selects ZCode backend without changing the owner or presentation', () => {
  expect(buildZCodeDockTerminalInput('owner', 'zsh')).toEqual({
    ownerSessionId: 'owner', profile: 'zsh', presentation: 'dock', engine: 'zcode', cols: 100, rows: 28,
  })
})

test('Given multiple owners and terminals When rendering v2 Dock Then only owner tabs have separate keyboard-accessible close controls', () => {
  const store = createStore()
  store.set(terminalStateMapAtom, new Map([
    ['first', terminal('first', 'owner')],
    ['second', terminal('second', 'owner')],
    ['other', terminal('other', 'another-owner')],
  ]))
  store.set(terminalDockOpenMapAtom, new Map([['owner', true]]))
  const html = renderToStaticMarkup(<Provider store={store}><TerminalDockV2 ownerSessionId="owner" /></Provider>)
  // ZCode 标题规则：首个 tab 只显示项目名，第二个起追加 owner 内序号。
  expect(html).toContain('aria-label="切换到alpha"')
  expect(html).toContain('aria-label="关闭alpha"')
  expect(html).toContain('aria-label="关闭alpha 2"')
  expect(html).toContain('data-zcode-terminal-close="true"')
  expect(html).not.toContain('关闭other')
  // ZCode forceMount：切到第二标签时，第一标签的 xterm DOM 保留，不随 tab 重建。
  expect(html.match(/terminal-xterm-shell/g)).toHaveLength(2)
  expect(html).toContain('data-state="inactive"')
})
