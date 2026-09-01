import { describe, expect, test } from 'bun:test'
import { buildPiMcpToolName, buildPiMcpTools, getPiMcpStartupTimeoutMs } from './pi-mcp-tools'

describe('Pi MCP 安全边界', () => {
  test('Given 外部服务器和工具名含分隔符 When 规范化 Then 可与 Domi 产品工具保留名精确碰撞检测', () => {
    expect(buildPiMcpToolName('planning', 'create-todo')).toBe('mcp__planning__create_todo')
    expect(buildPiMcpToolName('plan-ning', 'create__todo')).toBe('mcp__plan_ning__create_todo')
  })

  test('Given 没有 MCP 服务器 When 构建工具 Then 工具和能力元数据都为空', async () => {
    expect(await buildPiMcpTools({})).toEqual({ tools: [], toolAnnotations: {} })
  })

  test('Given 外部 MCP 配置超长启动超时 When 解析 Then 宿主硬上限为 60 秒', () => {
    expect(getPiMcpStartupTimeoutMs({ startup_timeout_sec: 1e12 })).toBe(60_000)
    expect(getPiMcpStartupTimeoutMs({ timeout: 45 })).toBe(45_000)
    expect(getPiMcpStartupTimeoutMs({ timeout: -1 })).toBe(30_000)
  })
})
