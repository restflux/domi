import { lookup } from 'node:dns/promises'
import type {
  BrowserPageLoadState,
  BrowserPageView,
  BrowserProfileKind,
  BrowserBounds,
  BrowserZoomAction,
} from '@domi/shared'
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron'
import {
  BrowserNavigationPolicyError,
  validateBrowserNavigationUrl,
  validateBrowserRequestUrl,
  type BrowserAddressResolver,
} from './browser-url-policy.ts'
import { isBrowserPermissionAllowed } from './browser-permission-policy.ts'
import {
  BrowserCdpFacade,
  BrowserCdpFacadeError,
  type BrowserCdpSnapshot,
  type BrowserCdpTransport,
  type BrowserElementRefRecord,
} from './browser-cdp-facade.ts'
import { computeFitZoomPercent, nextBrowserZoomPercent } from './browser-zoom-policy.ts'
import type { BrowserScrollDirection, BrowserScrollDistance } from './browser-operation-policy.ts'
import {
  BROWSER_ELEMENT_SELECTION_SCRIPT,
  BROWSER_ELEMENT_SELECTION_WORLD_ID,
  buildBrowserElementSelectionCancelScript,
  normalizeBrowserElementSelectionCandidate,
  type BrowserElementSelectionCandidate,
  type BrowserElementSelectionCancelReason,
} from './browser-element-selection.ts'

export type BrowserPageHostState = BrowserPageView

export type BrowserPageHostUpdate =
  | { type: 'state'; state: BrowserPageHostState }
  | { type: 'crashed'; state: BrowserPageHostState }
  | { type: 'focus-escape'; state: BrowserPageHostState }

export interface BrowserPageHost {
  readonly pageId: string
  readonly profilePartition: string
  getState(): BrowserPageHostState
  navigate(url: string, beforeCommit?: () => void): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  setZoom(action: BrowserZoomAction): void | Promise<void>
  setFitToWidth(enabled: boolean): void | Promise<void>
  selectElement(): Promise<BrowserElementSelectionCandidate>
  cancelElementSelection(reason: BrowserElementSelectionCancelReason): Promise<boolean>
  snapshot(): Promise<BrowserCdpSnapshot>
  resolveRef(ref: string): Promise<BrowserElementRefRecord>
  click(ref: string): Promise<{ ref: string; navigationEpoch: number }>
  type(ref: string, text: string, replace?: boolean): Promise<{ ref: string; textLength: number; replace: boolean }>
  scroll(direction: BrowserScrollDirection, distance: BrowserScrollDistance): Promise<{ deltaX: number; deltaY: number }>
  extract(ref: string, maxChars: number): Promise<{ ref: string; text: string; truncated: boolean }>
  setLayout(input: { revision: number; visible: boolean; bounds: BrowserBounds }): boolean
  destroy(): void | Promise<void>
}

export interface CreateElectronBrowserPageHostInput {
  pageId: string
  profilePartition: string
  profileKind: BrowserProfileKind
  window: BrowserWindow
  view: WebContentsView
  onUpdate: (update: BrowserPageHostUpdate) => void
  resolveAddresses?: BrowserAddressResolver
}

const protectedSessions = new WeakSet<Session>()
const pendingMainFrameNavigationUrls = new WeakMap<WebContents, string>()

export class ElectronBrowserPageHost implements BrowserPageHost {
  readonly pageId: string
  readonly profilePartition: string
  private readonly window: BrowserWindow
  private readonly view: WebContentsView
  private readonly webContents: WebContents
  private readonly profileKind: BrowserProfileKind
  private readonly browserSession: Session
  private readonly onUpdate: (update: BrowserPageHostUpdate) => void
  private readonly resolveAddresses: BrowserAddressResolver
  private readonly cdpFacade: BrowserCdpFacade
  private state: BrowserPageHostState
  private layoutRevision = -1
  private fitRevision = 0
  private latestBounds: BrowserBounds | null = null
  private fitContentWidth: number | null = null
  private debuggerReady: Promise<void> | null = null
  private destroyed = false
  private attached = false

