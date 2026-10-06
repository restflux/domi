import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai/compat'
import {
  SessionManager,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent'

function user(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'projection-test-provider',
    model: 'context-projection-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function toolResult(text: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }
}

describe('Pi 1.0 native session projection', () => {
  test('builds a compaction-aware provider projection from the active session path', () => {
    const manager = SessionManager.inMemory('/tmp/domi-pi-projection')
    manager.appendMessage(user('先读取文件'))
    manager.appendMessage(assistant('我将读取文件'))
    const toolEntryId = manager.appendMessage(toolResult('file contents'))

    manager.appendCompaction('已完成读取阶段的摘要', toolEntryId, 88_000)

    const projection = manager.buildSessionProjection()
    expect(projection.messages.map(message => message.role)).toEqual(['compactionSummary', 'toolResult'])
    expect(projection.messages[0]).toMatchObject({
      role: 'compactionSummary',
      summary: '已完成读取阶段的摘要',
      tokensBefore: 88_000,
    })
    expect(projection.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1' })
  })

  test('applies append-only context edits without mutating the original tool result', () => {
    const manager = SessionManager.inMemory('/tmp/domi-pi-context-edit')
    manager.appendMessage(user('执行读取'))
    const toolEntryId = manager.appendMessage(toolResult('secret output that should be shortened'))
    const originalEntry = manager.getEntry(toolEntryId)
    if (!originalEntry || originalEntry.type !== 'message') throw new Error('tool entry missing')

    manager.appendContextEdit(toolEntryId, {
      content: [{ type: 'text', text: '[tool output omitted by context policy]' }],
    })

    const projection = manager.buildSessionProjection()
    const projectedTool = projection.messages.find(message => message.role === 'toolResult')
    expect(projectedTool).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: '[tool output omitted by context policy]' }],
    })
    expect(sessionEntryToContextMessages(originalEntry)[0]).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: 'secret output that should be shortened' }],
    })
  })

  test('keeps state-only session entries out of the model projection', () => {
    const manager = SessionManager.inMemory('/tmp/domi-pi-state-entry')
    manager.appendMessage(user('继续'))
    manager.appendCustomEntry('domi_state', { pinnedFactCount: 2 })
    manager.appendSessionInfo('测试会话')

    const projection = manager.buildSessionProjection()
    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '继续' }] })
  })
})
