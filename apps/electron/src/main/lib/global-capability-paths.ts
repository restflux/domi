import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 用户显式开启外部全局能力后使用的只读路径。
 * 这里只解析路径，不创建目录，也不修改其他 Agent 工具的配置。
 */
export function resolvePiGlobalSkillsDir(): string {
  return join(homedir(), '.pi', 'agent', 'skills')
}

export function resolveAgentSkillsGlobalDir(): string {
  return join(homedir(), '.agents', 'skills')
}

export function resolveClaudeGlobalSkillsDir(): string {
  return join(homedir(), '.claude', 'skills')
}

export function resolvePiGlobalMcpPath(): string {
  return join(homedir(), '.pi', 'agent', 'mcp.json')
}
