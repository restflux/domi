import { BrandLogo } from '@/components/ui/brand-logo'
/**
 * SessionMiniMapPopover — 左侧会话悬浮面板
 *
 * Agent 会话只展示元信息（Local/Worktree、交付状态、项目与分支），不读取会话内容；
 * 分支与交付状态在面板打开时才静默补齐。
 * Chat 会话仍以会话内容迷你地图为主，优先复用已打开会话写入的 tabMinimapCache，
 * 未打开时按需读取本地 JSONL。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Bot, Folder, GitBranch, Loader2, MessageSquare } from 'lucide-react'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { tabMinimapCacheAtom, type TabMinimapItem } from '@/atoms/tab-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import { inspectSessionTargetAtomFamily, sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { cn } from '@/lib/utils'
import {
  buildSessionHoverMeta,
  type SessionHoverMeta,
  type SessionHoverTargetKind,
  type SessionHoverTone,
} from './session-hover-meta'
import type { ChatMessage } from '@domi/shared'

export type { SessionHoverTargetKind } from './session-hover-meta'

export type SessionMiniMapType = 'chat' | 'agent'

export interface SessionMiniMapTarget {
  type: SessionMiniMapType
  sessionId: string
  title: string
  workspaceName?: string
  /** 会话持久化的 Session Target 意图；chat 会话不传。 */
  sessionTargetKind?: SessionHoverTargetKind
  /** 会话更新时间戳；缺失时不显示"更新于"。 */
  updatedAt?: number
}

interface UseSessionMiniMapHoverReturn {
  anchorRef: React.MutableRefObject<HTMLElement | null>
  setAnchorRef: (node: HTMLElement | null) => void
  isOpen: boolean
  isLeaving: boolean
  handleMouseEnter: () => void
  handleMouseLeave: () => void
  handlePanelMouseEnter: () => void
  handlePanelMouseLeave: () => void
  closeNow: () => void
}

interface SessionMiniMapPopoverProps {
  target: SessionMiniMapTarget
  anchorRef: React.MutableRefObject<HTMLElement | null>
  open: boolean
  isLeaving: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}

const PANEL_WIDTH = 318
/** Chat 会话仍展示消息预览，高度按可见条数计算。 */
const PANEL_MIN_HEIGHT = 132
const PANEL_MAX_HEIGHT = 420
/** Agent 会话只展示元信息：标题行 + 状态行 + 可选的位置行（项目 / 分支）。 */
const META_PANEL_BASE_HEIGHT = 56
const META_PANEL_LOCATION_HEIGHT = 20
const PANEL_GAP = 16
const VIEWPORT_MARGIN = 8
const MAX_RENDERED_ITEMS = 80
const PREVIEW_REMARK_PLUGINS = [remarkGfm]

const PREVIEW_MD_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-0">{children}</p>,
  ul: ({ children }) => <ul className="my-0 pl-3">{children}</ul>,
  ol: ({ children }) => <ol className="my-0 pl-3">{children}</ol>,
  li: ({ children }) => <li className="my-0">{children}</li>,
  pre: ({ children }) => <pre className="my-0 truncate text-[11px] opacity-70">{children}</pre>,
  code: ({ children }) => <code className="rounded bg-muted/50 px-0.5 text-[11px]">{children}</code>,
  img: () => null,
  a: ({ children }) => <span>{children}</span>,
}

export function useSessionMiniMapHover(delayMs = 600, disabled = false): UseSessionMiniMapHoverReturn {
  const anchorRef = React.useRef<HTMLElement | null>(null)
  const [isOpen, setIsOpen] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const enterTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()

  React.useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  React.useEffect(() => {
    if (!disabled) return
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsOpen(false)
    setIsLeaving(false)
  }, [disabled])

  const setAnchorRef = React.useCallback((node: HTMLElement | null): void => {
    anchorRef.current = node
  }, [])

  const closeNow = React.useCallback((): void => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsOpen(false)
    setIsLeaving(false)
  }, [])

  const handleMouseEnter = React.useCallback((): void => {
    if (disabled) return
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
    if (isOpen) return
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    enterTimerRef.current = setTimeout(() => setIsOpen(true), delayMs)
  }, [delayMs, disabled, isOpen])

  const closeWithDelay = React.useCallback((): void => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    leaveTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setIsOpen(false)
        setIsLeaving(false)
      }, 90)
    }, 160)
  }, [])

  const handlePanelMouseEnter = React.useCallback((): void => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
  }, [])

  return {
    anchorRef,
    setAnchorRef,
    isOpen,
    isLeaving,
    handleMouseEnter,
    handleMouseLeave: closeWithDelay,
    handlePanelMouseEnter,
    handlePanelMouseLeave: closeWithDelay,
    closeNow,
  }
}

