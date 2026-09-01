import { describe, expect, test } from 'bun:test'
import type { BrowserCdpSnapshot, BrowserElementRefRecord } from './browser-cdp-facade.ts'
import type { BrowserPageHost, BrowserPageHostState, BrowserPageHostUpdate } from './browser-page-host.ts'
import type { BrowserElementSelectionCandidate, BrowserElementSelectionCancelReason } from './browser-element-selection.ts'
import { BrowserSessionService, BrowserSessionServiceError } from './browser-session-service.ts'

class FakePageHost implements BrowserPageHost {
  readonly pageId: string
  readonly profilePartition: string
  state: BrowserPageHostState
  destroyCalls = 0
  layoutRevisions: number[] = []
  navigations: string[] = []
  navigationGate: Promise<void> | null = null
  selectionResult: BrowserElementSelectionCandidate = {
    status: 'selected',
    element: { tagName: 'button', role: 'button', name: '继续', text: '继续', truncated: false },
  }
  selectionGate: Promise<BrowserElementSelectionCandidate> | null = null
  selectionResolve: ((value: BrowserElementSelectionCandidate) => void) | null = null
  readonly selectionCancelCalls: BrowserElementSelectionCancelReason[] = []

  constructor(pageId: string, profilePartition: string, private readonly onUpdate: (update: BrowserPageHostUpdate) => void) {
    this.pageId = pageId
    this.profilePartition = profilePartition
    this.state = {
      pageId,
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
  }

  getState(): BrowserPageHostState { return { ...this.state } }
  emitFocusEscape(): void { this.onUpdate({ type: 'focus-escape', state: this.getState() }) }
  async navigate(url: string, beforeCommit?: () => void): Promise<void> {
    if (this.navigationGate) await this.navigationGate
    beforeCommit?.()
    this.navigations.push(url)
    this.state = { ...this.state, url, navigationEpoch: this.state.navigationEpoch + 1 }
    this.onUpdate({ type: 'state', state: this.getState() })
  }
  goBack(): void {}
  goForward(): void {}
  reload(): void {}
  stop(): void {}
  async snapshot(): Promise<BrowserCdpSnapshot> {
    return {
      pageId: this.pageId,
      navigationEpoch: this.state.navigationEpoch,
      contentTrust: 'untrusted-web-content',
      nodes: [{ ref: 'e1', role: 'button', name: '继续', depth: 1 }],
      truncated: false,
      textBytes: 8,
    }
  }
  async resolveRef(ref: string): Promise<BrowserElementRefRecord> {
    return { ref, pageId: this.pageId, navigationEpoch: this.state.navigationEpoch, backendDOMNodeId: 1 }
  }
  async click(ref: string): Promise<{ ref: string; navigationEpoch: number }> {
    return { ref, navigationEpoch: this.state.navigationEpoch }
  }
  async type(ref: string, text: string, replace = true): Promise<{ ref: string; textLength: number; replace: boolean }> {
    return { ref, textLength: text.length, replace }
  }
  async scroll(): Promise<{ deltaX: number; deltaY: number }> {
    return { deltaX: 0, deltaY: 400 }
  }
  async extract(ref: string): Promise<{ ref: string; text: string; truncated: boolean }> {
    return { ref, text: 'content', truncated: false }
  }
  async selectElement(): Promise<BrowserElementSelectionCandidate> {
    return this.selectionGate ?? this.selectionResult
  }
  async cancelElementSelection(reason: BrowserElementSelectionCancelReason): Promise<boolean> {
    this.selectionCancelCalls.push(reason)
    this.selectionResolve?.({ status: 'cancelled', reason })
    return true
  }
  beginPendingSelection(): void {
    this.selectionGate = new Promise((resolve) => { this.selectionResolve = resolve })
  }
  setZoom(action: 'decrease' | 'increase' | 'reset'): void {
    const delta = action === 'decrease' ? -10 : action === 'increase' ? 10 : 0
    this.state = { ...this.state, zoomPercent: action === 'reset' ? 100 : this.state.zoomPercent + delta, fitToWidth: false }
  }
  setFitToWidth(enabled: boolean): void {
    this.state = { ...this.state, fitToWidth: enabled, zoomPercent: enabled ? 70 : this.state.zoomPercent }
  }
  setLayout(input: { revision: number; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }): boolean {
    this.layoutRevisions.push(input.revision)
    this.state = { ...this.state, visible: input.visible }
    return true
  }
  destroy(): void { this.destroyCalls += 1 }
}

function setup(): {
  service: BrowserSessionService
  hosts: FakePageHost[]
  targetRevision: { value: number }
  focusEscapeRequests: Array<{ ownerSessionId: string; browserSessionId: string; pageId: string }>
} {
  const hosts: FakePageHost[] = []
  const focusEscapeRequests: Array<{ ownerSessionId: string; browserSessionId: string; pageId: string }> = []
  const targetRevision = { value: 3 }
  const service = new BrowserSessionService({
    resolveOwner: (sessionId) => {
      if (sessionId === 'missing') return undefined
      return {
        ownerSessionId: sessionId,
        workspaceId: sessionId === 'session-2' ? 'workspace-2' : 'workspace-1',
        source: sessionId.startsWith('automation') ? 'automation' : sessionId.startsWith('delegation') ? 'delegation' : 'interactive',
      }
    },
    resolveSessionTarget: async () => ({
      kind: 'isolated',
      checkoutId: 'checkout-1',
      revision: targetRevision.value,
    }),
    createPageHost: (input) => {
      const host = new FakePageHost(input.pageId, input.profile.partition, input.onUpdate)
      hosts.push(host)
      return host
    },
    createId: (() => {
      let id = 0
      return (prefix) => `${prefix}-${++id}`
    })(),
    onFocusEscapeRequested: (request) => focusEscapeRequests.push(request),
  })
  return { service, hosts, targetRevision, focusEscapeRequests }
}

describe('BrowserSessionService', () => {
  test('Given one owner session When opening repeatedly Then one browser session and page are reused', async () => {
    const { service, hosts } = setup()

    const first = await service.open({ ownerSessionId: 'session-1', url: 'https://example.com' })
    const second = await service.open({ ownerSessionId: 'session-1' })

    expect(second.browserSessionId).toBe(first.browserSessionId)
    expect(second.page?.pageId).toBe(first.page?.pageId)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.navigations).toEqual(['https://example.com'])
  })

  test('Given a page-focused Escape When no element selection is active Then the owning Browser tab receives the focus-exit request', async () => {
    const { service, hosts, focusEscapeRequests } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })

    hosts[0]?.emitFocusEscape()

    expect(focusEscapeRequests).toEqual([{
      ownerSessionId: 'session-1',
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
    }])
  })

  test('Given one Work session When opening new tabs Then independent Browser sessions coexist and activate explicitly', async () => {
    const { service, hosts } = setup()
    const first = await service.open({ ownerSessionId: 'session-1' })
    const second = await service.open({ ownerSessionId: 'session-1', disposition: 'new-tab' })

    expect(second.browserSessionId).not.toBe(first.browserSessionId)
    expect(second.page?.pageId).not.toBe(first.page?.pageId)
    expect(hosts).toHaveLength(2)
    expect((await service.inspectOwner('session-1')).browserSessionId).toBe(second.browserSessionId)

    await service.activate('session-1', first.browserSessionId)
    expect((await service.inspectOwner('session-1')).browserSessionId).toBe(first.browserSessionId)
  })

  test('Given two Browser tabs When one closes Then the other page remains alive and becomes the active fallback', async () => {
    const { service, hosts } = setup()
    const first = await service.open({ ownerSessionId: 'session-1' })
    const second = await service.open({ ownerSessionId: 'session-1', disposition: 'new-tab' })

    await expect(service.close('session-1', second.browserSessionId)).resolves.toBe(true)

    expect(hosts[1]?.destroyCalls).toBe(1)
    expect(hosts[0]?.destroyCalls).toBe(0)
    expect((await service.inspectOwner('session-1')).browserSessionId).toBe(first.browserSessionId)
  })

  test('Given an owner is deleted When multiple Browser tabs exist Then every page is destroyed', async () => {
    const { service, hosts } = setup()
    await service.open({ ownerSessionId: 'session-1' })
    await service.open({ ownerSessionId: 'session-1', disposition: 'new-tab' })

    await expect(service.closeOwner('session-1')).resolves.toBe(true)

    expect(hosts[0]?.destroyCalls).toBe(1)
    expect(hosts[1]?.destroyCalls).toBe(1)
    await expect(service.inspectOwner('session-1')).rejects.toMatchObject({ code: 'session_not_found' })
  })

  test('Given Agent controls one Browser tab When user activates another Then atomic operations remain bound to the controlled tab', async () => {
    const { service, hosts } = setup()
    const first = await service.open({ ownerSessionId: 'session-1' })
    const second = await service.open({ ownerSessionId: 'session-1', disposition: 'new-tab' })
    await service.activate('session-1', first.browserSessionId)
    await service.beginControl('session-1', {
      runId: 'run-bound', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', startedAt: 1, stoppable: true,
    })

    await service.activate('session-1', second.browserSessionId)
    await service.navigateOwner('session-1', 'run-bound', 'https://controlled.example')

    expect(hosts[0]?.navigations).toEqual(['https://controlled.example'])
    expect(hosts[1]?.navigations).toEqual([])
  })

  test('Given an owner session When another session controls its opaque ids Then access is rejected', async () => {
    const { service } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })

    expect(() => service.assertOwnedSession('session-2', opened.browserSessionId, opened.page!.pageId))
      .toThrow(BrowserSessionServiceError)
  })

  test('Given a target revision change When projecting state Then source target becomes stale without taking checkout ownership', async () => {
    const { service, targetRevision } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })
    expect(opened.sourceTarget?.stale).toBe(false)

    targetRevision.value = 4
    const refreshed = await service.inspect('session-1', opened.browserSessionId)

    expect(refreshed.sourceTarget).toMatchObject({ checkoutId: 'checkout-1', revision: 4, stale: true })
  })

  test('Given automation and delegation owners When opening Then their profiles are temporary', async () => {
    const { service } = setup()

    const automation = await service.open({ ownerSessionId: 'automation-1' })
    const delegation = await service.open({ ownerSessionId: 'delegation-1' })

    expect(automation.profileKind).toBe('temporary')
    expect(delegation.profileKind).toBe('temporary')
  })

  test('Given a run completes When cleaning temporary owners Then automation closes while interactive project state remains', async () => {
    const { service, hosts } = setup()
    const interactive = await service.open({ ownerSessionId: 'session-1' })
    await service.open({ ownerSessionId: 'automation-1' })

    expect(await service.closeTemporaryOwner('session-1')).toBe(false)
    expect(await service.closeTemporaryOwner('automation-1')).toBe(true)
    expect(await service.inspect('session-1', interactive.browserSessionId)).toMatchObject({ profileKind: 'project' })
    expect(hosts.map((host) => host.destroyCalls)).toEqual([0, 1])
  })

  test('Given repeated close and cleanup When destroying Then the page host is destroyed exactly once', async () => {
    const { service, hosts } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })

    expect(await service.close('session-1', opened.browserSessionId)).toBe(true)
    expect(await service.close('session-1', opened.browserSessionId)).toBe(false)
    await service.destroyAll()

    expect(hosts[0]?.destroyCalls).toBe(1)
  })

  test('Given an owned Browser Session When requesting a semantic snapshot Then the service returns the Main-owned page observation', async () => {
    const { service } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })

    const snapshot = await service.snapshot('session-1', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
    })

    expect(snapshot).toMatchObject({
      pageId: opened.page!.pageId,
      navigationEpoch: 0,
      contentTrust: 'untrusted-web-content',
      nodes: [{ ref: 'e1', role: 'button', name: '继续' }],
    })
    await expect(service.snapshot('session-2', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
    })).rejects.toMatchObject({ code: 'access_denied' })
    await expect(service.resolveRef('session-2', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
    }, 'e1')).rejects.toMatchObject({ code: 'access_denied' })
  })

  test('Given a user selects an element When projecting the result Then Main supplies current page identity and untrusted provenance', async () => {
    const { service, hosts } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1', url: 'https://example.com/docs' })
    hosts[0]!.state = { ...hosts[0]!.state, title: 'Documentation' }

    await expect(service.selectElement('session-1', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
    })).resolves.toEqual({
      status: 'selected',
      element: {
        browserSessionId: opened.browserSessionId,
        ownerSessionId: 'session-1',
        pageId: opened.page!.pageId,
        navigationEpoch: 1,
        pageTitle: 'Documentation',
        pageUrl: 'https://example.com/docs',
        tagName: 'button',
        role: 'button',
        name: '继续',
        text: '继续',
        truncated: false,
        contentTrust: 'untrusted-web-content',
      },
    })
  })

  test('Given selection is pending When Agent control begins Then selection is cancelled before control ownership changes', async () => {
    const { service, hosts, focusEscapeRequests } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })
    hosts[0]!.beginPendingSelection()

    const selection = service.selectElement('session-1', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hosts[0]!.emitFocusEscape()
    expect(focusEscapeRequests).toEqual([])
    const controlled = await service.beginControl('session-1', {
      runId: 'run-1', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', startedAt: 1, stoppable: true,
    })

    await expect(selection).resolves.toEqual({ status: 'cancelled', reason: 'control' })
    expect(hosts[0]!.selectionCancelCalls).toEqual(['control'])
    expect(controlled.control?.runId).toBe('run-1')
  })

  test('Given selection is pending When another selection or another session operates Then concurrency and ownership stay isolated', async () => {
    const { service, hosts } = setup()
    const first = await service.open({ ownerSessionId: 'session-1' })
    await service.open({ ownerSessionId: 'session-2' })
    hosts[0]!.beginPendingSelection()

    const selection = service.selectElement('session-1', {
      browserSessionId: first.browserSessionId,
      pageId: first.page!.pageId,
    })
    await Promise.resolve()
    await expect(service.selectElement('session-1', {
      browserSessionId: first.browserSessionId,
      pageId: first.page!.pageId,
    })).rejects.toMatchObject({ code: 'control_busy' })
    await expect(service.selectElement('session-2', {
      browserSessionId: first.browserSessionId,
      pageId: first.page!.pageId,
    })).rejects.toMatchObject({ code: 'access_denied' })

    await service.cancelElementSelection('session-1', first.browserSessionId, 'toolbar')
    await expect(selection).resolves.toEqual({ status: 'cancelled', reason: 'toolbar' })
  })

  test('Given fit mode and manual zoom When controlling a page Then Main state owns the zoom and manual actions exit fit', async () => {
    const { service } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })
    const page = { ownerSessionId: 'session-1', browserSessionId: opened.browserSessionId, pageId: opened.page!.pageId }

    await service.setFitToWidth('session-1', { ...page, enabled: true })
    expect((await service.inspect('session-1', opened.browserSessionId)).page).toMatchObject({ fitToWidth: true, zoomPercent: 70 })

    await service.setZoom('session-1', { ...page, action: 'increase' })
    expect((await service.inspect('session-1', opened.browserSessionId)).page).toMatchObject({ fitToWidth: false, zoomPercent: 80 })
  })

  test('Given an old layout revision When a newer layout already applied Then the stale update is rejected', async () => {
    const { service, hosts } = setup()
    const opened = await service.open({ ownerSessionId: 'session-1' })

    expect(service.setLayout('session-1', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
      revision: 20,
      visible: true,
      bounds: { x: 20, y: 40, width: 800, height: 600 },
    })).toBe(true)
    expect(service.setLayout('session-1', {
      browserSessionId: opened.browserSessionId,
      pageId: opened.page!.pageId,
      revision: 19,
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    })).toBe(false)

    expect(hosts[0]?.layoutRevisions).toEqual([20])
  })

  test('Given a user link waits on URL validation When Agent control tries to start Then the in-flight navigation keeps ownership', async () => {
    const { service, hosts } = setup()
    await service.open({ ownerSessionId: 'session-a', url: 'https://example.com/original' })
    let releaseNavigation: (() => void) | undefined
    hosts[0]!.navigationGate = new Promise<void>((resolve) => { releaseNavigation = resolve })

    const navigation = service.open({ ownerSessionId: 'session-a', url: 'https://example.com/replacement' })
    await Promise.resolve()
    await expect(service.beginControl('session-a', {
      sessionId: 'session-a',
      runId: 'run-1',
      source: 'user',
      displayName: 'Agent 正在操作',
      startedAt: 10,
      stoppable: true,
    })).rejects.toThrow('用户浏览器导航正在进行')
    releaseNavigation?.()

    await expect(navigation).resolves.toBeDefined()
    expect(hosts[0]?.navigations).toEqual(['https://example.com/original', 'https://example.com/replacement'])
  })

  test('Given Agent control owns the page When a user link tries to navigate Then the current page is not overwritten', async () => {
    const { service, hosts } = setup()
    await service.open({ ownerSessionId: 'session-a', url: 'https://example.com/original' })
    await service.beginControl('session-a', {
      sessionId: 'session-a',
      runId: 'run-1',
      source: 'user',
      displayName: 'Agent 正在操作',
      startedAt: 10,
      stoppable: true,
    })

    await expect(service.open({ ownerSessionId: 'session-a', url: 'https://example.com/replacement' }))
      .rejects.toThrow('Agent 正在操作')
    expect(hosts[0]?.navigations).toEqual(['https://example.com/original'])
  })

  test('Given one Agent run controls the browser When another run starts Then the second run is rejected and control is projected', async () => {    const { service } = setup()
    await service.open({ ownerSessionId: 'session-1' })

    const controlled = await service.beginControl('session-1', {
      runId: 'run-1', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', intent: '点击继续', startedAt: 1, stoppable: true,
    })
    expect(controlled.control).toMatchObject({ runId: 'run-1', source: 'agent', intent: '点击继续' })
    await expect(service.beginControl('session-1', {
      runId: 'run-2', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', startedAt: 1, stoppable: true,
    })).rejects.toMatchObject({ code: 'control_busy' })

    expect(await service.endControl('session-1', 'run-2')).toBe(false)
    expect(await service.endControl('session-1', 'run-1')).toBe(true)
    expect((await service.inspectOwner('session-1')).control).toBeNull()
  })

  test('Given the Session Target revision changes When an Agent observes the page Then stale control fails closed', async () => {
    let revision = 1
    const service = new BrowserSessionService({
      resolveOwner: (sessionId) => ({ ownerSessionId: sessionId, workspaceId: 'workspace-1', source: 'interactive' }),
      resolveSessionTarget: async () => ({ kind: 'isolated', checkoutId: 'checkout-1', revision }),
      createPageHost: ({ pageId, profile, onUpdate }) => new FakePageHost(pageId, profile.partition, onUpdate),
    })
    await service.open({ ownerSessionId: 'session-1' })
    await service.beginControl('session-1', {
      runId: 'run-1', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', startedAt: 1, stoppable: true,
    })
    revision = 2

    await expect(service.snapshotOwner('session-1', 'run-1')).rejects.toMatchObject({ code: 'stale_target' })
  })

  test('Given a current owned page When Agent atomic operations run Then the service routes only to that page', async () => {
    const { service } = setup()
    await service.open({ ownerSessionId: 'session-1' })

    await service.beginControl('session-1', {
      runId: 'run-1', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', startedAt: 1, stoppable: true,
    })
    await expect(service.snapshotOwner('session-1', 'run-1')).resolves.toMatchObject({ pageId: 'page-2' })
    await expect(service.clickOwner('session-1', 'run-1', 'e1')).resolves.toMatchObject({ ref: 'e1' })
    await expect(service.typeOwner('session-1', 'run-1', 'e1', 'Domi', true)).resolves.toMatchObject({ textLength: 4 })
    await expect(service.scrollOwner('session-1', 'run-1', 'down', 'medium')).resolves.toEqual({ deltaX: 0, deltaY: 400 })
    await expect(service.extractOwner('session-1', 'run-1', 'e1', 100)).resolves.toEqual({ ref: 'e1', text: 'content', truncated: false })
  })
})
