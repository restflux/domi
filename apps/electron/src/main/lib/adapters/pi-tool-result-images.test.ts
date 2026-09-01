import { describe, expect, test } from 'bun:test'
import { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { PNG } from 'pngjs'
import { buildPiNanoBananaTool } from '../chat-tools/nano-banana-agent-tool'
import { convertMcpResultForPi, type McpCallToolResult } from './pi-mcp-tools'

type ToolContent = TextContent | ImageContent

interface TestToolResult {
  content: ToolContent[]
  details: Record<string, unknown>
  usage?: unknown
}

interface ToolResultHookOutput {
  content?: ToolContent[]
  details?: Record<string, unknown>
  isError?: boolean
  usage?: unknown
}

interface ExtensionToolResult {
  content?: ToolContent[]
  details?: Record<string, unknown>
  isError?: boolean
  usage?: unknown
}

function solidPngBase64(width: number, height: number): string {
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png).toString('base64')
}

function noisyPngBase64(width: number, height: number): string {
  const png = new PNG({ width, height })
  let state = 0x12345678
  for (let index = 0; index < png.data.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    png.data[index] = state & 0xff
  }
  return PNG.sync.write(png).toString('base64')
}

function imageBlocks(content: ToolContent[]): ImageContent[] {
  return content.filter((block): block is ImageContent => block.type === 'image')
}

function textBlocks(content: ToolContent[]): TextContent[] {
  return content.filter((block): block is TextContent => block.type === 'text')
}

function decodedDimensions(image: ImageContent): { width: number; height: number } {
  const decoded = PNG.sync.read(Buffer.from(image.data, 'base64'))
  return { width: decoded.width, height: decoded.height }
}

function createAgentSessionImageHook(extensionResult?: ExtensionToolResult) {
  const session = Object.create(AgentSession.prototype) as unknown as {
    agent: {
      beforeToolCall?: (...args: unknown[]) => Promise<unknown>
      afterToolCall?: (context: {
        toolCall: { id: string; name: string; arguments: Record<string, unknown> }
        args: Record<string, unknown>
        result: TestToolResult
        isError: boolean
        context: Record<string, unknown>
      }, signal: AbortSignal) => Promise<ToolResultHookOutput | undefined>
    }
    settingsManager: { getImageAutoResize: () => boolean }
    _extensionRunner: {
      hasHandlers: (event: string) => boolean
      emitToolResult?: (event: unknown) => Promise<ExtensionToolResult | undefined>
    }
    _installAgentToolHooks: () => void
  }

  session.agent = {}
  session.settingsManager = { getImageAutoResize: () => true }
  session._extensionRunner = {
    hasHandlers: (event) => event === 'tool_result' && extensionResult !== undefined,
    emitToolResult: async () => extensionResult,
  }
  session._installAgentToolHooks()
  if (!session.agent.afterToolCall) throw new Error('Pi AgentSession did not install afterToolCall')
  return session.agent.afterToolCall
}

async function applyAgentSessionImageHook(
  result: TestToolResult,
  options: { isError?: boolean; extensionResult?: ExtensionToolResult } = {},
): Promise<TestToolResult & { isError: boolean }> {
  const hook = createAgentSessionImageHook(options.extensionResult)
  const after = await hook({
    toolCall: { id: 'tool-call-image', name: 'image_tool', arguments: {} },
    args: {},
    result,
    isError: options.isError ?? false,
    context: {},
  }, new AbortController().signal)

  // Mirrors pi-agent-core finalizeExecutedToolCall: omitted hook fields preserve the tool result.
  return {
    ...result,
    content: after?.content ?? result.content,
    details: after?.details ?? result.details,
    usage: after?.usage ?? result.usage,
    isError: after?.isError ?? options.isError ?? false,
  }
}

