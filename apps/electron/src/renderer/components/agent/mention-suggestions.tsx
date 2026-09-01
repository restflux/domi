/**
 * MentionSuggestions — Skill / MCP 的 TipTap Mention Suggestion 统一配置
 *
 * 泛型工厂 createMentionSuggestion 封装公共逻辑（渲染、定位、键盘导航），
 * 通过 MentionSuggestionConfig 注入差异部分（触发字符、数据获取、行渲染）。
 */

import type React from 'react'
import { ReactRenderer, type Editor } from '@tiptap/react'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { CalendarDays, Command, ListTodo, MessageSquareText, Sparkles, Server } from 'lucide-react'
import { MentionList } from './MentionList'
import type { MentionListRef } from './MentionList'
import { createLatestSuggestionRequestGuard, createMentionPopup, positionPopup, isSuggestionTriggerPresent, shouldSuppressEscTrigger, shouldClearEscSuppressionOnExit, type EscSuppressedTrigger } from './mention-popup-utils'
import type { AgentSessionReferenceSearchResult, SkillMeta, WorkspaceCapabilities } from '@domi/shared'
import { shouldAllowMentionTrigger, shouldShowMentionSuggestion } from '@/components/ai-elements/mention-utils'
import {
  buildPlanningReferenceItems,
  filterPlanningReferenceItems,
  getPlanningReferenceRange,
  type PlanningReferenceMenuItem,
  type PlanningReferenceType,
} from './planning-reference-state'
import { resolveSlashMenuItems, slashMenuGroupLabel, type SlashSkillEntry, type SlashMenuItem } from '@/lib/slash-commands/registry'
import type { SlashCommandContext } from '@/lib/slash-commands/types'

// ===== 泛型工厂 =====

interface MentionSuggestionConfig<T> {
  /** 触发字符 */
  char: string
  /** 标题栏左侧标签（面板类型） */
  headerLabel: string
  /** 空列表占位文字 */
  emptyText: string
  /** 异步获取列表项 */
  fetchItems: (slug: string, query: string) => Promise<T[]>
  /** 无需工作区上下文的全局引用（会话、规划）可跳过 context 校验。 */
  requiresContext?: boolean
  /** 提取唯一 key */
  keyExtractor: (item: T) => string
  /** 渲染列表项 */
  renderItem: (item: T) => React.ReactNode
  /** 连续相同标签合并为一个分组标题。 */
  groupLabel?: (item: T) => string | undefined
  /** 选中后传给 command 的 Mention 属性 */
  toCommand: (item: T) => { id: string; label: string; referenceType?: PlanningReferenceType }
  /**
   * 选中项时优先调用。返回 true 表示已处理（不再插入 mention 节点），
   * 用于 Slash 命令等非 Skill/MCP 引用类条目。
   * range 为触发符所在范围，命令处理时需要先删除已输入的触发文本。
   */
  onItemSelected?: (item: T, editor: Editor, range: { from: number; to: number }) => boolean
}

