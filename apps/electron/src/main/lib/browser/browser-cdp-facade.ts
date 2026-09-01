import {
  BROWSER_SNAPSHOT_MAX_NODES,
  buildBrowserSemanticSnapshot,
  type BrowserAxNode,
  type BrowserSemanticNode,
} from './browser-observation-policy.ts'
import {
  assertBrowserClickTarget,
  assertBrowserTypeInput,
  normalizeBrowserExtractText,
  resolveBrowserScrollDelta,
  type BrowserOperationTarget,
  type BrowserScrollDirection,
  type BrowserScrollDistance,
} from './browser-operation-policy.ts'

export type BrowserCdpCommandParams = Record<string, unknown>

export interface BrowserCdpTransport {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: BrowserCdpCommandParams): Promise<unknown>
}

export interface BrowserElementRefRecord extends BrowserOperationTarget {}

export interface BrowserCdpSnapshot {
  pageId: string
  navigationEpoch: number
  contentTrust: 'untrusted-web-content'
  nodes: BrowserSemanticNode[]
  truncated: boolean
  textBytes: number
}

export type BrowserCdpFacadeErrorCode =
  | 'snapshot_unavailable'
  | 'page_not_ready'
  | 'navigation_changed'
  | 'stale_ref'
  | 'node_not_found'
  | 'operation_failed'

export class BrowserCdpFacadeError extends Error {
  constructor(readonly code: BrowserCdpFacadeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserCdpFacadeError'
  }
}

export interface BrowserCdpFacadeOptions {
  pageId: string
  transport: BrowserCdpTransport
  getNavigationEpoch: () => number
  onDocumentRootReplaced: () => number
}

/**
 * Main-only 的受限 CDP seam。上层只能请求语义 Snapshot 或解析既有 ref，
 * 不能提供任意 method name、JavaScript expression 或 selector。
 */
export class BrowserCdpFacade {
  private readonly refs = new Map<string, BrowserElementRefRecord>()
  private readonly refByBackendNodeId = new Map<number, string>()
  private nextRef = 1
  private attachedByFacade = false
  private accessibilityEnabled = false
  private rootBackendDOMNodeId: number | undefined
  private invalidationRevision = 0
  private disposed = false

  constructor(private readonly options: BrowserCdpFacadeOptions) {}

  async snapshot(): Promise<BrowserCdpSnapshot> {
    this.assertAlive()
    try {
      const startedEpoch = this.options.getNavigationEpoch()
      const startedInvalidationRevision = this.invalidationRevision
      await this.ensureAccessibilityReady()
      const response = await this.options.transport.sendCommand('Accessibility.getFullAXTree')
      if (
        this.options.getNavigationEpoch() !== startedEpoch
        || this.invalidationRevision !== startedInvalidationRevision
      ) {
        this.clearRefs()
        throw new BrowserCdpFacadeError('navigation_changed', '页面在生成 Snapshot 时发生了导航，请重试。')
      }
      const nodes = readAccessibilityNodes(response)
      await this.enrichInputDomMetadata(nodes)
      if (
        this.options.getNavigationEpoch() !== startedEpoch
        || this.invalidationRevision !== startedInvalidationRevision
      ) {
        this.clearRefs()
        throw new BrowserCdpFacadeError('navigation_changed', '页面在生成 Snapshot 时发生了导航，请重试。')
      }
      const nextRootBackendDOMNodeId = findDocumentRootBackendNodeId(nodes)

      if (
        this.rootBackendDOMNodeId !== undefined
        && nextRootBackendDOMNodeId !== undefined
        && this.rootBackendDOMNodeId !== nextRootBackendDOMNodeId
      ) {
        this.clearRefs()
        this.options.onDocumentRootReplaced()
      }
      if (nextRootBackendDOMNodeId !== undefined) this.rootBackendDOMNodeId = nextRootBackendDOMNodeId

      const navigationEpoch = this.options.getNavigationEpoch()
      const body = buildBrowserSemanticSnapshot({
        nodes,
        allocateRef: (backendDOMNodeId) => this.allocateRef(backendDOMNodeId, navigationEpoch),
      })
      this.pruneRefsOutsideSnapshot(body.nodes)
      this.enrichRefMetadata(body.nodes)

      return {
        pageId: this.options.pageId,
        navigationEpoch,
        contentTrust: 'untrusted-web-content',
        nodes: body.nodes,
        truncated: body.truncated,
        textBytes: body.textBytes,
      }
    } catch (error) {
      if (error instanceof BrowserCdpFacadeError) throw error
      throw new BrowserCdpFacadeError('snapshot_unavailable', '无法读取当前浏览器页面的语义快照。', { cause: error })
    }
  }

