import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import { buildProcessActivityPresentation } from './process-activity-presentation'
import type { ToolPresentationEntry } from './tool-presentation-index'

function tool(id: string, name: string, input: Record<string, unknown> = {}): SDKToolUseBlock {
  return { type: 'tool_use', id, name, input } as SDKToolUseBlock
}

function result(completed = true, isError = false): ToolPresentationEntry {
  return { completed, isError, images: [] }
}

describe('消息区执行过程完成态摘要', () => {
  test('交错探索按用户任务语义统计，不要求调用连续同目标', () => {
    const presentation = buildProcessActivityPresentation([
      tool('read-1', 'Read', { path: 'C:\\w\\a.ts' }),
      tool('grep-1', 'Grep', { pattern: 'foo' }),
      tool('read-2', 'Read', { file_path: 'C:/w/b.ts' }),
      tool('grep-2', 'Glob', { pattern: '**/*.tsx' }),
      tool('bash-1', 'Bash', { command: 'git status' }),
    ])

    expect(presentation.summary).toBe('执行过程 · 读取 2 个文件 · 搜索 2 次 · 执行 1 条命令')
  })

  test('工具失败在整体折叠摘要中保持可见计数', () => {
    const blocks = [
      tool('read-1', 'Read', { path: '/w/a.ts' }),
      tool('grep-1', 'Grep', { pattern: 'foo' }),
      tool('bash-1', 'Bash', { command: 'git status' }),
    ]
    const index = new Map([
      ['read-1', result(true, true)],
      ['grep-1', result()],
      ['bash-1', result()],
    ])

    expect(buildProcessActivityPresentation(blocks, index).failedToolCount).toBe(1)
  })

  test('纯 thinking 过程完成后显示思考段数', () => {
    const blocks: SDKContentBlock[] = [
      { type: 'thinking', thinking: '先检查状态' },
      { type: 'thinking', thinking: '再确认滚动策略' },
    ]

    expect(buildProcessActivityPresentation(blocks).summary).toBe('执行过程 · 2 段思考')
  })

  test('Worktree handoff 保留专属状态文案', () => {
    const presentation = buildProcessActivityPresentation([
      tool('handoff', 'ForkToWorktree'),
    ], new Map(), true)

    expect(presentation.summary).toBe('正在安排 managed Worktree 子会话…')
  })
})
