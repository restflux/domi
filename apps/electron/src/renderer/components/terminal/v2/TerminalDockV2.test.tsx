import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TerminalSessionView } from '@domi/shared'
import { terminalDockOpenMapAtom, terminalStateMapAtom } from '@/atoms/terminal-atoms.ts'
import { TerminalDockV2 } from './TerminalDockV2'

const terminal = (terminalId: string, ownerSessionId: string): TerminalSessionView => ({
  terminalId, ownerSessionId, kind: 'user-shell', presentation: 'dock', title: terminalId,
  cwd: '/tmp', profile: 'bash', status: 'running', startedAt: 1,
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
  expect(html).toContain('aria-label="切换到first"')
  expect(html).toContain('aria-label="关闭first"')
  expect(html).toContain('aria-label="关闭second"')
  expect(html).not.toContain('关闭other')
  // ZCode forceMount：切到第二标签时，第一标签的 xterm DOM 保留，不随 tab 重建。
  expect(html.match(/terminal-xterm-shell/g)).toHaveLength(2)
  expect(html).toContain('data-state="inactive"')
})
