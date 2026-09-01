export type BrowserProfileKind = 'project' | 'temporary'
export type BrowserPageLoadState = 'idle' | 'loading' | 'ready' | 'failed'
export type BrowserControlSource = 'user' | 'agent' | 'automation' | 'delegation'
export type BrowserZoomAction = 'decrease' | 'increase' | 'reset'

export interface BrowserSourceTargetView {
  kind: 'local' | 'isolated'
  checkoutId?: string
  revision: number
  stale: boolean
}

export interface BrowserPageView {
  pageId: string
  title: string
  url: string
  loadState: BrowserPageLoadState
  error?: string
  canGoBack: boolean
  canGoForward: boolean
  navigationEpoch: number
  visible: boolean
  zoomPercent: number
  fitToWidth: boolean
}

export interface BrowserAgentControlView {
  runId: string
  sessionId: string
  source: BrowserControlSource
  displayName: string
  intent?: string
  startedAt: number
  stoppable: boolean
}

export interface BrowserSessionView {
  browserSessionId: string
  ownerSessionId: string
  workspaceId: string
  profileKind: BrowserProfileKind
  page: BrowserPageView | null
  control: BrowserAgentControlView | null
  sourceTarget?: BrowserSourceTargetView
}

export interface BrowserSessionClosed {
  browserSessionId: string
  ownerSessionId: string
  closed: true
}

export type BrowserStateChange = BrowserSessionView | BrowserSessionClosed

export type BrowserOpenDisposition = 'reuse-active' | 'new-tab'

export interface BrowserOpenInput {
  ownerSessionId: string
  url?: string
  disposition?: BrowserOpenDisposition
}

export interface BrowserInspectInput {
  ownerSessionId: string
  browserSessionId: string
}

export interface BrowserPageInput extends BrowserInspectInput {
  pageId: string
}

export interface BrowserNavigateInput extends BrowserPageInput {
  url: string
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserZoomInput extends BrowserPageInput {
  action: BrowserZoomAction
}

export interface BrowserFitToWidthInput extends BrowserPageInput {
  enabled: boolean
}

export interface BrowserLayoutInput extends BrowserPageInput {
  revision: number
  visible: boolean
  bounds: BrowserBounds
}

export interface BrowserElementSelectionInput extends BrowserPageInput {}

export interface BrowserElementSelectionCancelInput extends BrowserInspectInput {
  reason: 'toolbar' | 'session-switch'
}

export type BrowserElementSelectionCancelReason =
  | 'escape'
  | 'toolbar'
  | 'navigation'
  | 'close'
  | 'session-switch'
  | 'control'
  | 'replaced'
  | 'error'

export interface BrowserSelectedElementReference {
  browserSessionId: string
  ownerSessionId: string
  pageId: string
  navigationEpoch: number
  pageTitle: string
  pageUrl: string
  tagName: string
  role?: string
  name?: string
  text: string
  href?: string
  truncated: boolean
  contentTrust: 'untrusted-web-content'
}

export type BrowserElementSelectionResult =
  | { status: 'selected'; element: BrowserSelectedElementReference }
  | { status: 'cancelled'; reason: BrowserElementSelectionCancelReason }

export interface BrowserFocusEscapeRequest {
  ownerSessionId: string
  browserSessionId: string
  pageId: string
}

export interface BrowserActivateInput extends BrowserInspectInput {}

export interface BrowserCloseInput extends BrowserInspectInput {}
