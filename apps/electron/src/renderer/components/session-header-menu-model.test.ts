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
      canTransfer: true,
      isDraft: true,
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

  test('现代会话将会话树和图片画廊收入更多菜单，经典菜单不增加项目', () => {
    const options = {
      pinned: false, needsFollowUp: false, archived: false, canTransfer: true,
      isDraft: false, canOpenProjectFolder: true, hasSessionPath: true,
    }
    const modern = buildAgentSessionHeaderMenu({ ...options, includeSessionTools: true })
    const classic = buildAgentSessionHeaderMenu(options)
    const actions = (entries: typeof modern) => entries.filter((entry) => entry.type === 'item').map((entry) => entry.action)
    expect(actions(modern)).toContain('sessionTree')
    expect(actions(modern)).toContain('gallery')
    expect(actions(classic)).not.toContain('sessionTree')
    expect(actions(classic)).not.toContain('gallery')
  })

  test('运行中的 Agent 会话隐藏迁移，并分别按项目与会话路径可用性禁用目录操作', () => {
    const items = buildAgentSessionHeaderMenu({
      pinned: true,
      needsFollowUp: false,
      archived: true,
      canTransfer: false,
      isDraft: false,
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

  test('Given 本机有多种打开方式 When 构建菜单 Then 打开项目文件夹展开为子菜单并保留禁用态', () => {
    const entries = buildAgentSessionHeaderMenu({
      pinned: false,
      needsFollowUp: false,
      archived: false,
      canTransfer: false,
      isDraft: false,
      canOpenProjectFolder: true,
      hasSessionPath: true,
      projectFolderOpeners: [
        { id: 'file-manager', label: '访达', kind: 'file-manager' },
        { id: 'vscode', label: 'VS Code', kind: 'editor', iconUrl: 'data:image/png;base64,vscode-icon' },
        { id: 'terminal', label: '终端', kind: 'terminal' },
      ],
    })

    const submenu = entries.find((entry) => entry.type === 'submenu')
    expect(submenu).toMatchObject({ action: 'openProject', label: '打开项目文件夹' })
    if (submenu?.type !== 'submenu') return
    expect(submenu.items.map((item) => item.id)).toEqual(['file-manager', 'vscode', 'terminal'])
    // 系统真实应用图标（iconUrl）原样透传给渲染层
    expect(submenu.items.find((item) => item.id === 'vscode')?.iconUrl).toBe('data:image/png;base64,vscode-icon')
    expect(submenu.items.find((item) => item.id === 'terminal')?.iconUrl).toBeUndefined()
    expect(submenu.disabled).toBe(false)

    // 项目根不可用时子菜单整体禁用，与旧菜单项行为一致
    const disabled = buildAgentSessionHeaderMenu({
      pinned: false,
      needsFollowUp: false,
      archived: false,
      canTransfer: false,
      isDraft: false,
      canOpenProjectFolder: false,
      hasSessionPath: true,
      projectFolderOpeners: [
        { id: 'file-manager', label: '访达' },
        { id: 'vscode', label: 'VS Code', kind: 'editor' },
      ],
    })
    const disabledSubmenu = disabled.find((entry) => entry.type === 'submenu')
    expect(disabledSubmenu?.type === 'submenu' && disabledSubmenu.disabled).toBe(true)
  })

  test('Given 只有一种或探测失败的打开方式 When 构建菜单 Then 回退为普通菜单项', () => {
    const single = buildAgentSessionHeaderMenu({
      pinned: false,
      needsFollowUp: false,
      archived: false,
      canTransfer: false,
      isDraft: false,
      canOpenProjectFolder: true,
      hasSessionPath: true,
      projectFolderOpeners: [{ id: 'file-manager', label: '访达', kind: 'file-manager' }],
    })
    expect(single.some((entry) => entry.type === 'submenu')).toBe(false)
    expect(single.find((entry) => entry.type === 'item' && entry.action === 'openProject')).toMatchObject({
      label: '打开项目文件夹',
      disabled: false,
    })
  })

  test('已绑定会话只显示统一的交接到新会话入口', () => {
    const items = buildAgentSessionHeaderMenu({
      pinned: false,
      needsFollowUp: false,
      archived: false,
      canTransfer: true,
      isDraft: false,
      canOpenProjectFolder: true,
      hasSessionPath: true,
    })
    const actions = items.filter((item) => item.type === 'item')

    expect(actions.find((item) => item.action === 'move')?.label).toBe('交接到新会话')
    expect(actions.map((item) => item.action)).not.toContain('copyHandoff')
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
