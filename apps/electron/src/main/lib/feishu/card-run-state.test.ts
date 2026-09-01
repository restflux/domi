import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage } from '@domi/shared'
import { createInitialState, reduce } from './card-run-state'

describe('Feishu card delta runtime', () => {
  test('streams delta text and does not duplicate it when the authoritative final message arrives', () => {
    let state = createInitialState()
    state = reduce(state, {
      kind: 'sdk_delta',
      delta: {
        uuid: 'assistant-1',
        deltas: [
          { type: 'text_start', contentIndex: 0 },
          { type: 'text_delta', contentIndex: 0, delta: 'hello ' },
          { type: 'text_delta', contentIndex: 0, delta: 'world' },
          { type: 'text_end', contentIndex: 0, content: 'hello world' },
        ],
      },
    })

    expect(state.blocks).toEqual([{ kind: 'text', content: 'hello world', streaming: false }])

    const final: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'hello world' }] },
    }
    state = reduce(state, { kind: 'sdk_message', message: final })

    expect(state.blocks).toEqual([{ kind: 'text', content: 'hello world', streaming: false }])
    expect(state.partialAssistantSnapshots['assistant-1']).toBeUndefined()
  })

  test('preserves reasoning strength when the runtime confirms the resolved model', () => {
    const initial = createInitialState({ model: 'GPT 5.6 Sol', thinkingLevel: 'high' })

    const state = reduce(initial, {
      kind: 'domi_event',
      event: { type: 'model_resolved', model: 'gpt-5.6-sol' },
    })

    expect(state.meta).toEqual({ model: 'gpt-5.6-sol', thinkingLevel: 'high' })
  })

  test('replaces an interrupted partial when native retry restarts with the same assistant uuid', () => {
    let state = createInitialState()
    state = reduce(state, {
      kind: 'sdk_delta',
      delta: {
        uuid: 'assistant-retry',
        deltas: [
          { type: 'start' },
          { type: 'text_start', contentIndex: 0 },
          { type: 'text_delta', contentIndex: 0, delta: 'broken partial' },
        ],
      },
    })
    state = reduce(state, {
      kind: 'sdk_delta',
      delta: {
        uuid: 'assistant-retry',
        deltas: [
          { type: 'start' },
          { type: 'text_start', contentIndex: 0 },
          { type: 'text_delta', contentIndex: 0, delta: 'recovered' },
          { type: 'text_end', contentIndex: 0, content: 'recovered' },
        ],
      },
    })

    expect(state.blocks).toEqual([{ kind: 'text', content: 'recovered', streaming: false }])
  })
})
