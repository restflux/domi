import { randomUUID } from 'node:crypto'
import type {
  BrowserAgentControlView,
  BrowserFitToWidthInput,
  BrowserLayoutInput,
  BrowserPageInput,
  BrowserZoomInput,
  BrowserSessionView,
  BrowserSourceTargetView,
  BrowserElementSelectionResult,
  BrowserFocusEscapeRequest,
  BrowserSelectedElementReference,
} from '@domi/shared'
import type { BrowserCdpSnapshot, BrowserElementRefRecord } from './browser-cdp-facade.ts'
import type { BrowserScrollDirection, BrowserScrollDistance } from './browser-operation-policy.ts'
import type { BrowserPageHost, BrowserPageHostUpdate } from './browser-page-host.ts'
import type { BrowserElementSelectionCandidate, BrowserElementSelectionCancelReason } from './browser-element-selection.ts'
import {
  resolveBrowserProfile,
  type BrowserProfileSelection,
  type BrowserSessionSource,
} from './browser-profile-policy.ts'

export interface BrowserOwnerContext {
  ownerSessionId: string
  workspaceId: string
  source: BrowserSessionSource
}

export interface BrowserSessionTargetContext {
  kind: 'local' | 'isolated'
  checkoutId?: string
  revision: number
}

interface BrowserPageIdentity {
  browserSessionId: string
  pageId: string
}

export interface BrowserPageHostFactoryInput {
  pageId: string
  owner: BrowserOwnerContext
  profile: BrowserProfileSelection
  onUpdate: (update: BrowserPageHostUpdate) => void
}

export interface BrowserSessionServiceDependencies {
  resolveOwner: (sessionId: string) => BrowserOwnerContext | undefined
  resolveSessionTarget: (sessionId: string) => Promise<BrowserSessionTargetContext>
  createPageHost: (input: BrowserPageHostFactoryInput) => BrowserPageHost
  createId?: (prefix: 'browser' | 'page') => string
  onStateChanged?: (state: BrowserSessionView | { browserSessionId: string; ownerSessionId: string; closed: true }) => void
  onFocusEscapeRequested?: (request: BrowserFocusEscapeRequest) => void
}

interface BrowserSessionRecord {
  browserSessionId: string
  owner: BrowserOwnerContext
  profile: BrowserProfileSelection
  page: BrowserPageHost
  sourceTarget: BrowserSessionTargetContext
  layoutRevision: number
  mutationEpoch: number
  userMutationInFlight: boolean
  elementSelectionInFlight: Promise<BrowserElementSelectionCandidate> | null
  control: BrowserAgentControlView | null
  closing: boolean
}

export class BrowserSessionServiceError extends Error {
  constructor(readonly code: 'owner_not_found' | 'session_not_found' | 'access_denied' | 'page_not_found' | 'control_busy' | 'stale_target', message: string) {
    super(message)
    this.name = 'BrowserSessionServiceError'
  }
}

export class BrowserSessionService {
  private readonly records = new Map<string, BrowserSessionRecord>()
  private readonly activeBrowserSessionIdByOwner = new Map<string, string>()
  private readonly controlledBrowserSessionIdByRun = new Map<string, string>()
  private readonly createId: (prefix: 'browser' | 'page') => string

  constructor(private readonly deps: BrowserSessionServiceDependencies) {
    this.createId = deps.createId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  }

