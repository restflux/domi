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

const migratedSettingsFiles = [
  'components/settings/ChannelSettings.tsx',
  'components/settings/ChannelForm.tsx',
  'components/settings/McpServerForm.tsx',
  'components/settings/ProxySettings.tsx',
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

const knownUntranslatedSettingsLiterals = [
  '模型配置',
  '添加配置',
  '确定删除渠道？',
  '代理配置',
  '启用代理',
  '系统代理（推荐）',
  '手动配置',
  '创建服务器',
  '编辑 MCP 服务器',
  '测试中...',
  '测试成功',
  '测试失败',
  '测试连接',
  '编辑模型配置',
  '添加模型配置',
  '高级设置',
  '可用模型',
  '保存并关闭',
  '放弃编辑',
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

  test('migrated settings components do not retain known product UI literals', () => {
    const source = migratedSettingsFiles
      .map((file) => readFileSync(resolve(import.meta.dir, file), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/^\s*console\.(?:error|warn|log)\(.*$/gm, '')

    for (const literal of knownUntranslatedSettingsLiterals) {
      expect(source).not.toContain(literal)
    }
  })

  test('settings batch provides English resources for core configuration pages', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('settings:modelConfigTitle')).toBe('Model configuration')
    expect(i18n.t('settings:proxyConfigTitle')).toBe('Proxy configuration')
    expect(i18n.t('settings:mcpCreate')).toBe('Create server')
    expect(i18n.t('settings:thirdPartyWarningTitle')).toBe('Use a third-party relay?')

    await i18n.changeLanguage('zh-CN')
    expect(i18n.t('settings:modelConfigTitle')).toBe('模型配置')
    expect(i18n.t('settings:mcpCreate')).toBe('创建服务器')
  })

  test('context length uses locale-aware singular and plural resources', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('chat:turns', { count: 1 })).toBe('1 turn')
    expect(i18n.t('chat:turns', { count: 2 })).toBe('2 turns')

    await i18n.changeLanguage('zh-CN')
    expect(i18n.t('chat:turns', { count: 2 })).toBe('2 轮')
  })
})