  async resolveRef(ref: string): Promise<BrowserElementRefRecord> {
    this.assertAlive()
    const record = this.refs.get(ref)
    const currentEpoch = this.options.getNavigationEpoch()
    if (!record || record.pageId !== this.options.pageId || record.navigationEpoch !== currentEpoch) {
      throw new BrowserCdpFacadeError('stale_ref', '页面已经变化，请重新获取 Browser Snapshot。')
    }

    const startedInvalidationRevision = this.invalidationRevision
    try {
      await this.ensureAttached()
      const response = await this.options.transport.sendCommand('DOM.describeNode', {
        backendNodeId: record.backendDOMNodeId,
        depth: 0,
        pierce: true,
      })
      if (!isRecord(response) || !isRecord(response.node)) throw new Error('CDP 未返回可用节点。')
    } catch (error) {
      this.refs.delete(ref)
      this.refByBackendNodeId.delete(record.backendDOMNodeId)
      throw new BrowserCdpFacadeError('node_not_found', '页面元素已经不存在，请重新获取 Browser Snapshot。', { cause: error })
    }
    if (
      record.navigationEpoch !== this.options.getNavigationEpoch()
      || startedInvalidationRevision !== this.invalidationRevision
    ) {
      throw new BrowserCdpFacadeError('stale_ref', '页面已经变化，请重新获取 Browser Snapshot。')
    }
    return { ...record }
  }

