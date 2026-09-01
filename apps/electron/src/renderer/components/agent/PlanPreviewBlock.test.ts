import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import {
  buildPlanPreviewFile,
  extractPlanText,
  findPlanFilePath,
  getPlanContentBasePaths,
  getPlanPreviewText,
  hasPersistedPlanToolUse,
  resolvePlanExpansionToggle,
  resolvePlanFilePath,
} from './PlanPreviewBlock'

function assistantWrite(filePath: string, content: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'write-plan',
        name: 'Write',
        input: { file_path: filePath, content },
      }],
    },
  } as SDKMessage
}

describe('PlanPreviewBlock helpers', () => {
  test('extracts a non-empty plan string and ignores non-string input', () => {
    expect(extractPlanText({ plan: '  # Plan\n\n内容  ' })).toBe('# Plan\n\n内容')
    expect(extractPlanText({ plan: { text: '内容' } })).toBeNull()
    expect(extractPlanText(undefined)).toBeNull()
  })

  test('keeps short plans intact and truncates only the preview for long plans', () => {
    const shortPlan = '# Plan\n\n一步'
    expect(getPlanPreviewText(shortPlan)).toBe(shortPlan)

    const longPlan = Array.from({ length: 14 }, (_, index) => `步骤 ${index + 1}`).join('\n')
    expect(getPlanPreviewText(longPlan)).toBe(`${Array.from({ length: 12 }, (_, index) => `步骤 ${index + 1}`).join('\n')}\n\n…`)
  })

  test('stops bottom following before expanding a plan but not when collapsing it', () => {
    expect(resolvePlanExpansionToggle(false)).toEqual({
      expanded: true,
      shouldStopBottomFollow: true,
    })
    expect(resolvePlanExpansionToggle(true)).toEqual({
      expanded: false,
      shouldStopBottomFollow: false,
    })
  })

  test('resolves plan-body file mentions relative to the written plan before the Session Target', () => {
    expect(getPlanContentBasePaths(
      'C:/domi/session-a/.context/plan/implementation.md',
      'D:/checkout',
      ['D:/attached', 'D:/checkout'],
    )).toEqual([
      'C:/domi/session-a/.context/plan',
      'D:/checkout',
      'D:/attached',
    ])
  })

  test('builds a read-only preview with the approved plan body as an authoritative snapshot', () => {
    expect(buildPlanPreviewFile(
      '.context/plan/implementation.md',
      '  # 实施计划\r\n\r\n第一步  ',
      'C:/domi/session-a',
      ['D:/attached', 'C:/domi/session-a'],
    )).toEqual({
      filePath: '.context/plan/implementation.md',
      previewOnly: true,
      readOnly: true,
      basePaths: ['C:/domi/session-a', 'D:/attached'],
      snapshotContent: '# 实施计划\n\n第一步',
    })
  })

  test('detects when the same ExitPlanMode plan is already persisted in messages', () => {
    const plan = '# 实施计划\n\n1. 修改 renderer'
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'exit-plan',
          name: 'ExitPlanMode',
          input: { plan },
        }],
      },
    } as SDKMessage

    expect(hasPersistedPlanToolUse(plan, [message])).toBe(true)
    expect(hasPersistedPlanToolUse('# 其它计划', [message])).toBe(false)
  })

  test('links only the Write whose content matches the ExitPlanMode plan', () => {
    const plan = '# 修复任务\n\n1. 更新组件'
    const messages: SDKMessage[] = [
      assistantWrite('D:/workspace/other.md', '# 其它文件'),
      assistantWrite('D:/workspace/generated-plan.md', plan),
    ]

    expect(findPlanFilePath(plan, messages)).toBe('D:/workspace/generated-plan.md')
    expect(findPlanFilePath('# 不存在', messages)).toBeNull()
    expect(resolvePlanFilePath(plan, messages, 'C:/domi/session-a'))
      .toBe('D:/workspace/generated-plan.md')
  })

  test('falls back to the host-persisted current-plan.md so plans without an Agent Write remain directly openable', () => {
    expect(resolvePlanFilePath('# 计划', [], 'C:/domi/session-a'))
      .toBe('C:/domi/session-a/.context/plan/current-plan.md')
    expect(resolvePlanFilePath('# 计划', [], 'C:\\domi\\session-a\\'))
      .toBe('C:\\domi\\session-a\\.context\\plan\\current-plan.md')
    expect(resolvePlanFilePath('# 计划', [], undefined)).toBeNull()
  })
})