function normalizePreviewText(text: string): string {
  return text
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\n*/g, '')
    .replace(/<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g, '')
    .replace(/<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildChatMinimapItems(messages: ChatMessage[], userAvatar?: string): TabMinimapItem[] {
  return messages
    .map((message) => ({
      id: message.id,
      role: message.role === 'user' ? 'user' as const : message.role === 'assistant' ? 'assistant' as const : 'status' as const,
      preview: normalizePreviewText(message.content).slice(0, 220),
      avatar: message.role === 'user' ? userAvatar : undefined,
      model: message.model,
    }))
    .filter((item) => item.preview.length > 0)
}

export function useSessionMiniMapPopoverPosition(
  anchorRef: React.MutableRefObject<HTMLElement | null>,
  open: boolean,
  preferredHeight: number,
): { top: number; left: number; height: number } | null {
  const [position, setPosition] = React.useState<{ top: number; left: number; height: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const update = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const availableHeight = Math.max(120, viewportHeight - VIEWPORT_MARGIN * 2)
      const height = Math.min(preferredHeight, availableHeight)
      let left = rect.right + PANEL_GAP
      if (left + PANEL_WIDTH > viewportWidth - VIEWPORT_MARGIN) {
        left = rect.left - PANEL_WIDTH - PANEL_GAP
      }
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN

      const preferredTop = rect.top + rect.height / 2 - height / 2
      const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN)
      const top = Math.min(Math.max(VIEWPORT_MARGIN, preferredTop), maxTop)
      setPosition({ top, left, height })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, open, preferredHeight])

  return position
}

function getPreferredPanelHeight({
  loading,
  error,
  itemCount,
}: {
  loading: boolean
  error: string | null
  itemCount: number
}): number {
  if (loading) return 260
  if (error || itemCount === 0) return PANEL_MIN_HEIGHT
  const visibleItems = Math.min(itemCount, 8)
  return Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, 54 + visibleItems * 42))
}

/** Agent 面板只承载元信息，按实际行数取高，不再为消息预览预留空间。 */
export function getMetaOnlyPanelHeight(meta: SessionHoverMeta, projectName?: string): number {
  return META_PANEL_BASE_HEIGHT + ((projectName || meta.gitLabel) ? META_PANEL_LOCATION_HEIGHT : 0)
}

function getMessageBubbleClass(item: TabMinimapItem): string {
  if (item.role === 'user') return 'bg-primary/[0.06]'
  if (item.role === 'status') return 'bg-amber-500/[0.08]'
  return ''
}

const META_CHIP_CLASS: Record<SessionHoverTone, string> = {
  neutral: 'bg-foreground/[0.06] text-muted-foreground',
  progress: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  ready: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  muted: 'bg-foreground/[0.05] text-muted-foreground/70',
}