  async click(ref: string): Promise<{ ref: string; navigationEpoch: number }> {
    const target = await this.resolveRef(ref)
    assertBrowserClickTarget(target)
    try {
      await this.options.transport.sendCommand('DOM.scrollIntoViewIfNeeded', {
        backendNodeId: target.backendDOMNodeId,
      })
      const response = await this.options.transport.sendCommand('DOM.getBoxModel', {
        backendNodeId: target.backendDOMNodeId,
      })
      const center = readBoxModelCenter(response)
      if (!center) throw new Error('元素没有可点击的可见区域。')
      await this.options.transport.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center })
      await this.options.transport.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...center, button: 'left', clickCount: 1,
      })
      await this.options.transport.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...center, button: 'left', clickCount: 1,
      })
      return { ref, navigationEpoch: target.navigationEpoch }
    } catch (error) {
      throw this.operationError('点击浏览器元素失败。', error)
    }
  }

  async type(ref: string, text: string, replace = true): Promise<{ ref: string; textLength: number; replace: boolean }> {
    const target = await this.resolveRef(ref)
    const validated = assertBrowserTypeInput(target, text)
    try {
      const resolved = await this.options.transport.sendCommand('DOM.resolveNode', {
        backendNodeId: target.backendDOMNodeId,
      })
      const objectId = readRemoteObjectId(resolved)
      if (!objectId) throw new Error('无法解析输入控件。')
      const prepared = await this.options.transport.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: BROWSER_PREPARE_INPUT_FUNCTION,
        arguments: [{ value: replace }],
        returnByValue: true,
        awaitPromise: false,
        userGesture: true,
      })
      if (readRemoteBoolean(prepared) !== true) throw new Error('输入控件无法聚焦或清空。')
      if (validated.text) await this.options.transport.sendCommand('Input.insertText', { text: validated.text })
      return { ref, textLength: validated.textLength, replace }
    } catch (error) {
      throw this.operationError('向浏览器元素输入文本失败。', error)
    }
  }

  async scroll(
    direction: BrowserScrollDirection,
    distance: BrowserScrollDistance,
    viewport: { width: number; height: number },
  ): Promise<{ deltaX: number; deltaY: number }> {
    this.assertAlive()
    const delta = resolveBrowserScrollDelta(direction, distance, viewport)
    const x = Math.max(0, Math.round(viewport.width / 2))
    const y = Math.max(0, Math.round(viewport.height / 2))
    try {
      await this.options.transport.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, ...delta,
      })
      return delta
    } catch (error) {
      throw this.operationError('滚动浏览器页面失败。', error)
    }
  }

  async extract(ref: string, maxChars: number): Promise<{ ref: string; text: string; truncated: boolean }> {
    const target = await this.resolveRef(ref)
    try {
      const resolved = await this.options.transport.sendCommand('DOM.resolveNode', {
        backendNodeId: target.backendDOMNodeId,
      })
      const objectId = readRemoteObjectId(resolved)
      if (!objectId) throw new Error('无法解析目标元素。')
      const response = await this.options.transport.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: BROWSER_EXTRACT_TEXT_FUNCTION,
        arguments: [{ value: maxChars + 1 }],
        returnByValue: true,
        awaitPromise: false,
      })
      const normalized = normalizeBrowserExtractText(readRemoteString(response) ?? '', maxChars)
      return { ref, ...normalized }
    } catch (error) {
      throw this.operationError('提取浏览器元素文本失败。', error)
    }
  }

  invalidateRefs(): void {
    this.invalidationRevision += 1
    this.clearRefs()
    this.rootBackendDOMNodeId = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearRefs()
    this.rootBackendDOMNodeId = undefined
    if (this.attachedByFacade && this.options.transport.isAttached()) {
      try {
        this.options.transport.detach()
      } catch {
        // Page 销毁阶段必须幂等；Electron 可能已经先行释放 renderer/debugger。
      }
    }
    this.attachedByFacade = false
    this.accessibilityEnabled = false
  }

  private async enrichInputDomMetadata(nodes: BrowserAxNode[]): Promise<void> {
    const inputNodes = nodes
      .filter((node) => isInputRole(node) && node.backendDOMNodeId !== undefined)
      .slice(0, BROWSER_SNAPSHOT_MAX_NODES)
    const concurrency = 16
    for (let index = 0; index < inputNodes.length; index += concurrency) {
      await Promise.all(inputNodes.slice(index, index + concurrency).map(async (node) => {
        try {
          const response = await this.options.transport.sendCommand('DOM.describeNode', {
            backendNodeId: node.backendDOMNodeId,
            depth: 0,
            pierce: true,
          })
          if (isRecord(response) && isRecord(response.node)) {
            node.dom = {
              backendNodeId: readNumber(response.node.backendNodeId),
              nodeName: readString(response.node.nodeName),
              attributes: readStringArray(response.node.attributes),
            }
          }
        } catch {
          // 元数据读取失败时保持最小语义节点；绝不回退读取 DOM value 或 outerHTML。
        }
      }))
    }
  }

  private async ensureAccessibilityReady(): Promise<void> {
    await this.ensureAttached()
    if (this.accessibilityEnabled) return
    await this.options.transport.sendCommand('Accessibility.enable')
    this.accessibilityEnabled = true
  }

  private async ensureAttached(): Promise<void> {
    if (this.options.transport.isAttached()) return
    this.options.transport.attach('1.3')
    this.attachedByFacade = true
    this.accessibilityEnabled = false
  }

  private allocateRef(backendDOMNodeId: number, navigationEpoch: number): string {
    const existing = this.refByBackendNodeId.get(backendDOMNodeId)
    if (existing) {
      const record = this.refs.get(existing)
      if (record?.navigationEpoch === navigationEpoch) return existing
      this.refs.delete(existing)
      this.refByBackendNodeId.delete(backendDOMNodeId)
    }

    const ref = `e${this.nextRef++}`
    this.refByBackendNodeId.set(backendDOMNodeId, ref)
    this.refs.set(ref, {
      ref,
      pageId: this.options.pageId,
      navigationEpoch,
      backendDOMNodeId,
    })
    return ref
  }

  private pruneRefsOutsideSnapshot(nodes: BrowserSemanticNode[]): void {
    const currentRefs = new Set(nodes.map((node) => node.ref))
    for (const [ref, record] of this.refs) {
      if (currentRefs.has(ref)) continue
      this.refs.delete(ref)
      this.refByBackendNodeId.delete(record.backendDOMNodeId)
    }
  }

  private enrichRefMetadata(nodes: BrowserSemanticNode[]): void {
    for (const node of nodes) {
      const record = this.refs.get(node.ref)
      if (!record) continue
      record.role = node.role
      record.name = node.name
      record.disabled = node.disabled
      record.readonly = node.readonly
      record.password = node.password
      record.multiline = node.multiline
    }
  }

  private clearRefs(): void {
    this.refs.clear()
    this.refByBackendNodeId.clear()
  }

  private assertAlive(): void {
    if (this.disposed) throw new BrowserCdpFacadeError('snapshot_unavailable', '浏览器页面已经关闭。')
  }

  private operationError(message: string, error: unknown): BrowserCdpFacadeError {
    if (error instanceof BrowserCdpFacadeError) return error
    return new BrowserCdpFacadeError('operation_failed', message, { cause: error })
  }
}

