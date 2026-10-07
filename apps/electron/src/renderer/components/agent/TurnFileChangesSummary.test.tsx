import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@domi/shared'
import {
  TURN_FILE_CHANGES_DEFAULT_EXPANDED,
  TurnFileChangesSummary,
} from './TurnFileChangesSummary'

function buildWriteTurn(overrides?: {
  toolId?: string
  filePath?: string
  isError?: boolean
}): SDKMessage[] {
  const toolId = overrides?.toolId ?? 'write-1'
  const assistant: SDKAssistantMessage = {
    type: 'assistant',
    uuid: `assistant-${toolId}`,
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_use',
        id: toolId,
        name: 'Write',
        input: { file_path: overrides?.filePath ?? '/project/summary.ts', content: 'text' },
      }],
      model: 'test-model',
    },
  }
  const user: SDKUserMessage = {
    type: 'user',
    uuid: `user-${toolId}`,
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolId,
        content: 'ok',
        is_error: overrides?.isError === true ? true : undefined,
      }],
    },
  }
  return [assistant, user]
}

describe('TurnFileChangesSummary', () => {
  test('默认折叠：只渲染标题与文件数，不渲染文件行', () => {
    expect(TURN_FILE_CHANGES_DEFAULT_EXPANDED).toBe(false)

    const markup = renderToStaticMarkup(
      <TurnFileChangesSummary turnMessages={buildWriteTurn()} basePath="/project" />,
    )

    expect(markup).toContain('data-work-v2-file-summary="true"')
    expect(markup).toContain('已编辑文件')
    expect(markup).toContain('1 个文件')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('summary.ts')
  })

  test('失败的工具调用不计入已编辑文件', () => {
    const markup = renderToStaticMarkup(
      <TurnFileChangesSummary turnMessages={buildWriteTurn({ isError: true })} basePath="/project" />,
    )

    expect(markup).toBe('')
  })

  test('去重后按文件数展示统计', () => {
    const markup = renderToStaticMarkup(
      <TurnFileChangesSummary
        turnMessages={[
          ...buildWriteTurn({ toolId: 'write-a', filePath: '/project/a.ts' }),
          ...buildWriteTurn({ toolId: 'edit-a', filePath: '/project/a.ts' }),
          ...buildWriteTurn({ toolId: 'write-b', filePath: '/project/b.ts' }),
        ]}
        basePath="/project"
      />,
    )

    expect(markup).toContain('2 个文件')
  })
})
