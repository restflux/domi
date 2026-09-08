import { expect, test } from 'bun:test'
import { isSideChatReadTool, claimSideChatLaunch, registerSideChatLaunch } from './policy'

test('侧聊仅允许原生只读工具，拒绝同名 MCP、写入、委派和提权', () => {
  for (const name of ['read', 'grep', 'find', 'ls', 'Read', 'Grep', 'Glob', 'LS']) expect(isSideChatReadTool(name, 'host')).toBe(true)
  for (const name of ['bash', 'write', 'edit', 'RequestDirectWorkflow', 'delegate_agent', 'CompactContext']) expect(isSideChatReadTool(name, 'host')).toBe(false)
  for (const source of ['mcp', 'resource', 'product', undefined]) {
    for (const name of ['read', 'Read', 'Glob', 'LS']) expect(isSideChatReadTool(name, source)).toBe(false)
  }
})
test('每轮启动由宿主一次性登记，父子标识不能错配或重放', () => {
  const input = {}
  expect(claimSideChatLaunch('child', 'parent', input)).toBe(false)
  const release = registerSideChatLaunch('child', 'parent', input)
  expect(claimSideChatLaunch('child', 'other', input)).toBe(false)
  expect(claimSideChatLaunch('child', 'parent', {})).toBe(false)
  expect(claimSideChatLaunch('child', 'parent', input)).toBe(true)
  expect(claimSideChatLaunch('child', 'parent', input)).toBe(false)
  release()
})
