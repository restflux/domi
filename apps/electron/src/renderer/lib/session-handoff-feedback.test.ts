import { describe, expect, test } from 'bun:test'
import { getSessionHandoffFeedback } from './session-handoff-feedback.ts'

describe('session handoff renderer feedback', () => {
  test('完整 fork 明确说明继承后在目标环境继续', () => {
    expect(getSessionHandoffFeedback({ mode: 'fork', reused: false }, 'local')).toEqual({
      title: '已交接到新会话',
      description: '新 Agent 会继续使用当前 Local，并读取 durable handoff。',
    })
  })

  test('降级交接明确警告未继承完整 Pi 历史且不伪装成 fork', () => {
    const feedback = getSessionHandoffFeedback({ mode: 'degraded', reused: false }, 'isolated')
    expect(feedback.title).toBe('已降级交接到新会话')
    expect(feedback.description).toContain('未继承完整 Pi 历史')
    expect(feedback.description).toContain('有界会话上下文')
  })

  test('重启后复用降级会话时保持降级标识', () => {
    expect(getSessionHandoffFeedback({ mode: 'degraded', reused: true }, 'local').title)
      .toBe('已打开现有降级接力会话')
  })
})
