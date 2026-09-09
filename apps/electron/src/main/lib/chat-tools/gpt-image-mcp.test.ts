import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { buildPiGptImageTool } from './gpt-image-agent-tool'

import type { Channel, ImageGenerationSelection } from '@domi/shared'
let selectedChannel: Channel | undefined
let defaultSelection: ImageGenerationSelection | undefined
mock.module('../channel-manager', () => ({ getChannelById: () => selectedChannel, decryptApiKey: () => 'channel-key' }))
mock.module('../settings-service', () => ({ getSettings: () => ({ imageGeneration: defaultSelection }), updateSettings: () => undefined }))

// 可变的模拟凭据：验证 Agent 注入仅依赖凭据、不依赖工具设置页开关
let mockedCredentials: Record<string, string> = {}

mock.module('../chat-tool-config', () => ({
  getChatToolsConfig: () => ({ customTools: [], toolStates: {}, toolCredentials: {} }),
  saveChatToolsConfig: () => undefined,
  updateToolState: () => undefined,
  updateToolCredentials: () => undefined,
  // 恒返回 disabled：若注入仍依赖工具开关，下方用例会失败
  getToolState: () => ({ enabled: false }),
  getToolCredentials: () => mockedCredentials,
  addCustomTool: () => undefined,
  deleteCustomTool: () => undefined,
}))

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => 'aW1hZ2UtYnl0ZXM=', // "image-bytes"
  deleteAttachment: () => undefined,
  deleteConversationAttachments: () => undefined,
  saveAttachment: (input: { conversationId: string; filename: string; mediaType: string; data: string }) => ({
    attachment: {
      id: 'att-1',
      filename: input.filename,
      mediaType: input.mediaType,
      localPath: `${input.conversationId}/att-1.png`,
      size: 10,
    },
  }),
}))

let buildPiGptImageTools: typeof import('./gpt-image-mcp').buildPiGptImageTools

beforeAll(async () => {
  ;({ buildPiGptImageTools } = await import('./gpt-image-mcp'))
})

afterAll(() => {
  mockedCredentials = {}
})

describe('GPT Image Pi custom tool', () => {
  test('Given a runtime-neutral generator When tool executes Then params and cwd are bridged into a Pi AgentToolResult', async () => {
    const calls: unknown[] = []
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildPiGptImageTool(
      sdk,
      'session-1',
      'D:/workspace/project',
      async (prompt, sessionId, options) => {
        calls.push({ prompt, sessionId, options })
        return {
          content: [
            { type: 'image', data: 'base64-image', mimeType: 'image/png' },
            { type: 'text', text: '图片已生成' },
          ],
        }
      },
    )

    const result = await tool.execute('tool-call-1', {
      prompt: 'draw a Domi logo',
      size: '1536x1024',
      referenceImagePaths: ['reference.png'],
      numberOfImages: 2,
      outputMode: 'workspace',
    }, undefined, undefined, {} as never)

    expect(tool.name).toBe('mcp__gpt_image__imagegen')
    expect(tool.description).toContain('regenerate')
    expect(tool.promptSnippet).toContain('call mcp__gpt_image__imagegen directly')
    expect(tool.promptSnippet).toContain('Do not stop after merely planning')
    expect(calls).toEqual([{
      prompt: 'draw a Domi logo',
      sessionId: 'session-1',
      options: {
        size: '1536x1024',
        referenceImagePaths: ['reference.png'],
        cwd: 'D:/workspace/project',
        numberOfImages: 2,
        outputMode: 'workspace',
      },
    }])
    expect(result.content).toHaveLength(2)
    expect(result.details).toEqual({ imageCount: 1, textCount: 1, outputMode: 'workspace' })
    expect(result.details).not.toHaveProperty('content')
  })

  test('Given output mode is omitted When tool executes Then generation defaults to session attachments', async () => {
    const calls: unknown[] = []
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildPiGptImageTool(sdk, 'session-default', 'D:/workspace/project', async (_prompt, _sessionId, options) => {
      calls.push(options)
      return { content: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }] }
    })

    await tool.execute('tool-call-default', { prompt: 'draw' }, undefined, undefined, {} as never)

    expect(calls).toEqual([expect.objectContaining({ outputMode: 'session' })])
  })

  test('Given generator returns no image When tool executes Then textual output cannot be mistaken for completion', async () => {
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildPiGptImageTool(sdk, 'session-empty', undefined, async () => ({
      content: [{ type: 'text', text: '未生成任何图片' }],
    }))

    expect(tool.execute('tool-call-empty', { prompt: 'draw' }, undefined, undefined, {} as never))
      .rejects.toThrow('图片生成失败: 未生成任何图片')
  })

  test('Given generator failure When tool executes Then the result is explicitly marked as an error', async () => {
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildPiGptImageTool(sdk, 'session-2', undefined, async () => {
      throw new Error('upstream unavailable')
    })

    expect(tool.execute('tool-call-2', { prompt: 'draw' }, undefined, undefined, {} as never))
      .rejects.toThrow('图片生成失败: upstream unavailable')
  })
})