  async open(input: { ownerSessionId: string; url?: string; disposition?: 'reuse-active' | 'new-tab' }): Promise<BrowserSessionView> {
    const owner = this.requireOwner(input.ownerSessionId)
    let record = input.disposition === 'new-tab' ? undefined : this.getRecordByOwner(owner.ownerSessionId)
    if (!record) record = await this.createRecord(owner)
    this.activeBrowserSessionIdByOwner.set(owner.ownerSessionId, record.browserSessionId)

    if (input.url) {
      await this.assertSourceTargetCurrent(record)
      await this.cancelRecordElementSelection(record, 'navigation')
      if (record.userMutationInFlight) {
        throw new BrowserSessionServiceError('control_busy', '浏览器正在处理另一个导航，请稍后重试。')
      }
      this.assertUserMayOperate(record)
      const mutationEpoch = record.mutationEpoch
      record.userMutationInFlight = true
      try {
        await record.page.navigate(input.url, () => {
          this.assertUserMayOperate(record)
          if (record.mutationEpoch !== mutationEpoch) {
            throw new BrowserSessionServiceError('control_busy', '浏览器控制状态已变化，请重试。')
          }
        })
      } finally {
        record.userMutationInFlight = false
      }
    }
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async activate(ownerSessionId: string, browserSessionId: string): Promise<BrowserSessionView> {
    const record = this.assertOwnedSession(ownerSessionId, browserSessionId)
    this.activeBrowserSessionIdByOwner.set(ownerSessionId, browserSessionId)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async inspect(ownerSessionId: string, browserSessionId: string): Promise<BrowserSessionView> {
    const record = this.assertOwnedSession(ownerSessionId, browserSessionId)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async inspectOwner(ownerSessionId: string): Promise<BrowserSessionView> {
    const record = this.requireRecordByOwner(ownerSessionId)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async beginControl(ownerSessionId: string, control: BrowserAgentControlView): Promise<BrowserSessionView> {
    const record = this.requireRecordByOwner(ownerSessionId)
    await this.assertSourceTargetCurrent(record)
    await this.cancelRecordElementSelection(record, 'control')
    if (record.userMutationInFlight) {
      throw new BrowserSessionServiceError('control_busy', '用户浏览器导航正在进行，Agent 暂不能接管页面。')
    }
    if (record.control && record.control.runId !== control.runId) {
      throw new BrowserSessionServiceError('control_busy', '当前浏览器正在由另一个 Agent 运行控制。')
    }
    record.control = { ...control, sessionId: ownerSessionId }
    this.controlledBrowserSessionIdByRun.set(this.controlKey(ownerSessionId, control.runId), record.browserSessionId)
    record.mutationEpoch += 1
    this.emitState(record)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async endControl(ownerSessionId: string, runId: string): Promise<boolean> {
    const key = this.controlKey(ownerSessionId, runId)
    const browserSessionId = this.controlledBrowserSessionIdByRun.get(key)
    const record = browserSessionId ? this.records.get(browserSessionId) : undefined
    if (!record?.control || record.control.runId !== runId) {
      this.controlledBrowserSessionIdByRun.delete(key)
      return false
    }
    record.control = null
    this.controlledBrowserSessionIdByRun.delete(key)
    record.mutationEpoch += 1
    this.emitState(record)
    return true
  }

  async navigate(ownerSessionId: string, input: BrowserPageInput & { url: string }): Promise<BrowserSessionView> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'navigation')
    this.assertUserMayOperate(record)
    await record.page.navigate(input.url)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async navigateOwner(ownerSessionId: string, runId: string, url: string): Promise<BrowserSessionView> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    await this.assertSourceTargetCurrent(record)
    await record.page.navigate(url)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async snapshot(ownerSessionId: string, input: BrowserPageIdentity): Promise<BrowserCdpSnapshot> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.assertSourceTargetCurrent(record)
    return record.page.snapshot()
  }

  async resolveRef(ownerSessionId: string, input: BrowserPageIdentity, ref: string): Promise<BrowserElementRefRecord> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.assertSourceTargetCurrent(record)
    return record.page.resolveRef(ref)
  }

  async selectElement(ownerSessionId: string, input: BrowserPageIdentity): Promise<BrowserElementSelectionResult> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.assertSourceTargetCurrent(record)
    this.assertUserMayOperate(record)
    if (record.userMutationInFlight || record.elementSelectionInFlight) {
      throw new BrowserSessionServiceError('control_busy', '浏览器正在处理另一项用户操作，请稍后重试。')
    }

    const pageBeforeSelection = record.page.getState()
    const task = record.page.selectElement()
    record.elementSelectionInFlight = task
    try {
      const result = await task
      if (result.status === 'cancelled') return result
      if (this.records.get(record.browserSessionId) !== record || record.closing) {
        return { status: 'cancelled', reason: 'close' }
      }
      await this.assertSourceTargetCurrent(record)
      const page = record.page.getState()
      if (page.pageId !== pageBeforeSelection.pageId || page.navigationEpoch !== pageBeforeSelection.navigationEpoch) {
        return { status: 'cancelled', reason: 'navigation' }
      }
      return { status: 'selected', element: this.projectSelectedElement(record, page, result) }
    } finally {
      if (record.elementSelectionInFlight === task) record.elementSelectionInFlight = null
    }
  }

  async cancelElementSelection(
    ownerSessionId: string,
    browserSessionId: string,
    reason: BrowserElementSelectionCancelReason = 'toolbar',
  ): Promise<boolean> {
    const record = this.assertOwnedSession(ownerSessionId, browserSessionId)
    return this.cancelRecordElementSelection(record, reason)
  }

  async snapshotOwner(ownerSessionId: string, runId: string): Promise<BrowserCdpSnapshot> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    await this.assertSourceTargetCurrent(record)
    return record.page.snapshot()
  }

