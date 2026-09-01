import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const chatStates = new Map<string, boolean>()
const builtinStates = new Map<string, boolean>()
const chatWrites: Array<{ id: string; enabled: boolean }> = []
const builtinWrites: Array<{ id: string; enabled: boolean }> = []

mock.module('./chat-tool-config', () => ({
  getToolState: (id: string) => ({ enabled: chatStates.get(id) ?? false }),
  updateToolState: (id: string, state: { enabled: boolean }) => {
    chatStates.set(id, state.enabled)
    chatWrites.push({ id, enabled: state.enabled })
  },
}))

mock.module('./builtin-mcp/settings', () => ({
  isBuiltinMcpUserEnabled: (id: string) => builtinStates.get(id) ?? false,
  setBuiltinMcpUserEnabled: (id: string, enabled: boolean) => {
    builtinStates.set(id, enabled)
    builtinWrites.push({ id, enabled })
  },
}))

let state: typeof import('./linked-image-tool-state')

beforeAll(async () => {
  state = await import('./linked-image-tool-state')
})

beforeEach(() => {
  chatStates.clear()
  builtinStates.clear()
  chatWrites.length = 0
  builtinWrites.length = 0
})

describe('生图工具 Chat / Agent 开关联动', () => {
  test('从 AI 工具入口切换时同步 Agent MCP，关闭时也保持一致', () => {
    state.updateLinkedChatToolState('gpt-image', { enabled: true })
    expect(chatStates.get('gpt-image')).toBe(true)
    expect(builtinStates.get('gpt-image')).toBe(true)

    state.updateLinkedChatToolState('gpt-image', { enabled: false })
    expect(chatStates.get('gpt-image')).toBe(false)
    expect(builtinStates.get('gpt-image')).toBe(false)
  })

  test('从 Agent MCP 入口切换时同步 AI 工具，关闭时也保持一致', () => {
    state.updateLinkedBuiltinMcpState('nano-banana', true)
    expect(builtinStates.get('nano-banana')).toBe(true)
    expect(chatStates.get('nano-banana')).toBe(true)

    state.updateLinkedBuiltinMcpState('nano-banana', false)
    expect(builtinStates.get('nano-banana')).toBe(false)
    expect(chatStates.get('nano-banana')).toBe(false)
  })

  test('升级迁移保留任一侧已经开启的生图能力并补齐另一侧', () => {
    chatStates.set('gpt-image', true)
    builtinStates.set('nano-banana', true)

    state.reconcileLinkedImageToolStates()

    expect(chatStates.get('gpt-image')).toBe(true)
    expect(builtinStates.get('gpt-image')).toBe(true)
    expect(chatStates.get('nano-banana')).toBe(true)
    expect(builtinStates.get('nano-banana')).toBe(true)
    expect(chatWrites).toEqual([{ id: 'nano-banana', enabled: true }])
    expect(builtinWrites).toEqual([{ id: 'gpt-image', enabled: true }])
  })

  test('Agent 注入读取对旧版不一致配置采用 union，非生图 MCP 保持原语义', () => {
    chatStates.set('gpt-image', true)
    builtinStates.set('automation', true)

    expect(state.isBuiltinMcpEnabledForAgent('gpt-image')).toBe(true)
    expect(state.isBuiltinMcpEnabledForAgent('nano-banana')).toBe(false)
    expect(state.isBuiltinMcpEnabledForAgent('automation')).toBe(true)
  })

  test('非生图工具不产生跨配置写入', () => {
    state.updateLinkedChatToolState('web-search', { enabled: true })
    state.updateLinkedBuiltinMcpState('automation', true)

    expect(chatWrites).toEqual([{ id: 'web-search', enabled: true }])
    expect(builtinWrites).toEqual([{ id: 'automation', enabled: true }])
  })
})
