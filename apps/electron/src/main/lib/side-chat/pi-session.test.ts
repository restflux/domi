import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { catalogCredentials } from '../adapters/pi-catalog-runtime'
import { createSideChatResourceLoader } from '../adapters/pi-side-chat-resource-loader'
import { SIDE_CHAT_SYSTEM_PROMPT } from './policy'
import { saveSideChatImages } from './image-storage'
import { validateSideChatImages } from './images'
import { buildAttachedFilesBlock } from '../bridge-attachment-utils'
import { realpath } from 'node:fs/promises'

/** 真实 Pi Session + JSONL，Provider 使用内存响应，绝不访问网络。 */
test('Pi侧聊可与另一Session同时运行、多轮持久化并在重开后继续，不合并父历史', async () => {
  const root = await mkdtemp(join(tmpdir(), 'domi-side-chat-pi-'))
  const sessions: sdk.AgentSession[] = []
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://unused.invalid', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const runtime = await sdk.ModelRuntime.create({ credentials: catalogCredentials, modelsPath: null, refreshOnCreate: false })
  const calls: string[] = []
  runtime.registerProvider('fixture', { api: model.api, baseUrl: model.baseUrl, apiKey: 'test-only-not-a-real-key', models: [model], streamSimple: (_model, context) => {
    calls.push(JSON.stringify(context.messages))
    const stream = createAssistantMessageEventStream()
    setTimeout(() => {
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '内存回复' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(message)
    }, 10)
    return stream
  } })
  const open = async (manager: sdk.SessionManager): Promise<sdk.AgentSession> => {
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'agent'), model, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, tools: [], resourceLoader: createSideChatResourceLoader(sdk, { cwd: root, agentDir: join(root, 'agent'), settingsManager: settings, systemPrompt: SIDE_CHAT_SYSTEM_PROMPT }) })
    sessions.push(session)
    return session
  }
  try {
    const parent = await open(sdk.SessionManager.create(root, join(root, 'parent')))
    const manager = sdk.SessionManager.create(root, join(root, 'child'))
    const child = await open(manager)
    await Promise.all([parent.prompt('父任务唯一内容'), child.prompt('侧聊第一问')])
    await child.prompt('侧聊第二问')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain('侧聊第一问')
    expect(calls[2]).not.toContain('父任务唯一内容')
    const file = manager.getSessionFile()!
    child.dispose()
    const restored = await open(sdk.SessionManager.open(file))
    expect(calls).toHaveLength(3)
    await restored.prompt('重开后的第三问')
    expect(calls[3]).toContain('侧聊第二问')
    expect(calls[3]).not.toContain('父任务唯一内容')
  } finally {
    for (const session of sessions) session.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

/** 真实落盘、原生 Read 与 Pi tool loop；仅 Provider 响应离线，图片不伪造为工具文本。 */
test('Given 侧聊文件图片引用 When Pi 调用真实 Read Then 下一轮 Provider 收到 image block 而非初始图片注入', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domi-side-chat-read-')))
  const png = { filename: '截图.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==' }
  const model: Model<'openai-completions'> = { id: 'image-fixture', name: 'Image fixture', api: 'openai-completions', provider: 'image-fixture', baseUrl: 'http://unused.invalid', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const runtime = await sdk.ModelRuntime.create({ credentials: catalogCredentials, modelsPath: null, refreshOnCreate: false })
  let session: sdk.AgentSession | undefined
  let calls = 0
  let initialImage = false
  let readImage: { mimeType: string; data: string } | undefined
  try {
    const refs = saveSideChatImages(root, validateSideChatImages([png]))
    runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'test-only-not-a-real-key', models: [model], streamSimple: (_model, context) => {
      calls++
      if (calls === 1) initialImage = context.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image'))
      for (const message of context.messages) {
        if (message.role === 'toolResult') {
          const image = message.content.find(block => block.type === 'image')
          if (image?.type === 'image') readImage = image
        }
      }
      const stream = createAssistantMessageEventStream()
      const message: AssistantMessage = {
        role: 'assistant', content: calls === 1 ? [{ type: 'toolCall', id: 'read-image', name: 'read', arguments: { path: refs[0]!.path } }] : [{ type: 'text', text: '已基于 Read 图像回答' }],
        api: model.api, provider: model.provider, model: model.id, stopReason: calls === 1 ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }
      stream.push({ type: 'done', reason: calls === 1 ? 'toolUse' : 'stop', message }); stream.end(message)
      return stream
    } })
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
    ;({ session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'agent'), model, modelRuntime: runtime,
      sessionManager: sdk.SessionManager.create(root, join(root, 'history')), settingsManager: settings, tools: ['read'],
      resourceLoader: createSideChatResourceLoader(sdk, { cwd: root, agentDir: join(root, 'agent'), settingsManager: settings, systemPrompt: SIDE_CHAT_SYSTEM_PROMPT }),
    }))
    await session.prompt(`${buildAttachedFilesBlock(refs)}请用 Read 读取图片再回答。`)
    expect(calls).toBe(2)
    expect(initialImage).toBe(false)
    expect(session.messages.filter(message => message.role === 'toolResult')).toMatchObject([{ isError: false }])
    expect(readImage?.mimeType).toBe('image/png')
    expect(readImage?.data.length).toBeGreaterThan(0)
    expect(session.messages.some(message => message.role === 'toolResult' && message.content.some(block => block.type === 'image'))).toBe(true)
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }) }
}, 15000)
