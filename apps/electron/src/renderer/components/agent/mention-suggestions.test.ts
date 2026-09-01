import { describe, expect, test } from 'bun:test'
import type { SkillMeta, WorkspaceCapabilities } from '@domi/shared'
import { buildMcpMentionItems, buildSkillMentionItems, resolveInsertCommandToken } from './mention-suggestions'

const skills: SkillMeta[] = [
  { slug: 'workspace', name: 'workspace', description: 'local', enabled: true },
  { slug: 'global', name: 'global', description: 'external', enabled: true, origin: 'pi-global', readOnly: true },
  { slug: 'disabled', name: 'disabled', description: 'off', enabled: false },
]

const mcpServers: WorkspaceCapabilities['mcpServers'] = [
  { name: 'workspace-mcp', type: 'stdio', enabled: true, origin: 'workspace' },
  { name: 'global-mcp', type: 'http', enabled: true, origin: 'pi-global' },
  { name: 'disabled-mcp', type: 'http', enabled: false, origin: 'pi-global' },
]

describe('Slash insert 命令选择', () => {
  test('Given 用户从菜单选择 /image When 构建插入内容 Then 命令成为可识别 token 且参数区保持普通文本', () => {
    expect(resolveInsertCommandToken({
      kind: 'command',
      id: 'image',
      label: '/image',
      name: '生成图片',
      description: '输入描述后生成图片',
      group: 'domi',
      behavior: 'insert',
      insertText: '/image ',
    })).toEqual({
      id: 'image',
      label: '/image',
      trailingText: ' ',
    })
  })

  test('Given 插入文本不是标准命令前缀 When 构建插入内容 Then 回退普通文本插入', () => {
    expect(resolveInsertCommandToken({
      kind: 'command',
      id: 'custom',
      label: '/custom',
      name: '自定义',
      description: '',
      group: 'domi',
      behavior: 'insert',
      insertText: '模板内容',
    })).toBeNull()
  })
})

describe('输入框 effective capability suggestions', () => {
  test('Given Pi 会话 When 构建 Skill/MCP 建议 Then 包含已启用的外部全局能力并标注来源', () => {
    expect(buildSkillMentionItems(skills, '')).toEqual([
      { id: 'workspace', name: 'workspace', description: 'local', sourceLabel: undefined },
      { id: 'global', name: 'global', description: 'external', sourceLabel: 'Pi 全局' },
    ])
    expect(buildMcpMentionItems(mcpServers, '')).toEqual([
      { id: 'workspace-mcp', name: 'workspace-mcp', type: 'stdio' },
      { id: 'global-mcp', name: 'global-mcp', type: 'http', sourceLabel: 'Pi 全局' },
    ])
  })


})
