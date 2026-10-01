import { describe, expect, test } from 'bun:test'
import {
  addSideChatSelection, getSideChatSelections, getSideChatSelectionLimitReason, clearSideChatSelectionLimitReason,
  removeSideChatSelection, clearSideChatSelections, buildPromptWithSideChatSelections, subscribeSideChatSelections,
  SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH,
} from '@/lib/side-chat-selections'

function selection(text: string, overrides: Record<string, unknown> = {}) {
  return {
    text,
    filePath: 'Agent 历史',
    sourceType: 'agent-history',
    sourceLabel: 'Agent 历史 · 助手回复',
    capturedAt: Date.now(),
    ...overrides,
  } as Parameters<typeof addSideChatSelection>[1]
}

describe('侧聊选区引用（ZCode conversationSelectionReference 移植）', () => {
  test('多引追加、去重与按父会话隔离', () => {
    clearSideChatSelections('p1'); clearSideChatSelections('p2')
    expect(addSideChatSelection('p1', selection('第一段')).ok).toBe(true)
    expect(addSideChatSelection('p1', selection('第二段')).ok).toBe(true)
    // 完全相同的选段去重，不新增条目
    const dup = addSideChatSelection('p1', selection('第一段'))
    expect(dup.duplicate).toBe(true)
    expect(getSideChatSelections('p1')).toHaveLength(2)
    // 其他父会话隔离
    expect(getSideChatSelections('p2')).toHaveLength(0)
    addSideChatSelection('p2', selection('另一会话'))
    expect(getSideChatSelections('p1')).toHaveLength(2)
    expect(getSideChatSelections('p2')).toHaveLength(1)
    // 删除与清空
    removeSideChatSelection('p1', getSideChatSelections('p1')[0]!.id)
    expect(getSideChatSelections('p1')).toHaveLength(1)
    clearSideChatSelections('p1')
    expect(getSideChatSelections('p1')).toHaveLength(0)
  })

  test('限流：单条长度、条数与总量；原因可查询并清除', () => {
    clearSideChatSelections('p')
    const tooLong = addSideChatSelection('p', selection('长'.repeat(SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH + 1)))
    expect(tooLong.ok).toBe(false)
    expect(tooLong.reason).toBe('single')
    expect(getSideChatSelectionLimitReason('p')).toBe('single')
    for (let i = 0; i < 8; i += 1) addSideChatSelection('p', selection(`第${i}段`, { sourceLabel: `来源${i}` }))
    expect(getSideChatSelections('p')).toHaveLength(8)
    const overflow = addSideChatSelection('p', selection('第九段', { sourceLabel: '来源9' }))
    expect(overflow.ok).toBe(false)
    expect(overflow.reason).toBe('count')
    clearSideChatSelectionLimitReason('p')
    expect(getSideChatSelectionLimitReason('p')).toBeNull()
    clearSideChatSelections('p')
    addSideChatSelection('p', selection('a'.repeat(SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH), { sourceLabel: '来源A' }))
    addSideChatSelection('p', selection('b'.repeat(SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH), { sourceLabel: '来源B' }))
    expect(getSideChatSelections('p')).toHaveLength(2)
    const total = addSideChatSelection('p', selection('c'.repeat(SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH), { sourceLabel: '来源C' }))
    expect(total.ok).toBe(false)
    expect(total.reason).toBe('total')
    clearSideChatSelections('p')
  })

  test('序列化复用 quoted_context 合同，正文在前引用块收尾', () => {
    const prompt = buildPromptWithSideChatSelections('我的问题', [
      { text: '引用一', filePath: 'Agent 历史', sourceType: 'agent-history', sourceLabel: 'Agent 历史 · 用户消息', capturedAt: 1 },
    ])
    expect(prompt.startsWith('我的问题')).toBe(true)
    expect(prompt).toContain('<quoted_context')
    expect(prompt).toContain('引用一')
    expect(buildPromptWithSideChatSelections('正文', [])).toBe('正文')
    // 引用块可被共享的 parseQuotedSelectionRefs 解析（UserInputMessage 渲染 chip 的合同）
    const onlyQuote = buildPromptWithSideChatSelections('', [{ text: '只有引用', filePath: '草稿页', sourceType: 'scratch-pad', sourceLabel: '草稿页', capturedAt: 1 }])
    expect(onlyQuote).toContain('<quoted_context')
    expect(onlyQuote.startsWith('<')).toBe(true)
  })

  test('变更通知驱动面板 chips 同步', () => {
    clearSideChatSelections('notify')
    let changes = 0
    const stop = subscribeSideChatSelections(() => { changes += 1 })
    addSideChatSelection('notify', selection('通知段'))
    removeSideChatSelection('notify', getSideChatSelections('notify')[0]!.id)
    clearSideChatSelections('notify')
    stop()
    const before = changes
    addSideChatSelection('notify', selection('停止后不再通知'))
    expect(changes).toBe(before)
    clearSideChatSelections('notify')
  })
})
