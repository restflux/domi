import { describe, expect, test } from 'bun:test'
import { resolvePiThinkingLevel } from './agent-thinking-level'

describe('Pi thinking level resolver', () => {
  test('Given OpenAI session override When resolving Then uses the per-session level', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { openAIThinkingLevel: 'off' },
      'openai-codex',
      'gpt-5.5',
    )).toBe('off')
  })

  test.each(['openai', 'openai-responses', 'custom'] as const)(
    'Given third-party %s GPT-5.6 When session has max override Then uses it',
    (provider) => {
      expect(resolvePiThinkingLevel(
        { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
        { openAIThinkingLevel: 'max' },
        provider,
        'gpt-5.6-terra',
      )).toBe('max')
    },
  )

  test('Given a persisted max override When switching to GPT-5.5 Then clamps it to xhigh', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { openAIThinkingLevel: 'max' },
      'custom',
      'gpt-5.5',
    )).toBe('xhigh')
  })

  test('Given non-OpenAI provider When session has OpenAI override Then keeps global Pi thinking level', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { openAIThinkingLevel: 'xhigh' },
      'anthropic',
    )).toBe('medium')
  })

  test('Given no session override When global max effort is selected Then maps it to xhigh', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'max' },
      undefined,
      'openai-responses',
    )).toBe('xhigh')
  })

  test('Given temporary adaptation declares a default without Off When no session preference Then uses that legal default', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      undefined,
      'opencode-go-openai',
      'ox-alpha-free',
      {
        source: 'temporary-adaptation',
        levels: ['low', 'high', 'max'],
        defaultLevel: 'low',
      },
    )).toBe('low')
  })

  test('Given legacy Off preference When model has no Off Then clamps it to a legal enabled level', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { reasoningLevel: 'off' },
      'opencode-go-openai',
      'ox-alpha-free',
      {
        source: 'temporary-adaptation',
        levels: ['low', 'high', 'max'],
        defaultLevel: 'low',
      },
    )).toBe('low')
  })

  test('Given no persisted preference When resolving a Pi thinking level Then defaults to medium', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' } },
      undefined,
      'anthropic',
    )).toBe('medium')
  })

  test.each([
    ['openai-codex', 'gpt-5.5'],
    ['openai-responses', 'gpt-5.6-terra'],
  ] as const)(
    'Given %s reasoning profile without persisted preference When resolving %s Then defaults to medium',
    (provider, modelId) => {
      expect(resolvePiThinkingLevel(
        { agentThinking: { type: 'adaptive' } },
        undefined,
        provider,
        modelId,
      )).toBe('medium')
    },
  )
})
