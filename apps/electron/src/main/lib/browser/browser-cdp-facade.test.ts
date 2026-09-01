import { describe, expect, test } from 'bun:test'
import {
  BrowserCdpFacade,
  type BrowserCdpCommandParams,
  type BrowserCdpTransport,
} from './browser-cdp-facade.ts'

class FakeCdpTransport implements BrowserCdpTransport {
  attached = false
  attachCalls = 0
  detachCalls = 0
  commands: Array<{ method: string; params?: BrowserCdpCommandParams }> = []

  constructor(private readonly respond: (method: string, params?: BrowserCdpCommandParams) => unknown) {}

  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true; this.attachCalls += 1 }
  detach(): void { this.attached = false; this.detachCalls += 1 }
  async sendCommand(method: string, params?: BrowserCdpCommandParams): Promise<unknown> {
    this.commands.push({ method, ...(params ? { params } : {}) })
    return this.respond(method, params)
  }
}

class FakeHTMLElement {
  isConnected = true
  innerText = ''
  parentElement: FakeHTMLElement | null = null
  style = { display: 'block', visibility: 'visible' }
}

class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLTextAreaElement extends FakeHTMLElement {}
class FakeHTMLSelectElement extends FakeHTMLElement {}

interface FakeTextNode {
  nodeType: number
  isConnected: boolean
  textContent: string
  parentElement: FakeHTMLElement | null
}

function executeExtractFunction(functionDeclaration: string, target: unknown, maxChars: number): string {
  const createFunction = new Function(
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'Node',
    'getComputedStyle',
    `return (${functionDeclaration});`,
  ) as (
    element: typeof FakeHTMLElement,
    input: typeof FakeHTMLInputElement,
    textarea: typeof FakeHTMLTextAreaElement,
    select: typeof FakeHTMLSelectElement,
    node: { TEXT_NODE: number },
    getStyle: (element: FakeHTMLElement) => FakeHTMLElement['style'],
  ) => (this: unknown, limit: number) => string

  const extract = createFunction(
    FakeHTMLElement,
    FakeHTMLInputElement,
    FakeHTMLTextAreaElement,
    FakeHTMLSelectElement,
    { TEXT_NODE: 3 },
    element => element.style,
  )
  return extract.call(target, maxChars)
}

async function createExtractFixture(
  target: unknown,
  options: { role?: string; name?: string; backendNodeId?: number } = {},
): Promise<{ facade: BrowserCdpFacade; ref: string }> {
  const backendNodeId = options.backendNodeId ?? 72
  const transport = new FakeCdpTransport((method, params) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [{
          nodeId: `node-${backendNodeId}`,
          role: { value: options.role ?? 'StaticText' },
          name: { value: options.name ?? '' },
          backendDOMNodeId: backendNodeId,
        }],
      }
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId } }
    if (method === 'DOM.resolveNode') return { object: { objectId: `object-${backendNodeId}` } }
    if (method === 'Runtime.callFunctionOn') {
      const declaration = typeof params?.functionDeclaration === 'string' ? params.functionDeclaration : ''
      const args = Array.isArray(params?.arguments) ? params.arguments : []
      const firstArg = args[0]
      const maxChars = firstArg && typeof firstArg === 'object' && 'value' in firstArg && typeof firstArg.value === 'number'
        ? firstArg.value
        : 8_001
      return { result: { value: executeExtractFunction(declaration, target, maxChars) } }
    }
    return {}
  })
  const facade = new BrowserCdpFacade({
    pageId: 'page-1', transport, getNavigationEpoch: () => 1, onDocumentRootReplaced: () => 1,
  })
  const snapshot = await facade.snapshot()
  return { facade, ref: snapshot.nodes[0]!.ref }
}