function createMentionSuggestion<T>(
  config: MentionSuggestionConfig<T>,
  workspaceSlugRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
): Omit<SuggestionOptions<T>, 'editor'> {
  // Esc 抑制：记录被 Esc 关闭的触发片段文本。
  // TipTap suggestion 按 Esc 后会 dispatchExit 置 inactive，但触发符仍在文档中，
  // 继续输入会再次 onStart 弹窗；这里在 onStart 时对同一片段跳过建弹窗，
  // 直到用户重新触发（片段结束或内容变化）才恢复正常。
  // 用文本而非位置判断：删除触发符前的字符导致位置移动时，片段仍延续，继续抑制。
  let suppressedTrigger: EscSuppressedTrigger | null = null
  const requestGuard = createLatestSuggestionRequestGuard<T>()

  return {
    char: config.char,
    allowSpaces: false,
    // allowedPrefixes 为 null：允许任意字符前缀触发（含中文等无空格场景，如 `你好#`）。
    // 注意：设为 [' '] 不能阻止"空输入框触发"——TipTap 在块开头的前缀为空串，
    // 始终通过校验；却会让中文/单词后紧跟触发符无法触发，属回归。
    allowedPrefixes: null,
    shouldShow: ({ transaction }) => shouldShowMentionSuggestion(transaction.getMeta('uiEvent')),
    allow: ({ state, range }) => {
      const $trigger = state.doc.resolve(range.from)
      const paragraphStart = $trigger.start()
      const paragraphEnd = $trigger.end()
      const paragraphText = state.doc.textBetween(paragraphStart, paragraphEnd, '\n', '\n')
      const isCodeContext = $trigger.parent.type.name === 'codeBlock'
        || $trigger.marks().some((mark) => mark.type.name === 'code')

      return shouldAllowMentionTrigger({
        paragraphText,
        triggerOffset: range.from - paragraphStart,
        trigger: config.char,
        isCodeContext,
      })
    },

    items: async ({ query }): Promise<T[]> => {
      const requestId = requestGuard.startRequest()
      const slug = workspaceSlugRef.current
      if (config.requiresContext !== false && !slug) return requestGuard.attachResult(requestId, [])
      try {
        return requestGuard.attachResult(
          requestId,
          await config.fetchItems(slug ?? '', (query ?? '').toLowerCase()),
        )
      } catch {
        return requestGuard.attachResult(requestId, [])
      }
    },

    render: () => {
      let renderer: ReactRenderer<MentionListRef> | null = null
      let popup: HTMLDivElement | null = null
      let blurHandler: (() => void) | null = null
      let editorDom: HTMLElement | null = null

      function cleanup() {
        if (blurHandler && editorDom) {
          editorDom.removeEventListener('blur', blurHandler, true)
          blurHandler = null
        }
        editorDom = null
        mentionActiveRef.current = false
        mentionItemCountRef.current = 0
        popup?.remove()
        popup = null
        renderer?.destroy()
        renderer = null
      }

      return {
        onStart(props) {
          if (!requestGuard.isLatest(props.items)) {
            return
          }
          if (popup || renderer) {
            cleanup()
          }

          // 防御异步竞态：await items() 期间触发符可能已被删除导致 suggestion 退出，
          // 插件仍会用过期 props 调用 onStart；过期则跳过建弹窗，避免残留幽灵弹窗。
          if (!isSuggestionTriggerPresent(props.editor, props.range, config.char)) {
            return
          }

          // Esc 抑制：同一触发片段（位置未后移且文本延续）不再弹窗，保持抑制；
          // 用户重新输入触发符（位置后移）、片段已结束或内容变化时清除抑制并正常弹窗。
          if (shouldSuppressEscTrigger(suppressedTrigger, { from: props.range.from, text: props.text })) {
            return
          }
          suppressedTrigger = null

          mentionActiveRef.current = true
          mentionItemCountRef.current = props.items.length
          editorDom = props.editor.view.dom
          renderer = new ReactRenderer(MentionList, {
            props: {
              items: props.items,
              emptyText: config.emptyText,
              headerLabel: config.headerLabel,
              keyExtractor: config.keyExtractor,
              renderItem: config.renderItem,
              groupLabel: config.groupLabel,
              onSelect: (item: T) => {
                if (config.onItemSelected?.(item, props.editor, props.range)) return
                const cmd = config.toCommand(item)
                props.command({ ...cmd, mentionSuggestionChar: config.char })
              },
            },
            editor: props.editor,
          })
          popup = createMentionPopup(renderer.element)
          positionPopup(popup, props.clientRect?.())

          blurHandler = () => {
            setTimeout(() => {
              if (!props.editor.view.hasFocus() && popup) {
                cleanup()
              }
            }, 100)
          }
          editorDom.addEventListener('blur', blurHandler, true)
        },

        onUpdate(props) {
          // 仅允许最新异步请求更新弹窗。
          if (!requestGuard.isLatest(props.items)) {
            return
          }
          mentionItemCountRef.current = props.items.length
          renderer?.updateProps({
            items: props.items,
            onSelect: (item: T) => {
              if (config.onItemSelected?.(item, props.editor, props.range)) return
              const cmd = config.toCommand(item)
              props.command({ ...cmd, mentionSuggestionChar: config.char })
            },
          })
          positionPopup(popup, props.clientRect?.())
        },

        onKeyDown(props) {
          // 记录 Esc 关闭时的触发片段文本与位置，onStart/onExit 据此判断同一片段
          if (props.event.key === 'Escape') {
            suppressedTrigger = {
              from: props.range.from,
              text: props.view.state.doc.textBetween(props.range.from, props.range.to, '', ''),
            }
          }
          return renderer?.ref?.onKeyDown({ event: props.event }) ?? false
        },

        onExit(props) {
          // TipTap 会在 await items() 后才调用 onExit；旧请求不能清理新弹窗。
          if (requestGuard.isStale(props.items)) {
            return
          }
          // 被抑制的触发符已从文档中删除 → 清除抑制，让用户重新输入触发符时恢复正常弹窗
          if (suppressedTrigger && shouldClearEscSuppressionOnExit(suppressedTrigger, props.editor, props.range, config.char)) {
            suppressedTrigger = null
          }
          cleanup()
        },
      }
    },
  }
}