/** 标题下方的两行元信息：目标/状态/更新时间 + 项目/分支。 */
export function SessionHoverMetaPanel({
  meta,
  projectName,
}: {
  meta: SessionHoverMeta
  projectName?: string
}): React.ReactElement {
  const chip = (tone: SessionHoverTone): string => cn(
    'shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4',
    META_CHIP_CLASS[tone],
  )

  return (
    <div data-session-hover-meta="panel" className="flex flex-col gap-1">
      <div data-session-hover-meta="status" className="flex min-w-0 items-center gap-1.5">
        <span data-session-hover-meta="target" className={chip(meta.targetTone)}>{meta.targetLabel}</span>
        {meta.statusLabel && <span className={chip(meta.statusTone)}>{meta.statusLabel}</span>}
        {meta.updatedLabel && (
          <span className="ml-auto shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground/70">
            更新于 {meta.updatedLabel}
          </span>
        )}
      </div>
      {(projectName || meta.gitLabel) && (
        <div
          data-session-hover-meta="location"
          className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground/70"
        >
          {projectName && (
            <>
              <Folder size={11} className="shrink-0 opacity-70" />
              <span className="max-w-[110px] shrink-0 truncate" title={projectName}>{projectName}</span>
            </>
          )}
          {projectName && meta.gitLabel && <span className="shrink-0 opacity-40">·</span>}
          {meta.gitLabel && (
            <>
              <GitBranch size={11} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate" title={meta.gitLabel}>{meta.gitLabel}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PreviewText({ text }: { text: string }): React.ReactElement {
  if (!text) {
    return <span className="text-[11px] text-muted-foreground/60">(空消息)</span>
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] leading-4 text-popover-foreground/72 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 prose-pre:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-2 overflow-hidden">
      <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

function ItemIcon({ item, type }: { item: TabMinimapItem; type: SessionMiniMapType }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if (item.role === 'assistant' && item.model) {
    return (
      <BrandLogo
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'assistant') {
    return <Bot className="size-4 shrink-0 mt-0.5 text-blue-500/70" />
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-muted-foreground/60" />
  }
  return type === 'chat'
    ? <MessageSquare className="size-4 shrink-0 mt-0.5 text-muted-foreground/60" />
    : <Bot className="size-4 shrink-0 mt-0.5 text-muted-foreground/60" />
}

export function SessionMiniMapPopover(props: SessionMiniMapPopoverProps): React.ReactElement | null {
  if (!props.open) return null
  return <SessionMiniMapPopoverContent {...props} />
}

function SessionMiniMapPopoverContent({
  target,
  anchorRef,
  open,
  isLeaving,
  onMouseEnter,
  onMouseLeave,
}: SessionMiniMapPopoverProps): React.ReactElement | null {
  const userProfile = useAtomValue(userProfileAtom)
  const [cache, setCache] = useAtom(tabMinimapCacheAtom)
  const cachedItems = cache.get(target.sessionId)
  const [items, setItems] = React.useState<TabMinimapItem[]>(cachedItems ?? [])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const targetState = useAtomValue(sessionTargetStateAtomFamily(target.sessionId))
  const inspectTarget = useSetAtom(inspectSessionTargetAtomFamily(target.sessionId))
  const isAgentSession = target.type === 'agent'
  // Agent 会话的悬浮面只回答"在哪跑、跑到哪一步"，不再展示会话内容。
  const showContent = !isAgentSession
  // 已有权威快照或已在检查时不再重复请求。
  const needsTargetSnapshot = isAgentSession && !targetState.snapshot && !targetState.loading
  const meta = React.useMemo(
    () => buildSessionHoverMeta({
      sessionTargetKind: target.sessionTargetKind,
      snapshot: targetState.snapshot,
      updatedAt: target.updatedAt,
    }),
    [target.sessionTargetKind, target.updatedAt, targetState.snapshot],
  )
  const preferredHeight = isAgentSession
    ? getMetaOnlyPanelHeight(meta, target.workspaceName)
    : getPreferredPanelHeight({ loading, error, itemCount: items.length })
  const position = useSessionMiniMapPopoverPosition(anchorRef, open, preferredHeight)
  const renderedItems = React.useMemo(
    () => items.length > MAX_RENDERED_ITEMS ? items.slice(-MAX_RENDERED_ITEMS) : items,
    [items],
  )

  React.useEffect(() => {
    // 分支与交付状态只有 inspect 才知道，因此放在面板打开后静默补齐：
    // 不切 loading、不覆盖已有错误，结果写入共享 atom 供输入区复用。
    if (!open || !needsTargetSnapshot) return
    void inspectTarget({ silent: true })
  }, [inspectTarget, needsTargetSnapshot, open])

  React.useEffect(() => {
    if (!open || !showContent) return
    if (cachedItems) {
      setItems(cachedItems)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])

    const load = async (): Promise<void> => {
      try {
        const nextItems = buildChatMinimapItems(
          await window.electronAPI.getConversationMessages(target.sessionId),
          userProfile.avatar,
        )
        if (cancelled) return
        setItems(nextItems)
        setCache((prev) => {
          const next = new Map(prev)
          next.set(target.sessionId, nextItems)
          return next
        })
      } catch (loadError) {
        console.error('[会话迷你地图] 加载失败:', loadError)
        if (!cancelled) setError('无法加载会话内容')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [cachedItems, open, setCache, showContent, target.sessionId, userProfile.avatar])

  if (!open || !position) return null

  return createPortal(
    <div
      className="fixed z-[9999] titlebar-no-drag transition-[top,height] duration-150 ease-out pointer-events-auto"
      style={{ top: position.top, left: position.left, width: PANEL_WIDTH, height: position.height }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        className={cn(
          'session-minimap-popover h-full rounded-xl bg-popover shadow-xl ring-1 ring-black/[0.05] dark:ring-white/[0.08] flex flex-col overflow-hidden',
          isLeaving ? 'session-minimap-popover-exit' : 'session-minimap-popover-enter',
        )}
      >
        <div className="flex flex-col gap-1.5 px-3 py-2 shrink-0 bg-muted/35 border-b border-border/35">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-popover-foreground/85" title={target.title}>
              {target.title}
            </span>
            {showContent && (
              <span className="w-[44px] shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                {loading ? '加载中' : `${items.length} 条`}
              </span>
            )}
          </div>
          {isAgentSession && (
            <SessionHoverMetaPanel meta={meta} projectName={target.workspaceName} />
          )}
        </div>

        {showContent && (
        <div data-session-minimap-content="true" className="relative flex-1 min-h-0 overflow-hidden bg-popover p-1.5">
          {loading && (
            <div className="absolute inset-1.5 rounded-md bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                <span>正在读取会话...</span>
              </div>
              <div className="mt-4 space-y-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <div className="mt-0.5 size-4 rounded bg-muted/70 animate-pulse" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-2.5 w-full rounded bg-muted/70 animate-pulse" />
                      <div className="h-2.5 w-2/3 rounded bg-muted/50 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="h-full rounded-md bg-muted/30 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">{error}</div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="h-full rounded-md bg-muted/30 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">暂无可预览内容</div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="h-full overflow-y-auto space-y-1 scrollbar-thin session-minimap-content-enter">
              {renderedItems.map((item, index) => (
                <div
                  key={`${item.id}-${index}`}
                  className="flex items-start gap-2 w-full px-2 py-1 text-left"
                >
                  <ItemIcon item={item} type={target.type} />
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        'w-fit max-w-full rounded-md py-1',
                        item.role === 'assistant' ? 'px-0' : 'px-2',
                        getMessageBubbleClass(item),
                      )}
                    >
                      <PreviewText text={item.preview} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