  constructor(input: CreateElectronBrowserPageHostInput) {
    this.pageId = input.pageId
    this.profilePartition = input.profilePartition
    this.window = input.window
    this.view = input.view
    this.webContents = input.view.webContents
    this.profileKind = input.profileKind
    this.browserSession = this.webContents.session
    this.onUpdate = input.onUpdate
    this.resolveAddresses = input.resolveAddresses ?? resolveHostnameAddresses
    this.state = {
      pageId: input.pageId,
      title: '新标签页',
      url: 'about:blank',
      loadState: 'idle',
      canGoBack: false,
      canGoForward: false,
      navigationEpoch: 0,
      visible: false,
      zoomPercent: 100,
      fitToWidth: false,
    }
    this.cdpFacade = new BrowserCdpFacade({
      pageId: input.pageId,
      transport: createBrowserCdpTransport(this.webContents),
      getNavigationEpoch: () => this.state.navigationEpoch,
      onDocumentRootReplaced: () => {
        const navigationEpoch = this.state.navigationEpoch + 1
        this.cdpFacade.invalidateRefs()
        this.patchState({ navigationEpoch })
        return navigationEpoch
      },
    })

    installSessionSafetyPolicy(this.browserSession, this.resolveAddresses)
    this.installPageListeners()
    this.webContents.once('dom-ready', () => {
      this.debuggerReady = this.installFileChooserGuard()
      void this.debuggerReady.catch((error) => {
        this.patchState({ loadState: 'failed', error: '浏览器安全控制初始化失败。' })
        this.view.setVisible(false)
        console.error('[浏览器] 文件选择器拦截初始化失败:', error)
      })
    })
    this.window.contentView.addChildView(this.view)
    this.attached = true
    this.view.setVisible(false)
  }

  getState(): BrowserPageHostState {
    return { ...this.state }
  }

  async navigate(input: string, beforeCommit?: () => void): Promise<void> {
    this.assertAlive()
    const validated = await validateBrowserNavigationUrl(input, this.resolveAddresses)
    beforeCommit?.()
    pendingMainFrameNavigationUrls.set(this.webContents, validated.url)
    try {
      await this.webContents.loadURL(validated.url)
    } catch (error) {
      pendingMainFrameNavigationUrls.delete(this.webContents)
      const message = error instanceof Error ? error.message : '页面加载失败。'
      this.patchState({ loadState: 'failed', error: message })
      throw error
    }
  }

  goBack(): void {
    this.assertAlive()
    if (this.webContents.navigationHistory.canGoBack()) this.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    this.assertAlive()
    if (this.webContents.navigationHistory.canGoForward()) this.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.assertAlive()
    this.webContents.reload()
  }

  stop(): void {
    if (this.destroyed) return
    this.webContents.stop()
    this.patchState({ loadState: 'ready' })
  }

