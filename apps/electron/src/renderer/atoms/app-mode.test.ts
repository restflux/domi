import { describe, expect, test } from 'bun:test'
import { resolveToggledConversationMode } from './app-mode'

describe('resolveToggledConversationMode', () => {
  test('Chat 与 Work 互相切换', () => {
    expect(resolveToggledConversationMode('chat')).toBe('agent')
    expect(resolveToggledConversationMode('agent')).toBe('chat')
  })

  test('从草稿本触发时进入 Chat', () => {
    expect(resolveToggledConversationMode('scratch')).toBe('chat')
  })
})
