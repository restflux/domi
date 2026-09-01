import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import {
  collectGeneratedImageToolUseIds,
  extractFinalAssistantText,
  extractGeneratedImagesFromToolResults,
} from './bridge-agent-message-utils'

function assistant(content: Array<Record<string, unknown>>, partial = false): SDKMessage {
  return {
    type: 'assistant',
    message: { content },
    parent_tool_use_id: null,
    ...(partial ? { _partial: true } : {}),
  } as unknown as SDKMessage
}

function toolResult(toolUseId: string, content: unknown): SDKMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('bridge-agent-message-utils', () => {
  test('只从最终 assistant 消息收集生图工具调用', () => {
    expect(collectGeneratedImageToolUseIds(assistant([
      { type: 'tool_use', id: 'img-1', name: 'mcp__gpt_image__imagegen', input: {} },
      { type: 'tool_use', id: 'read-1', name: 'read', input: {} },
    ]))).toEqual(['img-1'])
    expect(collectGeneratedImageToolUseIds(assistant([
      { type: 'tool_use', id: 'img-2', name: 'image_gen', input: {} },
    ], true))).toEqual([])
  })

  test('优先提取附件路径标记并去除同结果中的内联重复图', () => {
    const marker = '[DOMI_IMAGE_ATTACHMENT:{"localPath":"session/image.png","filename":"final.png","mediaType":"image/png"}]'
    const images = extractGeneratedImagesFromToolResults(toolResult('img-1', [
      { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      { type: 'text', text: marker },
    ]), new Set(['img-1']))

    expect(images).toEqual([{
      localPath: 'session/image.png',
      filename: 'final.png',
      mediaType: 'image/png',
    }])
  })

  test('非生图工具结果不回传图片，旧内联生图结果仍可回退', () => {
    const result = toolResult('tool-1', [{ type: 'image', data: 'abc', mimeType: 'image/jpeg' }])
    expect(extractGeneratedImagesFromToolResults(result, new Set(['other']))).toEqual([])
    expect(extractGeneratedImagesFromToolResults(result, new Set(['tool-1']))).toEqual([{
      data: 'abc',
      filename: 'generated-image.jpg',
      mediaType: 'image/jpeg',
    }])
  })

  test('最终文本提取继续忽略 partial 预览帧', () => {
    expect(extractFinalAssistantText(assistant([{ type: 'text', text: '完成' }]))).toBe('完成')
    expect(extractFinalAssistantText(assistant([{ type: 'text', text: '预览' }], true))).toBe('')
  })
})