describe('BrowserCdpFacade', () => {
  test('Given an unattached visible page When taking snapshots Then fixed CDP commands are used and refs stay stable within the epoch', async () => {
    const transport = new FakeCdpTransport((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
            { nodeId: 'button', parentId: 'root', role: { value: 'button' }, name: { value: '保存' }, backendDOMNodeId: 2 },
          ],
        }
      }
      return {}
    })
    let navigationEpoch = 4
    const facade = new BrowserCdpFacade({
      pageId: 'page-1',
      transport,
      getNavigationEpoch: () => navigationEpoch,
      onDocumentRootReplaced: () => { navigationEpoch += 1; return navigationEpoch },
    })

    const first = await facade.snapshot()
    const second = await facade.snapshot()
    facade.dispose()

    expect(first).toMatchObject({
      pageId: 'page-1',
      navigationEpoch: 4,
      contentTrust: 'untrusted-web-content',
      nodes: [{ ref: 'e1', role: 'button', name: '保存' }],
    })
    expect(second.nodes[0]?.ref).toBe('e1')
    expect(transport.attachCalls).toBe(1)
    expect(transport.commands.map(({ method }) => method)).toEqual([
      'Accessibility.enable',
      'Accessibility.getFullAXTree',
      'Accessibility.getFullAXTree',
    ])
    expect(transport.detachCalls).toBe(1)
  })

  test('Given the semantic document root is replaced When taking another snapshot Then the epoch advances and old refs fail closed', async () => {
    let snapshotCount = 0
    const transport = new FakeCdpTransport((method) => {
      if (method !== 'Accessibility.getFullAXTree') return {}
      snapshotCount += 1
      const rootId = snapshotCount === 1 ? 1 : 9
      return {
        nodes: [
          { nodeId: `root-${rootId}`, role: { value: 'RootWebArea' }, backendDOMNodeId: rootId },
          { nodeId: `button-${rootId}`, parentId: `root-${rootId}`, role: { value: 'button' }, name: { value: '继续' }, backendDOMNodeId: rootId + 1 },
        ],
      }
    })
    let navigationEpoch = 7
    const facade = new BrowserCdpFacade({
      pageId: 'page-1',
      transport,
      getNavigationEpoch: () => navigationEpoch,
      onDocumentRootReplaced: () => { navigationEpoch += 1; return navigationEpoch },
    })

    const first = await facade.snapshot()
    const second = await facade.snapshot()
    const stale = facade.resolveRef(first.nodes[0]!.ref)

    expect(first).toMatchObject({ navigationEpoch: 7, nodes: [{ ref: 'e1' }] })
    expect(second).toMatchObject({ navigationEpoch: 8, nodes: [{ ref: 'e2' }] })
    await expect(stale).rejects.toMatchObject({ code: 'stale_ref' })
  })

  test('Given an element leaves the latest semantic snapshot When resolving its previous ref Then the ref is stale even if the DOM node remains', async () => {
    let includeButton = true
    const transport = new FakeCdpTransport((method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
            ...(includeButton ? [{ nodeId: 'button', parentId: 'root', role: { value: 'button' }, name: { value: '保存' }, backendDOMNodeId: 2 }] : []),
          ],
        }
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: params?.backendNodeId } }
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1',
      transport,
      getNavigationEpoch: () => 1,
      onDocumentRootReplaced: () => 2,
    })
    const first = await facade.snapshot()
    includeButton = false
    await facade.snapshot()

    await expect(facade.resolveRef(first.nodes[0]!.ref)).rejects.toMatchObject({ code: 'stale_ref' })
  })

  test('Given navigation advances while CDP reads the tree When taking a snapshot Then the mixed document result is rejected', async () => {
    let navigationEpoch = 3
    const transport = new FakeCdpTransport((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        navigationEpoch = 4
        return {
          nodes: [
            { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
            { nodeId: 'button', parentId: 'root', role: { value: 'button' }, name: { value: '旧页面按钮' }, backendDOMNodeId: 2 },
          ],
        }
      }
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1',
      transport,
      getNavigationEpoch: () => navigationEpoch,
      onDocumentRootReplaced: () => navigationEpoch,
    })

    await expect(facade.snapshot()).rejects.toMatchObject({ code: 'navigation_changed' })
  })

  test('Given navigation advances while validating a ref When resolving Then the old document node is rejected', async () => {
    let navigationEpoch = 2
    const transport = new FakeCdpTransport((method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
            { nodeId: 'button', parentId: 'root', role: { value: 'button' }, name: { value: '提交' }, backendDOMNodeId: 2 },
          ],
        }
      }
      if (method === 'DOM.describeNode') {
        navigationEpoch = 3
        return { node: { backendNodeId: params?.backendNodeId } }
      }
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1',
      transport,
      getNavigationEpoch: () => navigationEpoch,
      onDocumentRootReplaced: () => navigationEpoch,
    })
    const snapshot = await facade.snapshot()

    await expect(facade.resolveRef(snapshot.nodes[0]!.ref)).rejects.toMatchObject({ code: 'stale_ref' })
  })

  test('Given a referenced backend node disappears When resolving the ref Then the operation fails closed', async () => {
    const transport = new FakeCdpTransport((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
            { nodeId: 'button', parentId: 'root', role: { value: 'button' }, name: { value: '删除' }, backendDOMNodeId: 2 },
          ],
        }
      }
      if (method === 'DOM.describeNode') throw new Error('No node with given id')
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1',
      transport,
      getNavigationEpoch: () => 2,
      onDocumentRootReplaced: () => 3,
    })
    const snapshot = await facade.snapshot()

    await expect(facade.resolveRef(snapshot.nodes[0]!.ref)).rejects.toMatchObject({
      code: 'node_not_found',
    })
  })

  test('Given a valid button ref When clicking Then fixed DOM and Input commands are dispatched at the element center', async () => {
    const transport = new FakeCdpTransport((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ nodeId: 'button-1', role: { value: 'button' }, name: { value: '继续' }, backendDOMNodeId: 51 }] }
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 51 } }
      if (method === 'DOM.getBoxModel') return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } }
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1', transport, getNavigationEpoch: () => 1, onDocumentRootReplaced: () => 1,
    })
    const snapshot = await facade.snapshot()

    await expect(facade.click(snapshot.nodes[0]!.ref)).resolves.toMatchObject({ ref: snapshot.nodes[0]!.ref })
    expect(transport.commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 60, y: 40 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 } },
    ])
  })

  test('Given a valid textbox ref When typing Then the input is focused without exposing arbitrary script parameters', async () => {
    const transport = new FakeCdpTransport((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ nodeId: 'input-1', role: { value: 'textbox' }, name: { value: '搜索' }, backendDOMNodeId: 61 }] }
      }
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: 61, nodeName: 'INPUT', attributes: ['type', 'text', 'placeholder', '搜索'] } }
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-61' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1', transport, getNavigationEpoch: () => 1, onDocumentRootReplaced: () => 1,
    })
    const snapshot = await facade.snapshot()

    await expect(facade.type(snapshot.nodes[0]!.ref, 'Domi', true)).resolves.toMatchObject({ textLength: 4, replace: true })
    expect(transport.commands.find(command => command.method === 'Input.insertText')).toEqual({
      method: 'Input.insertText', params: { text: 'Domi' },
    })
    const prepare = transport.commands.find(command => command.method === 'Runtime.callFunctionOn')
    expect(prepare?.params).toMatchObject({ objectId: 'object-61', arguments: [{ value: true }] })
    expect(typeof prepare?.params?.functionDeclaration).toBe('string')
    expect(String(prepare?.params?.functionDeclaration)).not.toContain('Domi')
  })

  test('Given an element ref When extracting Then only normalized bounded visible text is returned', async () => {
    const transport = new FakeCdpTransport((method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ nodeId: 'section-1', role: { value: 'region' }, name: { value: '正文' }, backendDOMNodeId: 71 }] }
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 71 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-71' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: '  hello\n\n  world  ' } }
      return {}
    })
    const facade = new BrowserCdpFacade({
      pageId: 'page-1', transport, getNavigationEpoch: () => 1, onDocumentRootReplaced: () => 1,
    })
    const snapshot = await facade.snapshot()

    await expect(facade.extract(snapshot.nodes[0]!.ref, 100)).resolves.toEqual({
      ref: snapshot.nodes[0]!.ref, text: 'hello\nworld', truncated: false,
    })
  })

  test('Given a visible StaticText ref When extracting Then its DOM Text content is returned', async () => {
    const textNode: FakeTextNode = {
      nodeType: 3,
      isConnected: true,
      textContent: 'Example Domain body text',
      parentElement: new FakeHTMLElement(),
    }
    const { facade, ref } = await createExtractFixture(textNode, { name: textNode.textContent })

    await expect(facade.extract(ref, 100)).resolves.toEqual({
      ref,
      text: 'Example Domain body text',
      truncated: false,
    })
  })

  test('Given hidden or disconnected StaticText When extracting Then no text is returned', async () => {
    const hiddenAncestor = new FakeHTMLElement()
    hiddenAncestor.style.display = 'none'
    const parent = new FakeHTMLElement()
    parent.parentElement = hiddenAncestor
    const textNode: FakeTextNode = {
      nodeType: 3,
      isConnected: true,
      textContent: 'hidden text',
      parentElement: parent,
    }
    const { facade, ref } = await createExtractFixture(textNode, { name: textNode.textContent, backendNodeId: 73 })

    await expect(facade.extract(ref, 100)).resolves.toMatchObject({ text: '', truncated: false })
    hiddenAncestor.style.display = 'block'
    textNode.isConnected = false
    await expect(facade.extract(ref, 100)).resolves.toMatchObject({ text: '', truncated: false })
  })

  test('Given form controls When extracting Then their values stay excluded', async () => {
    for (const control of [new FakeHTMLInputElement(), new FakeHTMLTextAreaElement(), new FakeHTMLSelectElement()]) {
      control.innerText = 'sensitive form value'
      const { facade, ref } = await createExtractFixture(control, { role: 'textbox', name: '字段', backendNodeId: 74 })
      await expect(facade.extract(ref, 100)).resolves.toMatchObject({ text: '' })
    }

    for (const parentElement of [new FakeHTMLTextAreaElement(), new FakeHTMLSelectElement()]) {
      const textNode: FakeTextNode = {
        nodeType: 3,
        isConnected: true,
        textContent: 'nested form value',
        parentElement,
      }
      const { facade, ref } = await createExtractFixture(textNode, { name: textNode.textContent, backendNodeId: 76 })
      await expect(facade.extract(ref, 100)).resolves.toMatchObject({ text: '' })
    }
  })

  test('Given StaticText exceeds maxChars When extracting Then Main truncates the returned text', async () => {
    const textNode: FakeTextNode = {
      nodeType: 3,
      isConnected: true,
      textContent: '123456789',
      parentElement: new FakeHTMLElement(),
    }
    const { facade, ref } = await createExtractFixture(textNode, { name: textNode.textContent, backendNodeId: 75 })

    await expect(facade.extract(ref, 5)).resolves.toEqual({
      ref,
      text: '12345',
      truncated: true,
    })
  })

  test('Given a fixed scroll request When scrolling Then one bounded wheel event is dispatched', async () => {
    const transport = new FakeCdpTransport(() => ({}))
    const facade = new BrowserCdpFacade({
      pageId: 'page-1', transport, getNavigationEpoch: () => 1, onDocumentRootReplaced: () => 1,
    })

    await expect(facade.scroll('down', 'medium', { width: 1000, height: 800 })).resolves.toEqual({ deltaX: 0, deltaY: 400 })
    expect(transport.commands.at(-1)).toEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 400 },
    })
  })
})
