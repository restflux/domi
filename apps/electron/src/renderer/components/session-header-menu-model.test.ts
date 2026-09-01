import { describe, expect, test } from 'bun:test'
import {
  buildAgentSessionHeaderMenu,
  buildChatSessionHeaderMenu,
} from './session-header-menu-model.ts'

describe('session header menu model', () => {
  test('Agent 会话菜单集中当前会话管理、诊断和危险操作', () => {
    const items = buildAgentSessionHeaderMenu({
      pinned: false,
      needsFollowUp: true,
      archived: false,
      canMove: true,
      canOpenProjectFolder: true,
      hasSessionPath: true,
    })

    expect(items.map((item) => item.type === 'item' ? [item.action, item.label] : ['separator'])).toEqual([
      ['pin', '置顶会话'],
      ['followUp', '取消待继续'],
      ['rename', '重命名'],
      ['archive', '归档'],
      ['separator'],
      ['move', '迁移到其他项目'],
      ['openProject', '打开项目文件夹'],
      ['copyPath', '复制会话目录'],
      ['copyId', '复制会话 ID'],
      ['separator'],
      ['delete', '删除会话'],
    ])
  })

  test('运行中的 Agent 会话隐藏迁移，并分别按项目与会话路径可用性禁用目录操作', () => {
    const items = buildAgentSessionHeaderMenu({
      pinned: true,
      needsFollowUp: false,
      archived: true,
      canMove: false,
      canOpenProjectFolder: false,
      hasSessionPath: true,
    })
    const actions = items.filter((item) => item.type === 'item')

    expect(actions.some((item) => item.action === 'move')).toBe(false)
    expect(actions.find((item) => item.action === 'pin')?.label).toBe('取消置顶')
    expect(actions.find((item) => item.action === 'archive')?.label).toBe('取消归档')
    expect(actions.find((item) => item.action === 'openProject')?.disabled).toBe(true)
    expect(actions.find((item) => item.action === 'copyPath')?.disabled).toBe(false)
  })

  test('Chat 菜单保持轻量，不暴露 Agent 专属操作', () => {
    const items = buildChatSessionHeaderMenu({ pinned: false, archived: false })
    const actions = items.filter((item) => item.type === 'item')

    expect(actions.map((item) => item.action)).toEqual([
      'pin',
      'rename',
      'archive',
      'copyId',
      'delete',
    ])
    expect(actions.some((item) => item.action === 'followUp' || item.action === 'move')).toBe(false)
  })
})
