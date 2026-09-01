import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BrowserAgentControlView, BrowserSessionView } from '@domi/shared'
import { buildPiBrowserTools, type PiBrowserToolsService } from './pi-browser-tools.ts'

class FakeBrowserService implements PiBrowserToolsService {
  controls: BrowserAgentControlView[] = []
  typedText: string[] = []

  async open(): Promise<BrowserSessionView> {
    return browserView(null)
  }

  async inspectOwner(): Promise<BrowserSessionView> {
    return browserView(this.controls.at(-1) ?? null)
  }

  async beginControl(_ownerSessionId: string, control: BrowserAgentControlView): Promise<BrowserSessionView> {
    this.controls.push(control)
    return browserView(control)
  }

  async endControl(): Promise<boolean> {
    return true
  }

  async navigateOwner(): Promise<BrowserSessionView> {
    return browserView(this.controls.at(-1) ?? null)
  }

  async snapshotOwner() {
    return {
      pageId: 'page-1', navigationEpoch: 1, contentTrust: 'untrusted-web-content' as const,
      nodes: [{ ref: 'e1', role: 'button', name: '继续', depth: 1 }], truncated: false, textBytes: 8,
    }
  }

  async clickOwner(_ownerSessionId: string, _runId: string, ref: string) {
    return { ref, navigationEpoch: 1 }
  }

  async typeOwner(_ownerSessionId: string, _runId: string, ref: string, text: string, replace: boolean) {
    this.typedText.push(text)
    return { ref, textLength: text.length, replace }
  }

  async scrollOwner() {
    return { deltaX: 0, deltaY: 400 }
  }

  async extractOwner(_ownerSessionId: string, _runId: string, ref: string) {
    return { ref, text: 'hello', truncated: false }
  }

  async closeControlledOwner(): Promise<boolean> {
    return true
  }
}

describe('Pi 浏览器工具', () => {
  test('Given a user Work session When building tools Then the bounded browser surface is registered', () => {
    const tools = buildTools(new FakeBrowserService(), { workflow: 'direct', triggeredBy: 'user' })
    expect(tools.map(tool => tool.name)).toEqual([
      'BrowserOpen', 'BrowserNavigate', 'BrowserSnapshot', 'BrowserClick', 'BrowserType', 'BrowserScroll', 'BrowserExtract', 'BrowserClose',
    ])
  })

  test('Given BrowserType When execution succeeds Then the result exposes length but never echoes the typed text', async () => {
    const service = new FakeBrowserService()
    const tool = buildTools(service, { workflow: 'direct', triggeredBy: 'user' }).find(item => item.name === 'BrowserType')!
    const result = await tool.execute('tool-1', { ref: 'e1', text: 'private note', replace: true }, new AbortController().signal, undefined, undefined as never)
    const serialized = JSON.stringify(result)

    expect(service.typedText).toEqual(['private note'])
    expect(serialized).toContain('12')
    expect(serialized).not.toContain('private note')
    expect(service.controls.at(-1)).toMatchObject({ source: 'agent', intent: '向页面元素输入文本' })
  })

  test('Given a user-triggered restricted workflow When researching in the managed browser Then click and ordinary text input remain available', async () => {
    const service = new FakeBrowserService()
    const readOnlyTools = buildTools(service, { workflow: 'read-only', triggeredBy: 'user' })
    const click = readOnlyTools.find(item => item.name === 'BrowserClick')!
    const type = readOnlyTools.find(item => item.name === 'BrowserType')!

    await expect(click.execute('tool-1', { ref: 'e1' }, new AbortController().signal, undefined, undefined as never)).resolves.toMatchObject({
      details: { ref: 'e1', navigationEpoch: 1 },
    })
    await expect(type.execute('tool-2', { ref: 'e1', text: 'research query' }, new AbortController().signal, undefined, undefined as never)).resolves.toMatchObject({
      details: { ref: 'e1', textLength: 14 },
    })
  })

  test('Given unattended execution When calling an interactive browser tool Then it fails closed', async () => {
    const delegatedType = buildTools(new FakeBrowserService(), { workflow: 'direct', triggeredBy: 'delegation' })
      .find(item => item.name === 'BrowserType')!
    await expect(delegatedType.execute('tool-2', { ref: 'e1', text: 'hello' }, new AbortController().signal, undefined, undefined as never)).rejects.toThrow('用户触发')
  })
})

function buildTools(
  service: FakeBrowserService,
  context: { workflow: 'direct' | 'read-only' | 'plan-first'; triggeredBy: 'user' | 'automation' | 'delegation' },
): ToolDefinition[] {
  const sdk = {
    defineTool: (definition: ToolDefinition) => definition,
  }
  return buildPiBrowserTools(sdk as unknown as Parameters<typeof buildPiBrowserTools>[0], {
    sessionId: 'session-1',
    workflow: context.workflow,
    triggeredBy: context.triggeredBy,
  }, {
    resolveService: () => service,
    recordAudit: async () => {},
  })
}

function browserView(control: BrowserAgentControlView | null): BrowserSessionView {
  return {
    browserSessionId: 'browser-1', ownerSessionId: 'session-1', workspaceId: 'workspace-1', profileKind: 'project', control,
    page: {
      pageId: 'page-1', title: 'Example', url: 'https://example.com/path?token=secret', loadState: 'ready',
      canGoBack: false, canGoForward: false, navigationEpoch: 1, visible: true, zoomPercent: 100, fitToWidth: false,
    },
    sourceTarget: { kind: 'isolated', checkoutId: 'checkout-1', revision: 1, stale: false },
  }
}
