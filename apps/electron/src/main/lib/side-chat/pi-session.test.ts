import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { catalogCredentials } from '../adapters/pi-catalog-runtime'
import { createSideChatResourceLoader } from '../adapters/pi-side-chat-resource-loader'
import { SIDE_CHAT_SYSTEM_PROMPT } from './policy'

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