// ===== Skill 配置 =====

export interface SkillMentionItem {
  id: string
  name: string
  description?: string
  sourceLabel?: string
}

function globalSkillSourceLabel(skill: SkillMeta): string | undefined {
  if (skill.origin === 'pi-global') return 'Pi 全局'
  if (skill.origin === 'agents-global') return 'Agent 全局'
  if (skill.origin === 'claude-global') return 'Claude 全局'
  return undefined
}

export function buildSkillMentionItems(skills: SkillMeta[], query: string): SkillMentionItem[] {
  const q = query.toLowerCase()
  return skills
    .filter((skill) => skill.enabled)
    .filter((skill) => !q || skill.name.toLowerCase().includes(q) || skill.slug.toLowerCase().includes(q))
    .map((skill) => ({
      id: skill.slug,
      name: skill.name,
      description: skill.description,
      sourceLabel: globalSkillSourceLabel(skill),
    }))
}

export function createSkillMentionSuggestion(
  workspaceSlugRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
) {
  return createMentionSuggestion<SkillMentionItem>(
    {
      char: '/',
      headerLabel: '调用 skill',
      emptyText: '无匹配 Skill',
      fetchItems: async (slug, q) => {
        const caps = await window.electronAPI.getWorkspaceCapabilities(slug)
        return buildSkillMentionItems(caps.skills, q)
      },
      keyExtractor: (item) => item.id,
      renderItem: (item) => (
        <>
          <Sparkles className="size-3.5 text-violet-500 flex-shrink-0" />
          <span className="truncate font-medium flex-1 min-w-0">{item.name}</span>
          {item.sourceLabel ? (
            <span className="shrink-0 text-[10px] text-violet-500/70">{item.sourceLabel}</span>
          ) : item.description ? (
            <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">{item.description}</span>
          ) : null}
        </>
      ),
      toCommand: (item) => ({ id: item.id, label: item.name }),
    },
    workspaceSlugRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

// ===== Slash 命令 + Skill 菜单 =====

/** 菜单层需要的 Skill 条目（来自 workspace capabilities，过滤 enabled）。 */
export function buildSlashSkillEntries(skills: SkillMeta[]): SlashSkillEntry[] {
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      id: skill.slug,
      name: skill.name,
      description: skill.description,
      sourceLabel: globalSkillSourceLabel(skill),
    }))
}

export interface SlashMenuDeps {
  /** 命令选中回调（execute / picker）。args 为命令剩余参数（当前为空）。 */
  onExecuteCommand: (commandId: string, args: string[]) => void
}

export interface InsertCommandToken {
  id: string
  label: string
  trailingText: string
}

/**
 * 把 insert 命令拆成不可混淆的命令 token 与后续普通文本。
 * 仅处理以菜单展示命令开头的标准 insertText，异常配置继续回退为普通文本。
 */
