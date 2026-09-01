import { describe, expect, test } from 'bun:test'
import { buildPiContextBreakdown } from './pi-context-breakdown'

const skillCatalog = `\n\nThe following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>demo-skill</name>
    <description>用于测试上下文构成。</description>
    <location>/skills/demo-skill/SKILL.md</location>
  </skill>
</available_skills>`

function userMessage(text: string): unknown {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 1,
  }
}

const tools = [
  {
    name: 'mcp__demo__search',
    description: 'Search remote data',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'read',
    description: 'Read a local file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
]

describe('buildPiContextBreakdown', () => {
  test('Given Pi SDK message estimator 可用 When 估算对话历史 Then 优先使用 SDK 估算器', () => {
    let calls = 0
    const result = buildPiContextBreakdown({
      systemPrompt: '核心系统提示词',
      messages: [userMessage('用户问题')],
      tools: [],
      estimateMessageTokens: () => {
        calls += 1
        return 321
      },
      capturedAt: 1,
    })

    expect(calls).toBe(1)
    expect(result.conversation).toBe(321)
  })

  test('Given 实际请求包含 Skill 与不同来源工具 When 估算 Then 分离系统、Skills、MCP、内置工具和对话历史', () => {
    const expandedSkill = '<skill name="demo-skill" location="/skills/demo-skill/SKILL.md">\n这里是展开后的 Skill 正文。\n</skill>\n\n'
    const result = buildPiContextBreakdown({
      systemPrompt: `核心系统提示词${skillCatalog}`,
      messages: [userMessage(`${expandedSkill}用户问题`)],
      tools,
      toolSources: {
        mcp__demo__search: 'mcp',
        read: 'product',
      },
      capturedAt: 123,
    })

    expect(result.capturedAt).toBe(123)
    expect(result.system).toBeGreaterThan(0)
    expect(result.skills).toBeGreaterThan(0)
    expect(result.mcp).toBeGreaterThan(0)
    expect(result.tools).toBeGreaterThan(0)
    expect(result.conversation).toBeGreaterThan(0)
  })

  test('Given 图片块包含大段 base64 When 估算对话历史 Then 不按二进制字符串长度计费', () => {
    const small = buildPiContextBreakdown({
      systemPrompt: '核心系统提示词',
      messages: [{ role: 'user', content: [{ type: 'image', data: 'a', mimeType: 'image/png' }], timestamp: 1 }],
      tools: [],
      capturedAt: 1,
    })
    const large = buildPiContextBreakdown({
      systemPrompt: '核心系统提示词',
      messages: [{ role: 'user', content: [{ type: 'image', data: 'a'.repeat(500_000), mimeType: 'image/png' }], timestamp: 1 }],
      tools: [],
      capturedAt: 2,
    })

    expect(large.conversation).toBe(small.conversation)
  })

  test('Given Skill 正文由 Domi 展开到用户消息 When 估算 Then 正文计入 Skills 而不是重复计入对话历史', () => {
    const expandedSkill = '<skill name="demo-skill" location="/skills/demo-skill/SKILL.md">\n一段很长的 Skill 正文，用于验证分类不会重复。'.repeat(20) + '\n</skill>\n\n'
    const withoutExpansion = buildPiContextBreakdown({
      systemPrompt: `核心系统提示词${skillCatalog}`,
      messages: [userMessage('用户问题')],
      tools: [],
      capturedAt: 1,
    })
    const withExpansion = buildPiContextBreakdown({
      systemPrompt: `核心系统提示词${skillCatalog}`,
      messages: [userMessage(`${expandedSkill}用户问题`)],
      tools: [],
      capturedAt: 2,
    })

    expect(withExpansion.skills).toBeGreaterThan(withoutExpansion.skills)
    expect(withExpansion.conversation).toBeLessThanOrEqual(withoutExpansion.conversation + 1)
  })
})
