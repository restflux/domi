import { describe, expect, test } from 'bun:test'
import { normalizeContextBreakdown } from './context-breakdown'

describe('normalizeContextBreakdown', () => {
  test('Given 请求构成估算与真实输入 Token When 归一化 Then 分类总和精确等于当前上下文占用', () => {
    const result = normalizeContextBreakdown({
      capturedAt: 1,
      system: 10,
      skills: 20,
      mcp: 30,
      tools: 15,
      conversation: 25,
    }, 88_300)

    expect(result?.reduce((sum, item) => sum + item.tokens, 0)).toBe(88_300)
    expect(result?.map((item) => item.key)).toEqual(['mcp', 'conversation', 'skills', 'tools', 'system'])
    expect(result?.map((item) => item.label)).toEqual(['MCP', '对话历史', 'Skills', '内置工具', '系统提示词'])
    expect(result?.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(1)
  })

  test('Given 估算总量为零或真实输入无效 When 归一化 Then 不展示误导构成', () => {
    expect(normalizeContextBreakdown({
      capturedAt: 1,
      system: 0,
      skills: 0,
      mcp: 0,
      tools: 0,
      conversation: 0,
    }, 100)).toBeUndefined()
    expect(normalizeContextBreakdown({
      capturedAt: 1,
      system: 1,
      skills: 0,
      mcp: 0,
      tools: 0,
      conversation: 0,
    }, 0)).toBeUndefined()
  })
})
