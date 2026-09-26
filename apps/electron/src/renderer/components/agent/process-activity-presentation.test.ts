import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@domi/shared'
import { getWorkProcessFallbackLabel } from './process-activity-presentation'

describe('没有耗时的历史工作过程', () => {
  test('普通探索或纯思考只显示入口，不汇总操作数量', () => {
    const blocks: SDKContentBlock[] = [
      { type: 'thinking', thinking: '先检查状态' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/w/a.ts' } },
      { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'foo' } },
    ]

    expect(getWorkProcessFallbackLabel(blocks)).toBe('工作过程')
    expect(getWorkProcessFallbackLabel([{ type: 'thinking', thinking: '先检查状态' }])).toBe('工作过程')
  })

  test('Worktree 交接在无耗时历史消息中仍保留专属完成状态', () => {
    const blocks: SDKContentBlock[] = [
      { type: 'tool_use', id: 'handoff', name: 'ForkToWorktree', input: {} },
    ]

    expect(getWorkProcessFallbackLabel(blocks)).toBe('已安排 managed Worktree 子会话，启动后将自动切换')
  })
})