  async selectElement(): Promise<BrowserElementSelectionCandidate> {
    this.assertAlive()
    if (this.state.loadState !== 'ready') {
      throw new Error('页面仍在加载，暂时不能选择网页元素。')
    }
    const navigationEpoch = this.state.navigationEpoch
    try {
      const value = await this.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_ELEMENT_SELECTION_WORLD_ID,
        [{ code: BROWSER_ELEMENT_SELECTION_SCRIPT }],
        true,
      )
      if (this.destroyed || this.state.navigationEpoch !== navigationEpoch) {
        return { status: 'cancelled', reason: 'navigation' }
      }
      return normalizeBrowserElementSelectionCandidate(value)
    } catch (error) {
      if (this.destroyed || this.state.navigationEpoch !== navigationEpoch) {
        return { status: 'cancelled', reason: 'navigation' }
      }
      throw error
    }
  }

  async cancelElementSelection(reason: BrowserElementSelectionCancelReason): Promise<boolean> {
    if (this.destroyed) return false
    try {
      return Boolean(await this.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_ELEMENT_SELECTION_WORLD_ID,
        [{ code: buildBrowserElementSelectionCancelScript(reason) }],
      ))
    } catch {
      return false
    }
  }

  async snapshot(): Promise<BrowserCdpSnapshot> {
    this.assertAlive()
    if (this.state.loadState !== 'ready') {
      throw new BrowserCdpFacadeError('page_not_ready', '页面仍在加载或尚未就绪，请稍后重试 Browser Snapshot。')
    }
    return this.cdpFacade.snapshot()
  }

  resolveRef(ref: string): Promise<BrowserElementRefRecord> {
    this.assertAlive()
    return this.cdpFacade.resolveRef(ref)
  }

  click(ref: string): Promise<{ ref: string; navigationEpoch: number }> {
    this.assertAlive()
    return this.cdpFacade.click(ref)
  }

  type(ref: string, text: string, replace = true): Promise<{ ref: string; textLength: number; replace: boolean }> {
    this.assertAlive()
    return this.cdpFacade.type(ref, text, replace)
  }

  scroll(direction: BrowserScrollDirection, distance: BrowserScrollDistance): Promise<{ deltaX: number; deltaY: number }> {
    this.assertAlive()
    const bounds = this.latestBounds ?? { x: 0, y: 0, width: 1024, height: 768 }
    return this.cdpFacade.scroll(direction, distance, { width: bounds.width, height: bounds.height })
  }

  extract(ref: string, maxChars: number): Promise<{ ref: string; text: string; truncated: boolean }> {
    this.assertAlive()
    return this.cdpFacade.extract(ref, maxChars)
  }

  setZoom(action: BrowserZoomAction): void {
    this.assertAlive()
    this.fitRevision += 1
    this.fitContentWidth = null
    const zoomPercent = nextBrowserZoomPercent(this.state.zoomPercent, action)
    this.webContents.setZoomFactor(zoomPercent / 100)
    this.patchState({ zoomPercent, fitToWidth: false })
  }

  async setFitToWidth(enabled: boolean): Promise<void> {
    this.assertAlive()
    this.fitRevision += 1
    if (!enabled) {
      this.fitContentWidth = null
      this.patchState({ fitToWidth: false })
      return
    }
    this.fitContentWidth = null
    this.webContents.setZoomFactor(1)
    this.patchState({ fitToWidth: true, zoomPercent: 100 })
    await this.applyFitToWidth(this.fitRevision, true)
  }

  setLayout(input: { revision: number; visible: boolean; bounds: BrowserBounds }): boolean {
    if (this.destroyed || input.revision <= this.layoutRevision) return false
    this.layoutRevision = input.revision
    const bounds = clampBrowserBounds(input.bounds, this.window.getContentBounds())
    this.latestBounds = bounds
    const visible = input.visible && bounds.width > 4 && bounds.height > 4
    if (visible) this.view.setBounds(bounds)
    this.view.setVisible(visible)
    this.patchState({ visible })
    if (visible && this.state.fitToWidth) {
      this.fitRevision += 1
      this.scheduleFitToWidth(this.fitRevision)
    }
    return true
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    pendingMainFrameNavigationUrls.delete(this.webContents)
    this.view.setVisible(false)
    if (this.attached && !this.window.isDestroyed()) {
      try {
        this.window.contentView.removeChildView(this.view)
      } catch {
        // 窗口销毁路径可能已经移除原生子视图；清理保持幂等。
      }
    }
    this.attached = false
    this.cdpFacade.dispose()
    if (!this.webContents.isDestroyed()) {
      if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach()
      this.webContents.close()
    }
    if (this.profileKind === 'temporary') {
      await Promise.allSettled([
        this.browserSession.clearStorageData(),
        this.browserSession.clearCache(),
      ])
    }
  }

  private async installFileChooserGuard(): Promise<void> {
    const pageDebugger = this.webContents.debugger
    if (!pageDebugger.isAttached()) pageDebugger.attach('1.3')
    pageDebugger.on('message', (_event, method, params) => {
      if (method !== 'Page.fileChooserOpened' || this.destroyed) return
      const backendNodeId = (params as { backendNodeId?: number }).backendNodeId
      if (!backendNodeId) return
      void pageDebugger.sendCommand('DOM.setFileInputFiles', { files: [], backendNodeId })
        .catch((error) => console.warn('[浏览器] 拒绝文件上传失败:', error))
    })
    await pageDebugger.sendCommand('Page.enable')
    await pageDebugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  }

  private scheduleFitToWidth(revision: number): void {
    void this.applyFitToWidth(revision)
      .catch((error) => console.warn('[浏览器] 适应宽度计算失败:', error))
  }

  private async applyFitToWidth(revision: number, forceMeasure = false): Promise<void> {
    if (!this.state.fitToWidth || !this.latestBounds || this.latestBounds.width <= 4 || this.destroyed) return
    let contentWidth = this.fitContentWidth
    if (forceMeasure || !contentWidth || this.state.zoomPercent === 100) {
      if (this.state.zoomPercent !== 100) this.webContents.setZoomFactor(1)
      contentWidth = await this.measureDocumentContentWidth()
      this.fitContentWidth = contentWidth
    }
    if (revision !== this.fitRevision || !this.state.fitToWidth || this.destroyed) return
    const zoomPercent = computeFitZoomPercent({ slotWidth: this.latestBounds.width, contentWidth })
    this.webContents.setZoomFactor(zoomPercent / 100)
    this.patchState({ zoomPercent, fitToWidth: true })
  }

  private async measureDocumentContentWidth(): Promise<number> {
    if (this.debuggerReady) await this.debuggerReady
    if (!this.webContents.debugger.isAttached()) return this.latestBounds?.width ?? 0
    const response = await this.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'Math.max(document.documentElement?.scrollWidth || 0, document.documentElement?.offsetWidth || 0, document.body?.scrollWidth || 0, document.body?.offsetWidth || 0)',
      returnByValue: true,
      awaitPromise: false,
    }) as { result?: { value?: unknown } }
    const value = response.result?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : this.latestBounds?.width ?? 0
  }

  private installPageListeners(): void {
    this.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      this.onUpdate({ type: 'focus-escape', state: this.getState() })
    })
    this.webContents.on('will-navigate', (event, url) => {
      if (!isStructurallyAllowedNavigation(url)) event.preventDefault()
    })
    this.webContents.on('will-redirect', (event, url) => {
      if (!isStructurallyAllowedNavigation(url)) event.preventDefault()
    })
    this.webContents.on('did-start-loading', () => {
      this.cdpFacade.invalidateRefs()
      if (this.state.fitToWidth) {
        this.fitRevision += 1
        this.fitContentWidth = null
        this.webContents.setZoomFactor(1)
        this.patchState({ loadState: 'loading', error: undefined, zoomPercent: 100 })
      } else {
        this.patchState({ loadState: 'loading', error: undefined })
      }
    })
    this.webContents.on('did-stop-loading', () => {
      this.refreshNavigationState('ready')
      if (this.state.fitToWidth) {
        this.fitRevision += 1
        this.scheduleFitToWidth(this.fitRevision)
      }
    })
    this.webContents.on('did-navigate', (_event, url) => this.commitNavigation(url))
    this.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.commitNavigation(url)
    })
    this.webContents.on('page-title-updated', (_event, title) => this.patchState({ title }))
    this.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.patchState({
        url: validatedURL || this.state.url,
        loadState: 'failed',
        error: errorDescription || '页面加载失败。',
      })
    })
    this.webContents.on('render-process-gone', (_event, details) => {
      this.cdpFacade.invalidateRefs()
      this.state = {
        ...this.state,
        navigationEpoch: this.state.navigationEpoch + 1,
        loadState: 'failed',
        error: `页面进程已退出：${details.reason}`,
        visible: false,
      }
      this.view.setVisible(false)
      this.onUpdate({ type: 'crashed', state: this.getState() })
    })
  }

  private commitNavigation(url: string): void {
    pendingMainFrameNavigationUrls.delete(this.webContents)
    this.cdpFacade.invalidateRefs()
    this.state = {
      ...this.state,
      url,
      navigationEpoch: this.state.navigationEpoch + 1,
      error: undefined,
    }
    this.refreshNavigationState(this.webContents.isLoading() ? 'loading' : 'ready')
  }

  private refreshNavigationState(loadState: BrowserPageLoadState): void {
    this.patchState({
      url: this.webContents.getURL() || this.state.url,
      title: this.webContents.getTitle() || this.state.title,
      loadState,
      canGoBack: this.webContents.navigationHistory.canGoBack(),
      canGoForward: this.webContents.navigationHistory.canGoForward(),
    })
  }

  private patchState(patch: Partial<BrowserPageHostState>): void {
    if (this.destroyed) return
    this.state = { ...this.state, ...patch }
    this.onUpdate({ type: 'state', state: this.getState() })
  }

  private assertAlive(): void {
    if (this.destroyed || this.webContents.isDestroyed()) throw new Error('浏览器页面已关闭。')
  }
}