  async clickOwner(ownerSessionId: string, runId: string, ref: string): Promise<{ ref: string; navigationEpoch: number }> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    await this.assertSourceTargetCurrent(record)
    return record.page.click(ref)
  }

  async typeOwner(ownerSessionId: string, runId: string, ref: string, text: string, replace = true): Promise<{ ref: string; textLength: number; replace: boolean }> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    await this.assertSourceTargetCurrent(record)
    return record.page.type(ref, text, replace)
  }

  async scrollOwner(ownerSessionId: string, runId: string, direction: BrowserScrollDirection, distance: BrowserScrollDistance): Promise<{ deltaX: number; deltaY: number }> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    await this.assertSourceTargetCurrent(record)
    return record.page.scroll(direction, distance)
  }

  async extractOwner(ownerSessionId: string, runId: string, ref: string, maxChars: number): Promise<{ ref: string; text: string; truncated: boolean }> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    await this.assertSourceTargetCurrent(record)
    return record.page.extract(ref, maxChars)
  }

  async goBack(ownerSessionId: string, input: BrowserPageInput): Promise<void> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'navigation')
    this.assertUserMayOperate(record)
    record.page.goBack()
  }

  async goForward(ownerSessionId: string, input: BrowserPageInput): Promise<void> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'navigation')
    this.assertUserMayOperate(record)
    record.page.goForward()
  }

  async reload(ownerSessionId: string, input: BrowserPageInput): Promise<void> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'navigation')
    this.assertUserMayOperate(record)
    record.page.reload()
  }

  async stop(ownerSessionId: string, input: BrowserPageInput): Promise<void> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'navigation')
    record.page.stop()
  }

  async setZoom(ownerSessionId: string, input: Omit<BrowserZoomInput, 'ownerSessionId'>): Promise<BrowserSessionView> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'toolbar')
    this.assertUserMayOperate(record)
    await record.page.setZoom(input.action)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  async setFitToWidth(ownerSessionId: string, input: Omit<BrowserFitToWidthInput, 'ownerSessionId'>): Promise<BrowserSessionView> {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    await this.cancelRecordElementSelection(record, 'toolbar')
    this.assertUserMayOperate(record)
    await record.page.setFitToWidth(input.enabled)
    return this.project(record, await this.resolveCurrentSourceTarget(record))
  }

  setLayout(ownerSessionId: string, input: Omit<BrowserLayoutInput, 'ownerSessionId'>): boolean {
    const record = this.assertOwnedSession(ownerSessionId, input.browserSessionId, input.pageId)
    if (!Number.isSafeInteger(input.revision) || input.revision <= record.layoutRevision) return false
    record.layoutRevision = input.revision
    return record.page.setLayout({ revision: input.revision, visible: input.visible, bounds: input.bounds })
  }

  async close(ownerSessionId: string, browserSessionId: string): Promise<boolean> {
    const record = this.records.get(browserSessionId)
    if (!record) return false
    this.assertOwner(record, ownerSessionId)
    if (record.closing) return false
    record.closing = true
    await this.cancelRecordElementSelection(record, 'close')
    this.records.delete(browserSessionId)
    for (const [key, controlledBrowserSessionId] of this.controlledBrowserSessionIdByRun) {
      if (controlledBrowserSessionId === browserSessionId) this.controlledBrowserSessionIdByRun.delete(key)
    }
    if (this.activeBrowserSessionIdByOwner.get(ownerSessionId) === browserSessionId) {
      const fallback = this.getRecordsByOwner(ownerSessionId).at(-1)
      if (fallback) this.activeBrowserSessionIdByOwner.set(ownerSessionId, fallback.browserSessionId)
      else this.activeBrowserSessionIdByOwner.delete(ownerSessionId)
    }
    await record.page.destroy()
    this.deps.onStateChanged?.({ browserSessionId, ownerSessionId: record.owner.ownerSessionId, closed: true })
    return true
  }

  async closeOwner(ownerSessionId: string): Promise<boolean> {
    const records = this.getRecordsByOwner(ownerSessionId)
    if (records.length === 0) return false
    for (const record of records) this.assertUserMayOperate(record)
    const results = await Promise.all(records.map((record) => this.close(ownerSessionId, record.browserSessionId)))
    return results.some(Boolean)
  }

  async closeControlledOwner(ownerSessionId: string, runId: string): Promise<boolean> {
    const record = this.requireControlledRecord(ownerSessionId, runId)
    return this.close(ownerSessionId, record.browserSessionId)
  }

  async closeTemporaryOwner(ownerSessionId: string): Promise<boolean> {
    const records = this.getRecordsByOwner(ownerSessionId).filter((record) => record.profile.kind === 'temporary')
    if (records.length === 0) return false
    const results = await Promise.all(records.map((record) => this.close(ownerSessionId, record.browserSessionId)))
    return results.some(Boolean)
  }

  async destroyAll(): Promise<void> {
    const records = [...this.records.values()]
    await Promise.allSettled(records.map((record) => this.close(record.owner.ownerSessionId, record.browserSessionId)))
  }

  assertOwnedSession(ownerSessionId: string, browserSessionId: string, pageId?: string): BrowserSessionRecord {
    const currentOwner = this.requireOwner(ownerSessionId)
    const record = this.records.get(browserSessionId)
    if (!record) throw new BrowserSessionServiceError('session_not_found', '浏览器会话不存在或已关闭。')
    this.assertOwner(record, ownerSessionId)
    if (currentOwner.workspaceId !== record.owner.workspaceId || currentOwner.source !== record.owner.source) {
      throw new BrowserSessionServiceError('access_denied', '浏览器所属项目或来源已经变化，请重新打开。')
    }
    if (pageId && record.page.pageId !== pageId) {
      throw new BrowserSessionServiceError('page_not_found', '浏览器页面不存在或不属于当前会话。')
    }
    return record
  }

  private requireOwner(ownerSessionId: string): BrowserOwnerContext {
    const owner = this.deps.resolveOwner(ownerSessionId)
    if (!owner || !owner.workspaceId) {
      throw new BrowserSessionServiceError('owner_not_found', 'Agent 会话或所属项目不存在。')
    }
    return owner
  }

  private assertOwner(record: BrowserSessionRecord, ownerSessionId: string): void {
    if (record.owner.ownerSessionId !== ownerSessionId) {
      throw new BrowserSessionServiceError('access_denied', '不能操作其他 Agent 会话的浏览器。')
    }
  }

  private async createRecord(owner: BrowserOwnerContext): Promise<BrowserSessionRecord> {
    const browserSessionId = this.createId('browser')
    const profile = resolveBrowserProfile({
      workspaceId: owner.workspaceId,
      source: owner.source,
      ownerSessionId: owner.ownerSessionId,
    })
    const sourceTarget = await this.deps.resolveSessionTarget(owner.ownerSessionId)
    const page = this.deps.createPageHost({
      pageId: this.createId('page'),
      owner,
      profile,
      onUpdate: (update) => {
        const current = this.records.get(browserSessionId)
        if (!current || current.closing) return
        if (update.type === 'focus-escape') {
          if (current.elementSelectionInFlight) return
          this.deps.onFocusEscapeRequested?.({
            ownerSessionId: current.owner.ownerSessionId,
            browserSessionId: current.browserSessionId,
            pageId: current.page.pageId,
          })
          return
        }
        this.emitState(current)
      },
    })
    const record: BrowserSessionRecord = {
      browserSessionId,
      owner,
      profile,
      page,
      sourceTarget,
      layoutRevision: -1,
      mutationEpoch: 0,
      userMutationInFlight: false,
      elementSelectionInFlight: null,
      control: null,
      closing: false,
    }
    this.records.set(browserSessionId, record)
    return record
  }

  private getRecordByOwner(ownerSessionId: string): BrowserSessionRecord | undefined {
    const browserSessionId = this.activeBrowserSessionIdByOwner.get(ownerSessionId)
    return browserSessionId ? this.records.get(browserSessionId) : undefined
  }

  private getRecordsByOwner(ownerSessionId: string): BrowserSessionRecord[] {
    return [...this.records.values()].filter((record) => record.owner.ownerSessionId === ownerSessionId)
  }

  private controlKey(ownerSessionId: string, runId: string): string {
    return `${ownerSessionId}\u0000${runId}`
  }

  private async cancelRecordElementSelection(
    record: BrowserSessionRecord,
    reason: BrowserElementSelectionCancelReason,
  ): Promise<boolean> {
    const task = record.elementSelectionInFlight
    if (!task) return false
    const cancelled = await record.page.cancelElementSelection(reason)
    if (cancelled) await task.catch(() => undefined)
    return cancelled
  }

  private projectSelectedElement(
    record: BrowserSessionRecord,
    page: ReturnType<BrowserPageHost['getState']>,
    result: Extract<BrowserElementSelectionCandidate, { status: 'selected' }>,
  ): BrowserSelectedElementReference {
    return {
      browserSessionId: record.browserSessionId,
      ownerSessionId: record.owner.ownerSessionId,
      pageId: page.pageId,
      navigationEpoch: page.navigationEpoch,
      pageTitle: page.title,
      pageUrl: page.url,
      ...result.element,
      contentTrust: 'untrusted-web-content',
    }
  }

  private assertUserMayOperate(record: BrowserSessionRecord): void {
    if (record.control) {
      throw new BrowserSessionServiceError('control_busy', 'Agent 正在操作浏览器，请先停止当前 Agent。')
    }
  }

  private requireControlledRecord(ownerSessionId: string, runId: string): BrowserSessionRecord {
    this.requireOwner(ownerSessionId)
    const browserSessionId = this.controlledBrowserSessionIdByRun.get(this.controlKey(ownerSessionId, runId))
    const record = browserSessionId ? this.records.get(browserSessionId) : undefined
    if (!record?.control || record.control.runId !== runId) {
      throw new BrowserSessionServiceError('access_denied', '当前 Agent 运行未持有浏览器控制权。')
    }
    this.assertOwner(record, ownerSessionId)
    return record
  }

  private requireRecordByOwner(ownerSessionId: string): BrowserSessionRecord {
    this.requireOwner(ownerSessionId)
    const record = this.getRecordByOwner(ownerSessionId)
    if (!record) throw new BrowserSessionServiceError('session_not_found', '浏览器会话不存在或已关闭。')
    this.assertOwner(record, ownerSessionId)
    return record
  }

  private async assertSourceTargetCurrent(record: BrowserSessionRecord): Promise<void> {
    const current = await this.resolveCurrentSourceTarget(record)
    if (current.stale) {
      this.deps.onStateChanged?.(this.project(record, current))
      throw new BrowserSessionServiceError('stale_target', 'Session Target 已变化，请关闭并重新打开内置浏览器。')
    }
  }

  private async resolveCurrentSourceTarget(record: BrowserSessionRecord): Promise<BrowserSourceTargetView> {
    const current = await this.deps.resolveSessionTarget(record.owner.ownerSessionId)
    return {
      ...current,
      stale: current.kind !== record.sourceTarget.kind
        || current.checkoutId !== record.sourceTarget.checkoutId
        || current.revision !== record.sourceTarget.revision,
    }
  }

  private project(record: BrowserSessionRecord, sourceTarget: BrowserSourceTargetView): BrowserSessionView {
    return {
      browserSessionId: record.browserSessionId,
      ownerSessionId: record.owner.ownerSessionId,
      workspaceId: record.owner.workspaceId,
      profileKind: record.profile.kind,
      page: record.page.getState(),
      control: record.control,
      sourceTarget,
    }
  }

  private emitState(record: BrowserSessionRecord): void {
    void this.resolveCurrentSourceTarget(record)
      .then((sourceTarget) => {
        if (this.records.get(record.browserSessionId) === record && !record.closing) {
          this.deps.onStateChanged?.(this.project(record, sourceTarget))
        }
      })
      .catch((error) => console.warn('[浏览器] 刷新 Session Target 投影失败:', error))
  }
}
