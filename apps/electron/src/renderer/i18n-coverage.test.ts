import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18n from './i18n'

const migratedChatFiles = [
  'components/SessionHeaderMenu.tsx',
  'components/chat/AgentRecommendBanner.tsx',
  'components/chat/ChatHeader.tsx',
  'components/chat/ChatInput.tsx',
  'components/chat/ChatMessageItem.tsx',
  'components/chat/ClearContextButton.tsx',
  'components/chat/ContextSettingsPopover.tsx',
  'components/chat/CopyButton.tsx',
  'components/chat/DeleteMessageDialog.tsx',
  'components/chat/InlineEditForm.tsx',
  'components/chat/MigrateToAgentButton.tsx',
  'components/chat/ModelSelector.tsx',
  'components/chat/PromptEditorSidebar.tsx',
  'components/chat/SystemPromptSelector.tsx',
  'components/chat/ToolSelectorPopover.tsx',
  'components/right-workspace/RightWorkspaceHeader.tsx',
  'components/right-workspace/RightWorkspaceToolbar.tsx',
] as const

const knownUntranslatedUiLiterals = [
  '重命名失败',
  '输入消息...',
  '选择模型',
  '确认删除',
  '删除后无法恢复。',
  '编辑消息...',
  '推荐使用 Work 模式',
  '正在加载',
  '恢复分栏',
  '展开到主区域',
  '添加工具',
]

describe('Chat UI i18n coverage', () => {
  test('migrated Chat components do not retain known product UI literals', () => {
    const source = migratedChatFiles
      .map((file) => readFileSync(resolve(import.meta.dir, file), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

    for (const literal of knownUntranslatedUiLiterals) {
      expect(source).not.toContain(literal)
    }
  })

  test('context length uses locale-aware singular and plural resources', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('chat:turns', { count: 1 })).toBe('1 turn')
    expect(i18n.t('chat:turns', { count: 2 })).toBe('2 turns')

    await i18n.changeLanguage('zh-CN')
    expect(i18n.t('chat:turns', { count: 2 })).toBe('2 轮')
  })
})