export function clampBrowserBounds(
  bounds: BrowserBounds,
  content: Pick<BrowserBounds, 'width' | 'height'>,
): BrowserBounds {
  const x = Math.max(0, Math.min(Math.round(bounds.x), Math.max(0, content.width)))
  const y = Math.max(0, Math.min(Math.round(bounds.y), Math.max(0, content.height)))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width), Math.max(0, content.width - x))),
    height: Math.max(0, Math.min(Math.round(bounds.height), Math.max(0, content.height - y))),
  }
}

export function createBrowserWebPreferences(partition: string): Electron.WebPreferences {
  return {
    partition,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  }
}

function installSessionSafetyPolicy(browserSession: Session, resolveAddresses: BrowserAddressResolver): void {
  if (protectedSessions.has(browserSession)) return
  protectedSessions.add(browserSession)
  browserSession.setPermissionCheckHandler((_webContents, permission) => isBrowserPermissionAllowed(permission))
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isBrowserPermissionAllowed(permission))
  })
  browserSession.on('will-download', (event) => event.preventDefault())
  browserSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const pendingNavigationUrl = details.webContents
        ? pendingMainFrameNavigationUrls.get(details.webContents)
        : undefined
      const firstPartyUrl = details.resourceType === 'mainFrame'
        ? pendingNavigationUrl || details.webContents?.getURL()
        : details.referrer || pendingNavigationUrl || details.webContents?.getURL()
      void validateBrowserRequestUrl(details.url, firstPartyUrl, resolveAddresses)
        .then(() => callback({ cancel: false }))
        .catch(() => callback({ cancel: true }))
    },
  )
}

function isStructurallyAllowedNavigation(input: string): boolean {
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    const hostname = url.hostname.toLowerCase()
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false
    return true
  } catch {
    return false
  }
}

async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

function createBrowserCdpTransport(webContents: WebContents): BrowserCdpTransport {
  const pageDebugger = webContents.debugger
  return {
    isAttached: () => pageDebugger.isAttached(),
    attach: (protocolVersion) => pageDebugger.attach(protocolVersion),
    detach: () => pageDebugger.detach(),
    sendCommand: (method, params) => pageDebugger.sendCommand(method, params),
  }
}

export { BrowserNavigationPolicyError }
