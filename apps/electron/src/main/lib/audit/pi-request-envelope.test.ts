import { describe, expect, test } from 'bun:test'
import { capturePiRequestEnvelope } from './pi-request-envelope.ts'

describe('capturePiRequestEnvelope', () => {
  test('Given a real provider request When captured Then only stable hashes, counts and safe runtime metadata are retained', () => {
    const systemPrompt = 'system secret sk-request-envelope-secret'
    const tools = [{
      name: 'read',
      description: 'private tool description',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'C:/private/project' },
          limit: { type: 'number' },
        },
      },
    }]
    const runtimeContext = {
      executionPolicy: 'controlled' as const,
      workflow: 'direct' as const,
      sessionTarget: {
        kind: 'isolated' as const,
        ownership: 'owner' as const,
        revision: 7,
      },
    }

    const envelope = capturePiRequestEnvelope({
      capturedAt: 1_234,
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      reasoningLevel: 'high',
      contextWindow: 131_072,
      systemPrompt,
      messageCount: 9,
      tools,
      piActiveLeafId: 'leaf-abc',
      runtimeContext,
    })

    expect(envelope).toMatchObject({
      version: 1,
      capturedAt: 1_234,
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      reasoningLevel: 'high',
      contextWindow: 131_072,
      messageCount: 9,
      toolCount: 1,
      piActiveLeafId: 'leaf-abc',
      controls: { executionPolicy: 'controlled', workflow: 'direct' },
      sessionTarget: { kind: 'isolated', ownership: 'owner', revision: 7 },
    })
    expect(envelope.systemPromptHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(envelope.toolSchemaHash).toMatch(/^sha256:[a-f0-9]{64}$/)

    runtimeContext.executionPolicy = 'controlled'
    runtimeContext.sessionTarget.revision = 99
    tools[0]!.description = 'changed after capture'

    expect(envelope.controls).toEqual({ executionPolicy: 'controlled', workflow: 'direct' })
    expect(envelope.sessionTarget).toEqual({ kind: 'isolated', ownership: 'owner', revision: 7 })
    const serialized = JSON.stringify(envelope)
    for (const forbidden of ['sk-request-envelope-secret', 'private tool description', 'C:/private/project', 'changed after capture']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test('Given equivalent tool schemas with different object key insertion order When captured Then fingerprints stay deterministic', () => {
    const base = {
      capturedAt: 10,
      provider: 'openai-responses',
      modelId: 'gpt-5.6',
      reasoningLevel: 'xhigh',
      contextWindow: 272_000,
      systemPrompt: 'same prompt',
      messageCount: 2,
      piActiveLeafId: null,
    }
    const first = capturePiRequestEnvelope({
      ...base,
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }],
    })
    const second = capturePiRequestEnvelope({
      ...base,
      tools: [{ description: 'Read', parameters: { properties: { path: { type: 'string' } }, required: ['path'], type: 'object' }, name: 'read' }],
    })

    expect(first.systemPromptHash).toBe(second.systemPromptHash)
    expect(first.toolSchemaHash).toBe(second.toolSchemaHash)
    expect(first).not.toHaveProperty('controls')
    expect(first).not.toHaveProperty('sessionTarget')
  })
})
