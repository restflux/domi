import { describe, expect, test } from 'bun:test'
import { friendlyPiErrorMessage } from './pi-friendly-error'

describe('Pi user-facing error classification', () => {
  test('distinguishes local ContextCompactor evidence failures from provider request schema errors', () => {
    expect(friendlyPiErrorMessage(
      'Pinned fact evidence validation failed: delivery-working contains forbidden claim review has been prepared',
    )).toBe('上下文压缩增强证据校验失败，未发送模型请求；请关闭实验开关后重试')

    expect(friendlyPiErrorMessage('Response schema validation failed')).toBe(
      'API 请求格式校验失败，请重试或开启新会话',
    )
  })
})
