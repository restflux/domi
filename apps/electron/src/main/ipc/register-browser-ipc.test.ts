import { describe, expect, test } from 'bun:test'
import { BROWSER_IPC_CHANNELS, type BrowserSessionView } from '@domi/shared'
import { registerBrowserIpc } from './register-browser-ipc.ts'

type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>

const state: BrowserSessionView = {
  browserSessionId: 'browser-1',
  ownerSessionId: 'session-1',
  workspaceId: 'workspace-1',
  profileKind: 'project',
  control: null,
  sourceTarget: { kind: 'local', revision: 1, stale: false },
  page: {
    pageId: 'page-1',
    title: 'Example',
    url: 'https://example.com/',
    loadState: 'ready',
    canGoBack: false,
    canGoForward: false,
    navigationEpoch: 1,
    visible: true,
    zoomPercent: 100,
    fitToWidth: false,
  },
}

function setup(): { handlers: Map<string, Handler>; calls: string[] } {
  const handlers = new Map<string, Handler>()
  const calls: string[] = []
  registerBrowserIpc({
    handle: (channel, handler) => handlers.set(channel, handler as Handler),
  }, {
    open: async (input) => { calls.push(`open:${input.ownerSessionId}:${input.url ?? ''}`); return state },
    activate: async (ownerSessionId, browserSessionId) => { calls.push(`activate:${ownerSessionId}:${browserSessionId}`); return state },
    inspect: async (ownerSessionId, browserSessionId) => { calls.push(`inspect:${ownerSessionId}:${browserSessionId}`); return state },
    navigate: async (ownerSessionId, input) => { calls.push(`navigate:${ownerSessionId}:${input.url}`); return state },
    goBack: async (ownerSessionId) => { calls.push(`back:${ownerSessionId}`) },
    goForward: async (ownerSessionId) => { calls.push(`forward:${ownerSessionId}`) },
    reload: async (ownerSessionId) => { calls.push(`reload:${ownerSessionId}`) },
    stop: async (ownerSessionId) => { calls.push(`stop:${ownerSessionId}`) },
    setZoom: async (ownerSessionId, input) => { calls.push(`zoom:${ownerSessionId}:${input.action}`); return state },
    setFitToWidth: async (ownerSessionId, input) => { calls.push(`fit:${ownerSessionId}:${input.enabled}`); return state },
    setLayout: (ownerSessionId, input) => { calls.push(`layout:${ownerSessionId}:${input.revision}`); return true },
    selectElement: async (ownerSessionId) => { calls.push(`select:${ownerSessionId}`); return { status: 'cancelled', reason: 'toolbar' } },
    cancelElementSelection: async (ownerSessionId, browserSessionId, reason) => { calls.push(`cancel-select:${ownerSessionId}:${browserSessionId}:${reason}`); return true },
    close: async (ownerSessionId, browserSessionId) => { calls.push(`close:${ownerSessionId}:${browserSessionId}`); return true },
  }, {
    assertSender: (senderId) => {
      if (senderId !== 42) throw new Error('仅主窗口可以操作内置浏览器。')
    },
  })
  return { handlers, calls }
}

describe('浏览器 IPC', () => {
  test('Given the main renderer and exact open input When opening Then the owner identity reaches the service', async () => {
    const { handlers, calls } = setup()

    const result = await handlers.get(BROWSER_IPC_CHANNELS.OPEN)!({ sender: { id: 42 } }, {
      ownerSessionId: 'session-1',
      url: 'https://example.com',
    })

    expect(result).toEqual(state)
    expect(calls).toEqual(['open:session-1:https://example.com'])
  })

  test('Given another renderer or forged fields When invoking Then the request is rejected before service access', async () => {
    const { handlers, calls } = setup()
    const open = handlers.get(BROWSER_IPC_CHANNELS.OPEN)!

    await expect(open({ sender: { id: 7 } }, { ownerSessionId: 'session-1' })).rejects.toThrow('仅主窗口')
    await expect(open({ sender: { id: 42 } }, { ownerSessionId: 'session-1', workspaceId: 'forged' })).rejects.toThrow('无效')
    expect(calls).toEqual([])
  })

  test('Given zoom controls When invoking Then only fixed actions and boolean fit state are accepted', async () => {
    const { handlers, calls } = setup()
    const zoom = handlers.get(BROWSER_IPC_CHANNELS.SET_ZOOM)!
    const fit = handlers.get(BROWSER_IPC_CHANNELS.SET_FIT_TO_WIDTH)!
    const page = { ownerSessionId: 'session-1', browserSessionId: 'browser-1', pageId: 'page-1' }

    await zoom({ sender: { id: 42 } }, { ...page, action: 'decrease' })
    await fit({ sender: { id: 42 } }, { ...page, enabled: true })
    await expect(zoom({ sender: { id: 42 } }, { ...page, action: '250%' })).rejects.toThrow('无效')
    await expect(fit({ sender: { id: 42 } }, { ...page, enabled: 'yes' })).rejects.toThrow('无效')

    expect(calls).toEqual(['zoom:session-1:decrease', 'fit:session-1:true'])
  })

  test('Given element selection IPC When invoking Then it accepts only opaque page identity and fixed cancellation', async () => {
    const { handlers, calls } = setup()
    const page = { ownerSessionId: 'session-1', browserSessionId: 'browser-1', pageId: 'page-1' }

    await handlers.get(BROWSER_IPC_CHANNELS.SELECT_ELEMENT)!({ sender: { id: 42 } }, page)
    await handlers.get(BROWSER_IPC_CHANNELS.CANCEL_ELEMENT_SELECTION)!({ sender: { id: 42 } }, {
      ownerSessionId: 'session-1', browserSessionId: 'browser-1', reason: 'toolbar',
    })
    await expect(handlers.get(BROWSER_IPC_CHANNELS.SELECT_ELEMENT)!({ sender: { id: 42 } }, {
      ...page, selector: '#password',
    })).rejects.toThrow('无效')
    await expect(handlers.get(BROWSER_IPC_CHANNELS.CANCEL_ELEMENT_SELECTION)!({ sender: { id: 42 } }, {
      ownerSessionId: 'session-1', browserSessionId: 'browser-1', reason: 'run-script',
    })).rejects.toThrow('无效')

    expect(calls).toEqual(['select:session-1', 'cancel-select:session-1:browser-1:toolbar'])
  })

  test('Given layout bounds When revision or geometry is invalid Then the host is not called', async () => {
    const { handlers, calls } = setup()
    const layout = handlers.get(BROWSER_IPC_CHANNELS.SET_LAYOUT)!

    await expect(layout({ sender: { id: 42 } }, {
      ownerSessionId: 'session-1', browserSessionId: 'browser-1', pageId: 'page-1',
      revision: 1.5, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 },
    })).rejects.toThrow('无效')
    await expect(layout({ sender: { id: 42 } }, {
      ownerSessionId: 'session-1', browserSessionId: 'browser-1', pageId: 'page-1',
      revision: 2, visible: true, bounds: { x: 0, y: 0, width: -1, height: 600 },
    })).rejects.toThrow('无效')
    expect(calls).toEqual([])
  })
})
