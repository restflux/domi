import { WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserFocusEscapeRequest, BrowserStateChange, SessionTargetView } from '@domi/shared'
import { getAgentSessionMeta } from '../agent-session-manager.ts'
import { getSessionCheckoutModule } from '../session-checkout/production.ts'
import { BrowserSessionService, type BrowserOwnerContext } from './browser-session-service.ts'
import { createBrowserWebPreferences, ElectronBrowserPageHost } from './browser-page-host.ts'

export interface BrowserModuleOptions {
  getMainWindow: () => BrowserWindow | null
  sendState: (state: BrowserStateChange) => void
  sendFocusEscapeRequest: (request: BrowserFocusEscapeRequest) => void
  resolveOwner?: (sessionId: string) => BrowserOwnerContext | undefined
  resolveSessionTarget?: (sessionId: string) => Promise<SessionTargetView>
}

let browserService: BrowserSessionService | null = null

export function configureBrowserModule(options: BrowserModuleOptions): BrowserSessionService {
  browserService = new BrowserSessionService({
    resolveOwner: options.resolveOwner ?? resolveBrowserOwner,
    resolveSessionTarget: async (sessionId) => {
      const target = await (options.resolveSessionTarget ?? ((id) => getSessionCheckoutModule().inspect(id)))(sessionId)
      return {
        kind: target.checkout.kind,
        ...(target.checkout.kind === 'isolated' ? { checkoutId: target.checkout.id } : {}),
        revision: target.revision,
      }
    },
    createPageHost: ({ pageId, profile, onUpdate }) => {
      const window = options.getMainWindow()
      if (!window || window.isDestroyed()) throw new Error('主窗口尚未就绪，无法打开内置浏览器。')
      const view = new WebContentsView({ webPreferences: createBrowserWebPreferences(profile.partition) })
      return new ElectronBrowserPageHost({
        pageId,
        profilePartition: profile.partition,
        profileKind: profile.kind,
        window,
        view,
        onUpdate,
      })
    },
    onStateChanged: options.sendState,
    onFocusEscapeRequested: options.sendFocusEscapeRequest,
  })
  return browserService
}

export function peekBrowserSessionService(): BrowserSessionService | null {
  return browserService
}

export function getBrowserSessionService(): BrowserSessionService {
  if (!browserService) throw new Error('BrowserModule 尚未初始化。')
  return browserService
}

export async function disposeBrowserModule(): Promise<void> {
  await browserService?.destroyAll()
}

function resolveBrowserOwner(sessionId: string): BrowserOwnerContext | undefined {
  const session = getAgentSessionMeta(sessionId)
  if (!session?.workspaceId) return undefined
  return {
    ownerSessionId: session.id,
    workspaceId: session.workspaceId,
    source: session.sourceDelegationId
      ? 'delegation'
      : session.sourceAutomationId
        ? 'automation'
        : 'interactive',
  }
}
