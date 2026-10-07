import { describe, expect, test } from 'bun:test'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as codingAgent from '@earendil-works/pi-coding-agent'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

const sdk = { ...codingAgent, getCurrentTools }
import { preparePiMcpToolDiscovery } from './pi-mcp-tool-discovery.ts'

function tool(name: string): ToolDefinition {
  return { name, label: name, description: 'Search documents', parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} } } }
}

const tools = [tool('Read'), tool('ReadyForReview'), tool('mcp__docs__search')]
const toolSources = { mcp__docs__search: 'mcp' as const }

describe('Domi MCP 发现切片', () => {
  test('Given 未显式 opt-in When 准备工具 Then 默认全量定义和引用保持原样', () => {
    const plan = preparePiMcpToolDiscovery(sdk, { tools, toolSources })
    expect(plan.tools).toBe(tools)
    expect(plan.extensionFactories).toEqual([])
    expect(plan.tools.every(definition => definition.exposure === undefined)).toBe(true)
  })

  test('Given opt-in 和明确来源 When 准备 Then 只延迟用户 MCP 且不改身份/schema/execute/核心定义', () => {
    const plan = preparePiMcpToolDiscovery(sdk, { enabled: true, tools, toolSources })
    expect(plan.tools[0]).toBe(tools[0])
    expect(plan.tools[1]).toBe(tools[1])
    expect(plan.tools[2]).toMatchObject({ name: 'mcp__docs__search', exposure: 'deferred', namespace: { name: 'mcp__docs' } })
    expect(plan.tools[2]!.parameters).toBe(tools[2]!.parameters)
    expect(plan.tools[2]!.execute).toBe(tools[2]!.execute)
    expect(tools[2]!.exposure).toBeUndefined()
    expect(plan.extensionFactories).toHaveLength(1)
  })

  test('Given 仅名称像 MCP 但无 MCP 来源 When opt-in Then 不延迟也不注册发现工具', () => {
    const plan = preparePiMcpToolDiscovery(sdk, { enabled: true, tools })
    expect(plan.tools).toBe(tools)
    expect(plan.extensionFactories).toHaveLength(0)
  })

  test('Given 同名自定义工具 When opt-in Then 拒绝抢占 tool_search 的宿主身份', () => {
    expect(() => preparePiMcpToolDiscovery(sdk, { enabled: true, tools: [...tools, tool('tool_search')], toolSources }))
      .toThrow('tool_search')
  })
})
