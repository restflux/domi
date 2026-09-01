import { describe, expect, test } from 'bun:test'
import { registerBuiltinImageSlashCommand } from './builtin-image'
import { getSlashCommand, resolveSlashMenuItems } from './registry'
import type { SlashCommandContext } from './types'

const ctx: SlashCommandContext = {
  sessionId: 'session-image-command',
  getState: <T>() => undefined as T,
  workspaceSlug: 'domi',
  isStreaming: false,
}

describe('内置 /image 生图快捷命令', () => {
  registerBuiltinImageSlashCommand()

  test('Given 打开命令菜单 When 搜索生图 Then 展示 /image 并插入待补充的命令文本', () => {
    const items = resolveSlashMenuItems('生图', { skills: [], ctx })

    expect(items).toContainEqual(expect.objectContaining({
      kind: 'command',
      id: 'image',
      label: '/image',
      name: '生成图片',
      group: 'domi',
      behavior: 'insert',
      insertText: '/image ',
    }))
  })

  test.each(['img', 'draw'])('Given 用户输入别名 /%s When 解析命令 Then 指向 /image', (alias) => {
    expect(getSlashCommand(alias)?.id).toBe('image')
  })
})