export function resolveInsertCommandToken(item: SlashMenuItem): InsertCommandToken | null {
  if (item.kind !== 'command' || item.behavior !== 'insert' || !item.insertText) return null
  if (!item.insertText.startsWith(item.label)) return null

  const trailingText = item.insertText.slice(item.label.length)
  if (trailingText && !/^\s/.test(trailingText)) return null
  return { id: item.id, label: item.label, trailingText }
}

/**
 * `/` 菜单：系统命令（会话控制 / Domi 分组）在前，Skill 在后；
 * 命令优先于同名 Skill。命令选中后先删除触发符，再执行或填入输入框；
 * Skill 选中后走现有 mention 节点插入路径。
 */
export function createSlashMenuSuggestion(
  workspaceSlugRef: React.RefObject<string | null>,
  currentSessionIdRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
  deps: SlashMenuDeps,
) {
  return createMentionSuggestion<SlashMenuItem>(
    {
      char: '/',
      headerLabel: '命令与 Skill',
      emptyText: '无匹配命令或 Skill',
      fetchItems: async (slug, q) => {
        const caps = await window.electronAPI.getWorkspaceCapabilities(slug)
        const ctx: SlashCommandContext = {
          sessionId: currentSessionIdRef.current ?? '',
          // 菜单仅做可用性判断（isAvailable），不读 atom；后续如需流式感知再注入。
          getState: <T,>() => undefined as T,
          workspaceSlug: slug,
          isStreaming: false,
        }
        return resolveSlashMenuItems(q, { skills: buildSlashSkillEntries(caps.skills), ctx })
      },
      keyExtractor: (item) => `${item.kind}:${item.id}`,
      renderItem: (item) => (
        item.kind === 'command'
          ? (
            <>
              <Command className="size-3.5 text-primary flex-shrink-0" />
              <span className="truncate font-medium flex-1 min-w-0">{item.label}</span>
              <span className="shrink-0 truncate text-[10px] text-muted-foreground/60 max-w-[120px]">{item.name}</span>
            </>
          )
          : (
            <>
              <Sparkles className="size-3.5 text-violet-500 flex-shrink-0" />
              <span className="truncate font-medium flex-1 min-w-0">{item.name}</span>
              <span className="shrink-0 text-[10px] text-violet-500/70">{item.sourceLabel ?? 'Skill'}</span>
            </>
          )
      ),
      groupLabel: slashMenuGroupLabel,
      toCommand: (item) => ({ id: item.id, label: item.kind === 'skill' ? item.name : item.label }),
      onItemSelected: (item, editor, range) => {
        if (item.kind === 'skill') return false
        // 删除已输入的触发符（如 /compact 前面的斜杠与已打出的前缀）
        editor.chain().focus().deleteRange(range).run()
        if (item.behavior === 'insert' && item.insertText) {
          const token = resolveInsertCommandToken(item)
          if (!token) {
            editor.chain().focus().insertContent(item.insertText).run()
            return true
          }
          editor.chain()
            .focus()
            .insertContent({
              type: 'mention',
              attrs: {
                id: token.id,
                label: token.label,
                mentionSuggestionChar: '/',
                commandMenuMention: true,
              },
            })
            .insertContent(token.trailingText)
            .run()
          return true
        }
        deps.onExecuteCommand(item.id, [])
        return true
      },
    },
    workspaceSlugRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

// ===== MCP 配置 =====

export interface McpMentionItem {
  id: string
  name: string
  type: string
  sourceLabel?: string
}

export function buildMcpMentionItems(
  servers: WorkspaceCapabilities['mcpServers'],
  query: string,
): McpMentionItem[] {
  const q = query.toLowerCase()
  return servers
    .filter((server) => server.enabled)
    .filter((server) => !q || server.name.toLowerCase().includes(q))
    .map((server) => ({
      id: server.name,
      name: server.name,
      type: server.type,
      ...(server.origin === 'pi-global' && { sourceLabel: 'Pi 全局' }),
    }))
}

export function createMcpMentionSuggestion(
  workspaceSlugRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
) {
  return createMentionSuggestion<McpMentionItem>(
    {
      char: '#',
      headerLabel: 'MCP 服务',
      emptyText: '无匹配 MCP 服务',
      fetchItems: async (slug, q) => {
        const caps = await window.electronAPI.getWorkspaceCapabilities(slug)
        return buildMcpMentionItems(caps.mcpServers, q)
      },
      keyExtractor: (item) => item.id,
      renderItem: (item) => (
        <>
          <Server className="size-3.5 text-emerald-500 flex-shrink-0" />
          <span className="truncate font-medium flex-1 min-w-0">{item.name}</span>
          <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">
            {item.sourceLabel ?? item.type}
          </span>
        </>
      ),
      toCommand: (item) => ({ id: item.id, label: item.name }),
    },
    workspaceSlugRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

// ===== Agent 会话引用配置 =====

export type SessionMentionItem = AgentSessionReferenceSearchResult

// 空查询只读会话索引，可安全展示更多；搜索会读取 JSONL 消息，保持较小上限避免阻塞主进程。
const RECENT_SESSION_MENTION_LIMIT = 200
const SEARCHED_SESSION_MENTION_LIMIT = 20
const PLANNING_REFERENCE_LIMIT = 100

export function createSessionMentionSuggestion(
  currentSessionIdRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
) {
  return createMentionSuggestion<SessionMentionItem>(
    {
      char: '&',
      headerLabel: '引用会话',
      emptyText: '无匹配会话',
      requiresContext: false,
      fetchItems: async (_context, q) => {
        return window.electronAPI.searchAgentSessionReferences({
          excludeSessionId: currentSessionIdRef.current ?? undefined,
          query: q,
          limit: q ? SEARCHED_SESSION_MENTION_LIMIT : RECENT_SESSION_MENTION_LIMIT,
        })
      },
      keyExtractor: (item) => item.sessionId,
      renderItem: (item) => (
        <>
          <MessageSquareText className="size-3.5 text-sky-500 flex-shrink-0" />
          <span className="truncate font-medium flex-1 min-w-0">{item.title}</span>
          {(item.workspaceName || item.workspaceSlug || item.snippet) && (
            <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">
              {formatSessionReferenceDescription(item)}
            </span>
          )}
        </>
      ),
      toCommand: (item) => ({ id: item.sessionId, label: item.title }),
    },
    currentSessionIdRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

export function createPlanningMentionSuggestion(
  trigger: '~' | '～',
  currentSessionIdRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
) {
  return createMentionSuggestion<PlanningReferenceMenuItem>(
    {
      char: trigger,
      headerLabel: '引用待办和日程',
      emptyText: '无匹配待办或日程',
      requiresContext: false,
      fetchItems: async (_context, query) => {
        const { from, toExclusive } = getPlanningReferenceRange()
        const [todos, events] = await Promise.all([
          window.electronAPI.listTodos({ status: 'open', limit: PLANNING_REFERENCE_LIMIT }),
          window.electronAPI.listCalendarEvents({ from, to: toExclusive, limit: PLANNING_REFERENCE_LIMIT }),
        ])
        return filterPlanningReferenceItems(
          buildPlanningReferenceItems(todos, events),
          query,
        )
      },
      keyExtractor: (item) => `${item.referenceType}:${item.id}`,
      renderItem: (item) => (
        <>
          {item.referenceType === 'todo'
            ? <ListTodo className="size-3.5 shrink-0 text-primary" />
            : <CalendarDays className="size-3.5 shrink-0 text-primary" />}
          <span className="truncate font-medium flex-1 min-w-0">{item.label}</span>
          <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">{item.description}</span>
        </>
      ),
      toCommand: (item) => ({
        id: item.id,
        label: item.label,
        referenceType: item.referenceType,
      }),
    },
    currentSessionIdRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

function formatSessionReferenceDescription(input: AgentSessionReferenceSearchResult): string | undefined {
  const workspace = input.workspaceName
    ? input.workspaceSlug && input.workspaceSlug !== input.workspaceName
      ? `${input.workspaceName} (${input.workspaceSlug})`
      : input.workspaceName
    : input.workspaceSlug
  const parts = [workspace ? `项目：${workspace}` : undefined, input.snippet]
    .filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(' · ') : undefined
}
