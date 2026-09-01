import { describe, expect, test } from 'bun:test'
import {
  isLinkedImageToolId,
  refreshChatToolsForLinkedBuiltinMcp,
  updateChatToolWithLinkedCapabilities,
} from './linked-image-tool-ui-sync'

describe('linked image tool UI synchronization', () => {
  test.each(['gpt-image', 'nano-banana'] as const)('%s 写入成功后刷新 Agent 能力版本', async (toolId) => {
    let version = 4
    const writes: Array<{ toolId: string; enabled: boolean }> = []

    await updateChatToolWithLinkedCapabilities({
      toolId,
      enabled: true,
      updateToolState: async (id, state) => { writes.push({ toolId: id, enabled: state.enabled }) },
      updateCapabilityVersion: (update) => { version = update(version) },
    })

    expect(writes).toEqual([{ toolId, enabled: true }])
    expect(version).toBe(5)
    expect(isLinkedImageToolId(toolId)).toBe(true)
  })

  test('Chat 工具写入失败时不刷新 Agent 能力版本', async () => {
    let version = 4

    await expect(updateChatToolWithLinkedCapabilities({
      toolId: 'gpt-image',
      enabled: true,
      updateToolState: async () => { throw new Error('write failed') },
      updateCapabilityVersion: (update) => { version = update(version) },
    })).rejects.toThrow('write failed')

    expect(version).toBe(4)
  })

  test('非生图 Chat 工具不触发 Agent 能力刷新', async () => {
    let version = 7

    await updateChatToolWithLinkedCapabilities({
      toolId: 'web-search',
      enabled: true,
      updateToolState: async () => undefined,
      updateCapabilityVersion: (update) => { version = update(version) },
    })

    expect(version).toBe(7)
    expect(isLinkedImageToolId('web-search')).toBe(false)
  })

  test('从 Agent MCP 入口切换生图工具后刷新 Chat 工具状态', async () => {
    let visibleTools: string[] = []

    const refreshed = await refreshChatToolsForLinkedBuiltinMcp({
      toolId: 'gpt-image',
      loadChatTools: async () => ['gpt-image:on'],
      setChatTools: (tools) => { visibleTools = tools },
    })

    expect(refreshed).toBe(true)
    expect(visibleTools).toEqual(['gpt-image:on'])
  })

  test('非生图 MCP 不额外读取 Chat 工具', async () => {
    let loads = 0

    const refreshed = await refreshChatToolsForLinkedBuiltinMcp({
      toolId: 'automation',
      loadChatTools: async () => {
        loads += 1
        return []
      },
      setChatTools: () => undefined,
    })

    expect(refreshed).toBe(false)
    expect(loads).toBe(0)
  })
})
