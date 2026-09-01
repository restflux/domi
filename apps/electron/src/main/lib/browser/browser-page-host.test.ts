import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron'
import { clampBrowserBounds, createBrowserWebPreferences, ElectronBrowserPageHost, type BrowserPageHostUpdate } from './browser-page-host.ts'
import { BROWSER_ELEMENT_SELECTION_WORLD_ID } from './browser-element-selection.ts'

describe('BrowserPageHost 安全配置', () => {
  test('Given an arbitrary web page When creating WebContentsView preferences Then no Domi preload or Node capability is exposed', () => {
    const preferences = createBrowserWebPreferences('persist:domi-browser-test')

    expect(preferences).toMatchObject({
      partition: 'persist:domi-browser-test',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
    expect('preload' in preferences).toBe(false)
  })

  test('Given renderer bounds outside the main content When clamping Then the native view stays inside the window', () => {
    expect(clampBrowserBounds(
      { x: -20, y: 40, width: 1400, height: 900 },
      { width: 1200, height: 800 },
    )).toEqual({ x: 0, y: 40, width: 1200, height: 760 })
  })

  test('Given a public page When a redirect requests loopback Then the request is blocked while loopback pages can load loopback resources', async () => {
    const fixture = createPageHostFixture()

    await fixture.host.navigate('https://example.com/start')
    await expect(fixture.webContents.requestMainFrame('http://127.0.0.1:5173/private')).resolves.toBe(true)

    await fixture.host.navigate('http://localhost:5173/app')
    await expect(fixture.webContents.requestMainFrame('http://127.0.0.1:5173/app.js')).resolves.toBe(false)
  })

  test('Given a visible page snapshot When main-frame navigation or the semantic document root changes Then old refs fail closed', async () => {
    const fixture = createPageHostFixture()
    fixture.webContents.emit('did-stop-loading')
    const first = await fixture.host.snapshot()

    fixture.webContents.emit('did-start-loading')
    await expect(fixture.host.snapshot()).rejects.toMatchObject({ code: 'page_not_ready' })

    fixture.debuggerTransport.rootBackendNodeId = 9
    fixture.webContents.commitUrl('https://example.test/next')
    fixture.webContents.emit('did-navigate', {}, 'https://example.test/next')

    await expect(fixture.host.resolveRef(first.nodes[0]!.ref)).rejects.toMatchObject({ code: 'stale_ref' })
    const second = await fixture.host.snapshot()

    fixture.debuggerTransport.rootBackendNodeId = 20
    const third = await fixture.host.snapshot()

    expect(first).toMatchObject({ navigationEpoch: 0, nodes: [{ ref: 'e1' }] })
    expect(second).toMatchObject({ navigationEpoch: 1, nodes: [{ ref: 'e2' }] })
    expect(third).toMatchObject({ navigationEpoch: 2, nodes: [{ ref: 'e3' }] })
    expect(fixture.host.getState()).toMatchObject({ url: 'https://example.test/next', navigationEpoch: 2 })

    await fixture.host.destroy()
    expect(fixture.debuggerTransport.detachCalls).toBe(1)
    expect(fixture.webContents.closed).toBe(true)
  })

  test('Given a ready page When selecting an element Then only the fixed isolated-world script is executed', async () => {
    const fixture = createPageHostFixture()
    fixture.webContents.emit('did-stop-loading')
    fixture.webContents.isolatedWorldResult = {
      status: 'selected',
      element: { tagName: 'BUTTON', role: 'button', name: '启动', text: '启动' },
    }

    await expect(fixture.host.selectElement()).resolves.toEqual({
      status: 'selected',
      element: { tagName: 'button', role: 'button', name: '启动', text: '启动', truncated: false },
    })
    expect(fixture.webContents.isolatedWorldCalls).toHaveLength(1)
    expect(fixture.webContents.isolatedWorldCalls[0]?.worldId).toBe(BROWSER_ELEMENT_SELECTION_WORLD_ID)
    expect(fixture.webContents.isolatedWorldCalls[0]?.scripts).toHaveLength(1)
  })

  test('Given the embedded page owns keyboard focus When Escape is pressed Then Main emits a bounded focus-exit request', () => {
    const updates: BrowserPageHostUpdate[] = []
    const fixture = createPageHostFixture((update) => updates.push(update))

    fixture.webContents.emit('before-input-event', { preventDefault: () => undefined }, { type: 'keyDown', key: 'Escape' })
    fixture.webContents.emit('before-input-event', { preventDefault: () => undefined }, { type: 'keyDown', key: 'Enter' })

    expect(updates).toEqual([{ type: 'focus-escape', state: fixture.host.getState() }])
  })

  test('Given an active selector When cancelling Then the fixed cancellation script is used', async () => {
    const fixture = createPageHostFixture()
    fixture.webContents.isolatedWorldResult = true

    await expect(fixture.host.cancelElementSelection('toolbar')).resolves.toBe(true)
    expect(fixture.webContents.isolatedWorldCalls[0]?.scripts[0]?.code).toContain('"toolbar"')
  })
})

class FakeDebuggerTransport extends EventEmitter {
  attached = false
  detachCalls = 0
  rootBackendNodeId = 1

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false; this.detachCalls += 1 }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          { nodeId: `root-${this.rootBackendNodeId}`, role: { value: 'RootWebArea' }, backendDOMNodeId: this.rootBackendNodeId },
          {
            nodeId: `button-${this.rootBackendNodeId}`,
            parentId: `root-${this.rootBackendNodeId}`,
            role: { value: 'button' },
            name: { value: '继续' },
            backendDOMNodeId: this.rootBackendNodeId + 1,
          },
        ],
      }
    }
    if (method === 'DOM.describeNode') {
      return { node: { backendNodeId: params?.backendNodeId } }
    }
    return {}
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebuggerTransport()
  readonly session: Session
  private beforeRequest?: (
    details: { url: string; resourceType: string; referrer?: string; webContents?: WebContents },
    callback: (result: { cancel: boolean }) => void,
  ) => void
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => undefined,
    goForward: () => undefined,
  }
  closed = false
  isolatedWorldResult: unknown
  readonly isolatedWorldCalls: Array<{ worldId: number; scripts: Array<{ code: string }> }> = []
  private url = 'about:blank'

  constructor() {
    super()
    const browserSession = {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      on: () => undefined,
      webRequest: {
        onBeforeRequest: (_filter: unknown, listener: FakeWebContents['beforeRequest']) => { this.beforeRequest = listener },
      },
      clearStorageData: async () => undefined,
      clearCache: async () => undefined,
    }
    this.session = browserSession as unknown as Session
  }

  setWindowOpenHandler(): void {}
  async requestMainFrame(url: string): Promise<boolean> {
    return new Promise((resolve) => this.beforeRequest?.(
      { url, resourceType: 'mainFrame', webContents: this as unknown as WebContents },
      (result) => resolve(result.cancel),
    ))
  }
  async loadURL(url: string): Promise<void> { this.url = url }
  commitUrl(url: string): void { this.url = url }
  getURL(): string { return this.url }
  getTitle(): string { return '测试页面' }
  isLoading(): boolean { return false }
  isDestroyed(): boolean { return this.closed }
  close(): void { this.closed = true }
  stop(): void {}
  reload(): void {}
  setZoomFactor(): void {}
  async executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown> {
    this.isolatedWorldCalls.push({ worldId, scripts })
    return this.isolatedWorldResult
  }
}

function createPageHostFixture(onUpdate: (update: BrowserPageHostUpdate) => void = () => undefined): {
  host: ElectronBrowserPageHost
  webContents: FakeWebContents
  debuggerTransport: FakeDebuggerTransport
} {
  const webContents = new FakeWebContents()
  const view = {
    webContents: webContents as unknown as WebContents,
    setVisible: () => undefined,
    setBounds: () => undefined,
  } as unknown as WebContentsView
  const window = {
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    isDestroyed: () => false,
  } as unknown as BrowserWindow
  const host = new ElectronBrowserPageHost({
    pageId: 'page-1',
    profilePartition: 'persist:domi-browser-test',
    profileKind: 'project',
    window,
    view,
    onUpdate,
    resolveAddresses: async () => ['93.184.216.34'],
  })
  return { host, webContents, debuggerTransport: webContents.debugger }
}