describe('buildPiGptImageTools（Agent 注入条件：仅凭能力中心开关+凭据）', () => {
  const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')

  beforeEach(() => {
    mockedCredentials = {}
  })

  test('Given 凭据已配置且工具页开关关闭 When 构建注入 Then 返回 mcp__gpt_image__imagegen（不依赖工具开关）', () => {
    mockedCredentials = { apiKey: 'test-key' }

    const tools = buildPiGptImageTools(sdk, 'session-gpt-image')

    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('mcp__gpt_image__imagegen')
  })

  test('Given 未配置凭据 When 构建注入 Then 返回空数组', () => {
    mockedCredentials = {}

    expect(buildPiGptImageTools(sdk, 'session-gpt-image')).toEqual([])
  })
})


describe('GPT Image 本轮选择快照', () => {
  test('Given 用户选择模型和质量 When 模型提供替代参数并修改原对象 Then 闭包保持用户选择且取消信号透传', async () => {
    const originalFetch = globalThis.fetch
    const selection: ImageGenerationSelection = { channelId: 'image-channel', modelId: 'gpt-image-2.5-flare', quality: 'max', size: '1024x1024', numberOfImages: 1 }
    selectedChannel = { id: 'image-channel', name: '图片', provider: 'openai', enabled: true, baseUrl: 'https://images.example.com/v1', apiKey: 'encrypted', models: [], createdAt: 0, updatedAt: 0, imageGeneration: { protocol: 'openai-images', models: ['gpt-image-2.5-flare'] } }
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    try {
      const tool = buildPiGptImageTools(sdk, 'snapshot-session', undefined, selection)[0]!
      selection.modelId = 'changed-model'
      let body: Record<string, unknown> = {}
      let requestSignal: AbortSignal | null | undefined
      globalThis.fetch = (async (_url, init) => {
        body = JSON.parse(String(init?.body)); requestSignal = init?.signal
        return Response.json({ data: [{ b64_json: 'image' }] })
      }) as typeof fetch
      const controller = new AbortController()
      const result = await tool.execute('call', { prompt: 'a cat', model: 'override', quality: 'low', size: '1536x1024', numberOfImages: 4 }, controller.signal, undefined, {} as never)
      expect(body).toMatchObject({ model: 'gpt-image-2.5-flare', quality: 'max', size: '1024x1024', n: 1 })
      expect(result.details).toMatchObject({ model: 'gpt-image-2.5-flare', channelId: 'image-channel', quality: 'max', imageCount: 1, outputMode: 'session' })
      expect(JSON.stringify(result)).not.toContain('channel-key')
      controller.abort()
      expect(requestSignal?.aborted).toBe(true)
    } finally { globalThis.fetch = originalFetch; selectedChannel = undefined; defaultSelection = undefined }
  })
  test('Given 创建工具时无默认选择 When 默认设置随后变更 Then 已创建工具仍只用原旧凭据', async () => {
    mockedCredentials = { apiKey: 'legacy-key' }
    const originalFetch = globalThis.fetch
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    try {
      const tool = buildPiGptImageTools(sdk, 'legacy-snapshot')[0]!
      defaultSelection = { channelId: 'missing', modelId: 'different-model' }
      globalThis.fetch = (async (_url, init) => {
        expect(JSON.parse(String(init?.body)).model).toBe('gpt-image-2')
        return Response.json({ data: [{ b64_json: 'image' }] })
      }) as typeof fetch
      const result = await tool.execute('call', { prompt: 'a cat' }, undefined, undefined, {} as never)
      expect(result.details).toMatchObject({ model: 'gpt-image-2' })
    } finally { globalThis.fetch = originalFetch; defaultSelection = undefined; mockedCredentials = {} }
  })
})
