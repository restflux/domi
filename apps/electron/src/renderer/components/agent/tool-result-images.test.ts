import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage } from '@domi/shared'
import {
  collectAssistantGeneratedImageToolUseIds,
  collectGeneratedImagesByToolId,
  collectImageContainingToolUseIds,
  flattenGeneratedImagesForTurn,
  parseToolResultContent,
  shouldShowTurnGeneratedImages,
} from './tool-result-images'

function assistantWithTools(...ids: string[]): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${ids.join('-')}`,
    parent_tool_use_id: null,
    message: {
      content: ids.map((id) => ({ type: 'tool_use', id, name: 'imagegen', input: {} })),
      model: 'test-model',
    },
  }
}

function toolResult(toolUseId: string, content: unknown): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  } as SDKMessage
}

describe('tool result generated images', () => {
  test('附件标记存在时优先 path 型，避免与 inline image 重复', () => {
    const marker = JSON.stringify({
      localPath: 'session/image.png',
      filename: 'image.png',
      mediaType: 'image/png',
    })
    const parsed = parseToolResultContent([
      { type: 'image', data: 'inline-base64', mimeType: 'image/png' },
      { type: 'text', text: `[DOMI_IMAGE_ATTACHMENT:${marker}]\n生成完成` },
    ])

    expect(parsed.text).toBe('生成完成')
    expect(parsed.images).toEqual([{
      localPath: 'session/image.png',
      filename: 'image.png',
      mimeType: 'image/png',
    }])
  })

  test('只收集当前 assistant turn 的 tool result', () => {
    const current = assistantWithTools('tool-current')
    const other = assistantWithTools('tool-other')
    const currentMarker = JSON.stringify({ localPath: 's/current.png', filename: 'current.png', mediaType: 'image/png' })
    const otherMarker = JSON.stringify({ localPath: 's/other.png', filename: 'other.png', mediaType: 'image/png' })
    const allMessages = [
      current,
      toolResult('tool-current', `[DOMI_IMAGE_ATTACHMENT:${currentMarker}]`),
      other,
      toolResult('tool-other', `[DOMI_IMAGE_ATTACHMENT:${otherMarker}]`),
    ]

    const toolIds = collectAssistantGeneratedImageToolUseIds([current])
    const byToolId = collectGeneratedImagesByToolId(allMessages, toolIds)
    const images = flattenGeneratedImagesForTurn([current], byToolId)

    expect(images.map((image) => image.filename)).toEqual(['current.png'])
    expect(byToolId.has('tool-other')).toBe(false)
  })

  test('读取图片的工具结果不会进入本轮生成图片集合', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-read-image',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_use', id: 'read-image', name: 'Read', input: { path: 'image.png' } }],
        model: 'test-model',
      },
    }
    const messages = [
      assistant,
      toolResult('read-image', [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: 'read-image-base64', mimeType: 'image/png' },
      ]),
    ]

    const toolIds = collectAssistantGeneratedImageToolUseIds([assistant])
    const byToolId = collectGeneratedImagesByToolId(messages, toolIds)

    expect(toolIds.size).toBe(0)
    expect(flattenGeneratedImagesForTurn([assistant], byToolId)).toEqual([])
  })

  test('识别内置与 MCP 形式的生图工具名', () => {
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-image-tool-names',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'plain', name: 'imagegen', input: {} },
          { type: 'tool_use', id: 'system', name: 'image_gen', input: {} },
          { type: 'tool_use', id: 'mcp', name: 'mcp__nano_banana__generate_image', input: {} },
          { type: 'tool_use', id: 'read', name: 'Read', input: {} },
        ],
        model: 'test-model',
      },
    }

    expect([...collectAssistantGeneratedImageToolUseIds([assistant])]).toEqual(['plain', 'system', 'mcp'])
  })

  test('多层 Agent/Task 子工具生成图片时沿 parent 链标记所有祖先过程工具', () => {
    const root: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-root',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_use', id: 'agent-root', name: 'Agent', input: {} }],
        model: 'test-model',
      },
    }
    const child: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-child',
      parent_tool_use_id: 'agent-root',
      message: {
        content: [{ type: 'tool_use', id: 'agent-child', name: 'Task', input: {} }],
        model: 'test-model',
      },
    }
    const grandchild: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-grandchild',
      parent_tool_use_id: 'agent-child',
      message: {
        content: [{ type: 'tool_use', id: 'image-tool', name: 'imagegen', input: {} }],
        model: 'test-model',
      },
    }
    const byToolId = new Map([
      ['image-tool', [{ localPath: 's/nested.png', filename: 'nested.png', mimeType: 'image/png' }]],
    ])

    expect([...collectImageContainingToolUseIds([root, child, grandchild], byToolId)].sort())
      .toEqual(['agent-child', 'agent-root', 'image-tool'])
  })

  test('按 tool_use 出现顺序展平并跨结果去重', () => {
    const assistant = assistantWithTools('tool-a', 'tool-b')
    const byToolId = new Map([
      ['tool-a', [{ localPath: 's/a.png', filename: 'a.png', mimeType: 'image/png' }]],
      ['tool-b', [
        { localPath: 's/a.png', filename: 'a.png', mimeType: 'image/png' },
        { localPath: 's/b.png', filename: 'b.png', mimeType: 'image/png' },
      ]],
    ])

    expect(flattenGeneratedImagesForTurn(assistant ? [assistant] : [], byToolId).map((image) => image.filename))
      .toEqual(['a.png', 'b.png'])
  })
})

describe('shouldShowTurnGeneratedImages', () => {
  test('已完成且图片过程组全部折叠时显示', () => {
    expect(shouldShowTurnGeneratedImages({ imageCount: 1, isStreaming: false, expandedImageGroupCount: 0 })).toBe(true)
  })

  test('流式中、无图或过程组展开时隐藏', () => {
    expect(shouldShowTurnGeneratedImages({ imageCount: 1, isStreaming: true, expandedImageGroupCount: 0 })).toBe(false)
    expect(shouldShowTurnGeneratedImages({ imageCount: 0, isStreaming: false, expandedImageGroupCount: 0 })).toBe(false)
    expect(shouldShowTurnGeneratedImages({ imageCount: 1, isStreaming: false, expandedImageGroupCount: 1 })).toBe(false)
  })
})