describe('Pi tool result image normalization', () => {
  test('keeps text and supported small images byte-for-byte while preserving result metadata', async () => {
    const smallImage = solidPngBase64(8, 8)
    const details = { source: 'small-image' }
    const usage = { input: 3, output: 5 }
    const result: TestToolResult = {
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', data: smallImage, mimeType: 'image/png' },
        { type: 'text', text: 'after' },
      ],
      details,
      usage,
    }

    const normalized = await applyAgentSessionImageHook(result, { isError: true })

    expect(normalized.content).toBe(result.content)
    expect(normalized.content).toEqual(result.content)
    expect(normalized.details).toBe(details)
    expect(normalized.usage).toBe(usage)
    expect(normalized.isError).toBe(true)
  })

  test('resizes dimension and encoded-size violations, preserves ordering, and adds per-image coordinate hints', async () => {
    const oversizedWidth = solidPngBase64(2_101, 4)
    const oversizedBytes = noisyPngBase64(1_500, 800)
    expect(Buffer.byteLength(oversizedBytes, 'utf8')).toBeGreaterThan(4.5 * 1024 * 1024)
    const result: TestToolResult = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: oversizedWidth, mimeType: 'image/png' },
        { type: 'text', text: 'middle' },
        { type: 'image', data: oversizedBytes, mimeType: 'image/png' },
        { type: 'text', text: 'last' },
      ],
      details: { source: 'oversized' },
    }

    const normalized = await applyAgentSessionImageHook(result)
    const images = imageBlocks(normalized.content)
    const texts = textBlocks(normalized.content).map((block) => block.text)

    expect(images).toHaveLength(2)
    expect(decodedDimensions(images[0]!)).toEqual({ width: 2_000, height: 4 })
    expect(images[0]!.data).not.toBe(oversizedWidth)
    expect(Buffer.byteLength(images[1]!.data, 'utf8')).toBeLessThan(4.5 * 1024 * 1024)
    expect(images[1]!.data).not.toBe(oversizedBytes)
    expect(texts).toEqual([
      'first',
      expect.stringContaining('original 2101x4'),
      'middle',
      expect.stringContaining('original 1500x800'),
      'last',
    ])
    expect(normalized.content.map((block) => block.type)).toEqual([
      'text', 'image', 'text', 'text', 'image', 'text', 'text',
    ])
  })

  test('normalizes images added by an Extension after the original tool result', async () => {
    const originalDetails = { source: 'original-tool' }
    const extensionImage = solidPngBase64(4_096, 2)
    const result: TestToolResult = {
      content: [{ type: 'text', text: 'original text' }],
      details: originalDetails,
      usage: { input: 1, output: 2 },
    }

    const normalized = await applyAgentSessionImageHook(result, {
      extensionResult: {
        content: [
          { type: 'text', text: 'extension text' },
          { type: 'image', data: extensionImage, mimeType: 'image/png' },
        ],
      },
    })

    expect(normalized.content[0]).toEqual({ type: 'text', text: 'extension text' })
    expect(decodedDimensions(imageBlocks(normalized.content)[0]!)).toEqual({ width: 2_000, height: 1 })
    expect(textBlocks(normalized.content).at(-1)?.text).toContain('original 4096x2')
    expect(normalized.details).toBe(originalDetails)
    expect(normalized.usage).toBe(result.usage)
  })

  test('keeps the original image when the image backend cannot decode it', async () => {
    const invalid = { type: 'image', data: 'not-a-valid-image', mimeType: 'image/png' } as const
    const result: TestToolResult = { content: [invalid], details: { source: 'invalid' } }

    const normalized = await applyAgentSessionImageHook(result)

    expect(normalized.content).toBe(result.content)
    expect(normalized.content).toEqual([invalid])
  })

  test('normalizes MCP images without losing error, structured content, or original details', async () => {
    const largeImage = solidPngBase64(2_101, 3)
    const mcpResult = {
      content: [
        { type: 'text', text: 'MCP text' },
        { type: 'image', data: largeImage, mimeType: 'image/png' },
      ],
      structuredContent: { count: 1 },
      isError: true,
    } as unknown as McpCallToolResult
    const converted = convertMcpResultForPi(mcpResult) as TestToolResult

    const normalized = await applyAgentSessionImageHook(converted, { isError: true })
    const texts = textBlocks(normalized.content).map((block) => block.text)

    expect(texts[0]).toBe('MCP tool returned isError=true.')
    expect(texts).toContain('MCP text')
    expect(texts).toContain('structuredContent:\n{\n  "count": 1\n}')
    expect(texts.some((text) => text.includes('original 2101x3'))).toBe(true)
    expect(decodedDimensions(imageBlocks(normalized.content)[0]!)).toEqual({ width: 2_000, height: 3 })
    expect(normalized.details).toMatchObject({
      structuredContent: { count: 1 },
      isError: true,
      content: [
        { type: 'text', text: 'MCP text' },
        { type: 'image', mimeType: 'image/png', dataOmitted: true },
      ],
    })
    expect(JSON.stringify(normalized.details)).not.toContain(largeImage)
    expect(normalized.isError).toBe(true)
  })

  test('normalizes every image returned by a multi-image Nano Banana 4K request', async () => {
    const imageA = solidPngBase64(4_096, 2)
    const imageB = solidPngBase64(2, 4_096)
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildPiNanoBananaTool(sdk, 'session-image', 'D:/workspace/project', async () => ({
      content: [
        { type: 'image', data: imageA, mimeType: 'image/png' },
        { type: 'text', text: 'generated two images' },
        { type: 'image', data: imageB, mimeType: 'image/png' },
      ],
    }))

    const generated = await tool.execute('nano-call', {
      prompt: 'generate two banners',
      imageSize: '4K',
      numberOfImages: 2,
    }, undefined, undefined, {} as never) as unknown as TestToolResult
    const normalized = await applyAgentSessionImageHook(generated)
    const images = imageBlocks(normalized.content)
    const hints = textBlocks(normalized.content).filter((block) => block.text.startsWith('[Image:'))

    expect(images).toHaveLength(2)
    expect(hints).toHaveLength(2)
    expect(decodedDimensions(images[0]!)).toEqual({ width: 2_000, height: 1 })
    expect(decodedDimensions(images[1]!)).toEqual({ width: 1, height: 2_000 })
    expect(normalized.details).toBe(generated.details)
    expect(normalized.details).toEqual({ imageCount: 2, textCount: 1, outputMode: 'session' })
    expect(normalized.details).not.toHaveProperty('content')
  })
})