function readAccessibilityNodes(response: unknown): BrowserAxNode[] {
  if (!isRecord(response) || !Array.isArray(response.nodes)) return []
  return response.nodes.filter(isRecord) as BrowserAxNode[]
}

function isInputRole(node: BrowserAxNode): boolean {
  const role = typeof node.role?.value === 'string' ? node.role.value.toLowerCase() : ''
  return role === 'combobox' || role === 'searchbox' || role === 'spinbutton' || role === 'textbox'
}

function findDocumentRootBackendNodeId(nodes: BrowserAxNode[]): number | undefined {
  const root = nodes.find((node) => {
    const role = typeof node.role?.value === 'string' ? node.role.value.toLowerCase() : ''
    return role === 'rootwebarea' || role === 'webarea'
  })
  return root?.backendDOMNodeId
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function readBoxModelCenter(response: unknown): { x: number; y: number } | undefined {
  if (!isRecord(response) || !isRecord(response.model) || !Array.isArray(response.model.border)) return undefined
  const points = response.model.border.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (points.length !== 8) return undefined
  const xs = [points[0]!, points[2]!, points[4]!, points[6]!]
  const ys = [points[1]!, points[3]!, points[5]!, points[7]!]
  return {
    x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  }
}

function readRemoteObjectId(response: unknown): string | undefined {
  return isRecord(response) && isRecord(response.object) ? readString(response.object.objectId) : undefined
}

function readRemoteBoolean(response: unknown): boolean | undefined {
  return isRecord(response) && isRecord(response.result) && typeof response.result.value === 'boolean'
    ? response.result.value
    : undefined
}

function readRemoteString(response: unknown): string | undefined {
  return isRecord(response) && isRecord(response.result) ? readString(response.result.value) : undefined
}

const BROWSER_PREPARE_INPUT_FUNCTION = `function (replace) {
  if (!(this instanceof HTMLElement)) return false;
  this.focus({ preventScroll: false });
  if (!replace) return document.activeElement === this;
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    this.setSelectionRange(0, this.value.length);
    this.value = '';
  } else if (this.isContentEditable) {
    this.textContent = '';
  } else {
    return false;
  }
  this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  return document.activeElement === this;
}`

const BROWSER_EXTRACT_TEXT_FUNCTION = `function (maxChars) {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const isFormValueElement = (element) => element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement;
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.min(24001, Math.floor(maxChars))) : 8001;
  if (this && this.nodeType === Node.TEXT_NODE) {
    if (!this.isConnected || !isVisible(this.parentElement)) return '';
    for (let current = this.parentElement; current; current = current.parentElement) {
      if (isFormValueElement(current)) return '';
    }
    return (this.textContent || '').slice(0, limit);
  }
  if (!(this instanceof HTMLElement) || !isVisible(this) || isFormValueElement(this)) return '';
  return (this.innerText || '').slice(0, limit);
}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
