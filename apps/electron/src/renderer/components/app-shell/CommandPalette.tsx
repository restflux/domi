/**
 * CommandPalette - 命令面板
 *
 * 默认 Cmd/Ctrl+P 唤起（快捷键 id: command-palette，注册于 GlobalShortcuts）。
 * 聚合常用操作、会话切换（Chat + Work 最近会话）与主题切换；
 * 搜索过滤与键盘导航由 cmdk 提供。执行命令后自动关闭面板。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  Bot,
  Check,
  Keyboard,
  Layers,
  ListTodo,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { commandPaletteOpenAtom } from '@/atoms/command-palette'
import { conversationsAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom, resolveToggledConversationMode } from '@/atoms/app-mode'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { shortcutGuideOpenAtom } from '@/atoms/shortcut-guide'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import {
  applyInterfaceVariantToDOM,
  interfaceVariantAtom,
  themeModeAtom,
  themeStyleAtom,
  updateInterfaceVariant,
  updateThemeMode,
  updateThemeStyle,
} from '@/atoms/theme'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import type { InterfaceVariant, ThemeMode, ThemeStyle } from '../../../types'

/** 命令面板中列出的最近会话数量上限 */
const MAX_SESSION_ITEMS = 8

/** 特殊主题显示名（与 AppearanceSettings 的 SPECIAL_STYLES 保持一致） */
const SPECIAL_THEME_LABELS: Record<Exclude<ThemeStyle, 'default'>, string> = {
  'ocean-light': '晴空碧海',
  'ocean-dark': '远山暮霭',
  'forest-light': '森息晨光',
  'forest-dark': '森息夜语',
  'slate-light': '云朵舞者',
  'slate-dark': '莫兰迪夜',
  'ember-dark': '石墨余烬',
  'blossom-mist-light': '桃岚映水',
  'cloud-citadel-light': '云阙新霁',
  'terminal-dark': '旧屏微光',
}

/** 基础主题模式选项 */
const BASE_THEME_MODES: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'light', label: '浅色主题' },
  { mode: 'dark', label: '深色主题' },
  { mode: 'system', label: '跟随系统主题' },
]

export function CommandPalette(): React.ReactElement {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom)
  const store = useStore()
  const conversations = useAtomValue(conversationsAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const appMode = useAtomValue(appModeAtom)
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSearchOpen = useSetAtom(searchDialogOpenAtom)
  const setShortcutGuideOpen = useSetAtom(shortcutGuideOpenAtom)
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom)
  const openSession = useOpenSession()
  const { createChat, createAgent } = useCreateSession()

  /** 关闭面板后执行命令 */
  const run = React.useCallback((action: () => void): void => {
    setOpen(false)
    action()
  }, [setOpen])

  /** 应用基础主题模式（浅色 / 深色 / 跟随系统），语义与 AppearanceSettings 一致 */
  const applyBaseTheme = React.useCallback((mode: ThemeMode): void => {
    store.set(themeModeAtom, mode)
    store.set(themeStyleAtom, 'default')
    void updateThemeMode(mode)
    void updateThemeStyle('default')
  }, [store])

  /** 应用特殊主题 */
  const applySpecialTheme = React.useCallback((style: Exclude<ThemeStyle, 'default'>): void => {
    store.set(themeModeAtom, 'special')
    store.set(themeStyleAtom, style)
    void updateThemeMode('special')
    void updateThemeStyle(style)
  }, [store])

  /** 切换界面形态（经典 / 现代） */
  const toggleInterfaceVariant = React.useCallback((): void => {
    const next: InterfaceVariant = interfaceVariant === 'classic' ? 'modern' : 'classic'
    store.set(interfaceVariantAtom, next)
    void updateInterfaceVariant(next)
    applyInterfaceVariantToDOM(next)
  }, [store, interfaceVariant])

  const recentConversations = React.useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSION_ITEMS),
    [conversations],
  )
  const recentAgentSessions = React.useMemo(
    () => [...agentSessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSION_ITEMS),
    [agentSessions],
  )

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="搜索会话，或输入命令…" />
      <CommandList>
        <CommandEmpty>没有匹配的会话或命令</CommandEmpty>

        <CommandGroup heading="操作">
          <CommandItem onSelect={() => run(() => { void createChat({ draft: true }) })}>
            <Plus />
            新建 Chat 对话
          </CommandItem>
          <CommandItem onSelect={() => run(() => { void createAgent({ draft: true }) })}>
            <Bot />
            新建 Work 会话
          </CommandItem>
          <CommandItem
            onSelect={() => run(() => {
              store.set(appModeAtom, resolveToggledConversationMode(appMode))
            })}
          >
            <MessageSquare />
            切换 Chat / Work 模式
          </CommandItem>
          <CommandItem onSelect={() => run(() => setSearchOpen(true))}>
            <Search />
            全局搜索
          </CommandItem>
          <CommandItem onSelect={() => run(() => setSettingsOpen(true))}>
            <Settings />
            打开设置
          </CommandItem>
          <CommandItem onSelect={() => run(() => setShortcutGuideOpen(true))}>
            <Keyboard />
            快捷键指南
          </CommandItem>
          <CommandItem onSelect={() => run(() => setSidebarCollapsed(!sidebarCollapsed))}>
            <PanelLeft />
            {sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏'}
          </CommandItem>
          <CommandItem onSelect={() => run(() => { void window.electronAPI.openPlanningWindow() })}>
            <ListTodo />
            打开任务 / 日程窗口
          </CommandItem>
          <CommandItem onSelect={() => run(toggleInterfaceVariant)}>
            <Layers />
            切换界面形态（{interfaceVariant === 'classic' ? '经典 → 现代' : '现代 → 经典'}）
          </CommandItem>
        </CommandGroup>

        {recentConversations.length > 0 && (
          <CommandGroup heading="Chat 对话">
            {recentConversations.map((conversation) => (
              <CommandItem
                key={conversation.id}
                value={`${conversation.title || '未命名对话'} · ${conversation.id}`}
                onSelect={() => run(() => openSession('chat', conversation.id, conversation.title || '未命名对话'))}
              >
                <MessageSquare />
                <span className="truncate">{conversation.title || '未命名对话'}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {recentAgentSessions.length > 0 && (
          <CommandGroup heading="Work 会话">
            {recentAgentSessions.map((session) => (
              <CommandItem
                key={session.id}
                value={`${session.title || '未命名会话'} · ${session.id}`}
                onSelect={() => run(() => openSession('agent', session.id, session.title || '未命名会话'))}
              >
                <Bot />
                <span className="truncate">{session.title || '未命名会话'}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="主题">
          {BASE_THEME_MODES.map(({ mode, label }) => (
            <CommandItem key={mode} onSelect={() => run(() => applyBaseTheme(mode))}>
              {mode === 'light' ? <Sun /> : mode === 'dark' ? <Moon /> : <Monitor />}
              <span>{label}</span>
              {themeMode === mode && themeStyle === 'default' && (
                <Check className="ml-auto text-primary" />
              )}
            </CommandItem>
          ))}
          {(Object.keys(SPECIAL_THEME_LABELS) as Array<Exclude<ThemeStyle, 'default'>>).map((style) => (
            <CommandItem key={style} onSelect={() => run(() => applySpecialTheme(style))}>
              <Palette />
              <span>{SPECIAL_THEME_LABELS[style]}</span>
              {themeMode === 'special' && themeStyle === style && (
                <Check className="ml-auto text-primary" />
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
