import { describe, expect, test } from 'bun:test'
import type { AskUserRequest } from '@domi/shared'
import { extractDirectWorkflowPresentation, extractDirectWorkflowToolPresentation } from './DirectWorkflowPreviewBlock'

function request(toolInput: Record<string, unknown>): AskUserRequest {
  return {
    requestId: 'direct-1',
    sessionId: 'session-1',
    questions: [],
    toolInput,
  }
}

describe('DirectWorkflowPreviewBlock helpers', () => {
  test('extracts free-form Markdown without imposing section headings', () => {
    expect(extractDirectWorkflowPresentation(request({
      presentation: {
        kind: 'direct-workflow',
        summary: '修复版本展示',
        details: '  已定位到 `VersionBadge`。\n\n- 去掉 `v` 前缀\n- 补组件测试  ',
      },
    }))).toEqual({
      kind: 'direct-workflow',
      summary: '修复版本展示',
      details: '已定位到 `VersionBadge`。\n\n- 去掉 `v` 前缀\n- 补组件测试',
    })
  })

  test('restores the same feedback from persisted RequestDirectWorkflow tool input', () => {
    expect(extractDirectWorkflowToolPresentation({
      summary: '持久化实施反馈',
      details: '拒绝或关闭审批后仍然可见。',
    })).toEqual({
      kind: 'direct-workflow',
      summary: '持久化实施反馈',
      details: '拒绝或关闭审批后仍然可见。',
    })
  })

  test('restores legacy structured requests as natural paragraphs without fixed template headings', () => {
    expect(extractDirectWorkflowPresentation(request({
      presentation: {
        kind: 'direct-workflow',
        intent: '**修复查询**',
        direction: '- 调整 SQL\n- 补测试',
        reason: '`Write` 文件并运行测试',
      },
    }))).toEqual({
      kind: 'direct-workflow',
      details: '**修复查询**\n\n- 调整 SQL\n- 补测试\n\n`Write` 文件并运行测试',
    })
  })

  test('ignores unrelated or empty presentations', () => {
    expect(extractDirectWorkflowPresentation(request({ presentation: { kind: 'other' } }))).toBeNull()
    expect(extractDirectWorkflowPresentation(request({ presentation: { kind: 'direct-workflow', details: '   ' } }))).toBeNull()
    expect(extractDirectWorkflowPresentation(request({ questions: [] }))).toBeNull()
  })
})
