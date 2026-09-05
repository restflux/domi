import { BrandLogo } from '@/components/ui/brand-logo'
/**
 * AgentMessages — Agent 消息列表
 *
 * 复用 Chat 的 Conversation/Message 原语组件，
 * 流式输出通过 SDK 渲染路径（MessageGroupRenderer）展示工具活动。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Bot, RotateCw, AlertTriangle, CheckCircle2, Ban, ChevronDown, ChevronRight } from 'lucide-react'
import { WelcomeEmptyState } from '@/components/welcome/WelcomeEmptyState'
import { AgentBrowserLinkProvider } from '@/components/browser/AgentBrowserLinkProvider'
import {
  Message,
  MessageHeader,
  MessageContent,
  BasePathsProvider,
} from '@/components/ai-elements/message'
import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation'
import { ScrollMinimap } from '@/components/ai-elements/scroll-minimap'
import type { MinimapItem } from '@/components/ai-elements/scroll-minimap'
import { buildStickyQuestionPreview, StickyUserMessage } from '@/components/ai-elements/sticky-user-message'
import { formatMessageTime } from '@/components/chat/ChatMessageItem'
import { getModelLogo, resolveModelDisplayName, resolveModelProvider } from '@/lib/model-logo'
import { userProfileAtom } from '@/atoms/user-profile'
import { tabMinimapCacheAtom } from '@/atoms/tab-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
import { clearScrollPositionMemory, ScrollPositionManager } from '@/hooks/useScrollPositionMemory'
import { cn } from '@/lib/utils'
import { AGENT_RUNNING_ORB_STATES, RotatingAgentActivityOrb } from '@/components/ui/agent-activity-orb'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { groupIntoTurns, MessageGroupRenderer, getGroupId, getGroupPreview, extractUserText, parseAttachedFiles as sdkParseAttachedFiles, buildTaskProgressDataForTurn, type MessageGroup } from './SDKMessageRenderer'
import { extractMeta } from '@domi/session-core'
import { buildLiveGroupSet } from './live-group-set'
import { AgentHistorySelectionLayer } from './AgentHistorySelectionLayer'
import { TaskProgressOverlay, type ContextCompactionProgress } from './TaskProgressOverlay'
import { PlanPreviewBlock, PlanPreviewScrollControlProvider, extractPlanText, hasPersistedPlanToolUse } from './PlanPreviewBlock'
import type { AgentEventUsage, RetryAttempt, SDKMessage, SDKSystemMessage } from '@domi/shared'
import { getSDKCompactStatus } from '@domi/shared'
import { allPendingExitPlanRequestsAtom, type AgentStreamState } from '@/atoms/agent-atoms'
import {
  DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
  expandAgentHistoryWindow,
  expandAgentHistoryWindowForward,
  resolveAgentHistoryLoadDirection,
  resolveAgentHistoryNavigationRange,
  resolveAgentHistoryPreservedScrollTop,
  resolveAgentHistoryRangeForSession,
  resolveAgentHistoryWindow,
  type AgentHistoryLoadDirection,
  type AgentHistoryRange,
} from '@/lib/agent-history-window'
import {
  AGENT_BOTTOM_FOLLOW_SCROLL_OPTIONS,
  resolveAgentBottomFollow,
  type AgentBottomFollowSnapshot,
} from '@/lib/agent-bottom-follow'
import { buildToolPresentationIndex } from './tool-presentation-index'
import { filterAndMergeConversationGroups } from './visible-conversation-groups'

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** 消息对象引用 → 稳定 key 缓存，避免内容相同的消息产生重复 key */
const stableKeyCache = new WeakMap<object, string>()
let stableKeyFallbackCounter = 0

function getSDKMessageStableKey(message: SDKMessage): string {
  const record = message as Record<string, unknown>
  if (typeof record.uuid === 'string' && record.uuid.length > 0) {
    return `${message.type}:uuid:${record.uuid}`
  }

  // 已缓存的消息对象直接返回，保证跨渲染稳定
  if (stableKeyCache.has(message)) {
    return stableKeyCache.get(message)!
  }

  const parentToolUseId = typeof record.parent_tool_use_id === 'string'
    ? record.parent_tool_use_id
    : ''
  const sessionId = typeof record.session_id === 'string' ? record.session_id : ''

  let key: string

  if (message.type === 'result') {
    const result = record as { subtype?: unknown; terminal_reason?: unknown; result?: unknown }
    key = `result:${sessionId}:${String(result.subtype ?? '')}:${String(result.terminal_reason ?? '')}:${String(result.result ?? '')}:${++stableKeyFallbackCounter}`
  } else if (message.type === 'system') {
    const sys = record as { subtype?: unknown; task_id?: unknown; tool_use_id?: unknown }
    key = `system:${sessionId}:${String(sys.subtype ?? '')}:${String(sys.task_id ?? '')}:${String(sys.tool_use_id ?? '')}:${stableStringify(record)}:${++stableKeyFallbackCounter}`
  } else if ('message' in record) {
    const inner = record.message as { content?: unknown } | undefined
    key = `${message.type}:${sessionId}:${parentToolUseId}:${stableStringify(inner?.content)}:${++stableKeyFallbackCounter}`
  } else {
    key = `${message.type}:${sessionId}:${parentToolUseId}:${stableStringify(record)}:${++stableKeyFallbackCounter}`
  }

  stableKeyCache.set(message, key)
  return key
}

function isCompactionCommandText(text: string): boolean {
  const normalized = text.trim()
  if (normalized === '/compact') return true

  // Keep this node-free mirror of parseAgentCompactCommand local to the
  // renderer bundle: a command name must end at whitespace, not just a prefix.
  return normalized.startsWith('/compact') && /\s/u.test(normalized.charAt('/compact'.length))
}

export function isCompactionControlHistoryGroup(group: MessageGroup): boolean {
  if (group.type === 'system') return getSDKCompactStatus(group.message) != null
  return group.type === 'user' && isCompactionCommandText(extractUserText(group.message) ?? '')
}

/**
 * 派生消息区实际展示的分组。压缩控制记录只保留在原始会话中；其造成的
 * assistant turn 切分在隐藏后重新合并，避免重复渲染头像、模型名和操作栏。
 */
export function buildVisibleConversationGroups(groups: MessageGroup[]): MessageGroup[] {
  return filterAndMergeConversationGroups(groups, isCompactionControlHistoryGroup)
}

export function getContextCompactionProgress(
  messages: SDKMessage[],
  isCompacting: boolean | undefined,
  streamCompaction: AgentStreamState['contextCompaction'] | undefined,
): ContextCompactionProgress | undefined {
  const latestStatusIndex = messages.findLastIndex((message) =>
    message.type === 'system' && getSDKCompactStatus(message as SDKSystemMessage) != null,
  )
  const latestStatus = latestStatusIndex >= 0
    ? messages[latestStatusIndex] as SDKSystemMessage
    : undefined
  const status = latestStatus ? getSDKCompactStatus(latestStatus) : undefined
  // Pi 会在同一个 stream 内续跑压缩前的任务。压缩边界后的 assistant、user 或普通系统消息都属于新工作，
  // 终态状态（无论来自 atom 还是 liveMessages）都不能继续抢占新的正常进度。
  const hasResumedWork = latestStatusIndex >= 0
    && messages.slice(latestStatusIndex + 1).some((message) => {
      if (message.type === 'assistant' || message.type === 'user') return true
      return message.type === 'system' && getSDKCompactStatus(message as SDKSystemMessage) == null
    })

  if (streamCompaction?.status === 'running') {
    return {
      status: 'running',
      label: '正在整理上下文',
      detail: '正在生成会话摘要，完成后可继续当前任务。',
    }
  }
  if (streamCompaction?.status === 'success' && !hasResumedWork) {
    return {
      status: 'success',
      label: '上下文已压缩',
      detail: '会话已整理，可以继续当前任务。',
      summary: streamCompaction.summary,
    }
  }
  if (streamCompaction?.status === 'noop' && !hasResumedWork) {
    return {
      status: 'noop',
      label: '当前上下文无需压缩',
      detail: streamCompaction.message ?? '当前上下文仍可用，可以继续当前任务。',
    }
  }
  if (streamCompaction?.status === 'failed') {
    return {
      status: 'failed',
      label: '上下文压缩失败',
      detail: streamCompaction.message ?? '请检查模型连接后重试。',
    }
  }
  if (hasResumedWork) return undefined

  if (status === 'success' && latestStatus) {
    return {
      status: 'success',
      label: '上下文已压缩',
      detail: '会话已整理，可以继续当前任务。',
      summary: latestStatus.summary,
    }
  }
  if (status === 'noop' && latestStatus) {
    return {
      status: 'noop',
      label: '当前上下文无需压缩',
      detail: latestStatus.message ?? '当前上下文仍可用，可以继续当前任务。',
    }
  }
  if (status === 'failed' && latestStatus) {
    return {
      status: 'failed',
      label: '上下文压缩失败',
      detail: latestStatus.compact_error ?? latestStatus.message ?? '请检查模型连接后重试。',
    }
  }
  if (status === 'compacting' || isCompacting) {
    return {
      status: 'running',
      label: '正在整理上下文',
      detail: '正在生成会话摘要，完成后可继续当前任务。',
    }
  }
  return undefined
}

/** AgentMessages 属性接口 */
interface AgentMessagesProps {
  sessionId: string
  /** 用户在前端选择的模型 ID（用于显示渠道配置的 Model Name） */
  sessionModelId?: string
  /** 消息是否已完成首次加载 */
  messagesLoaded?: boolean
  /** Phase 4: 持久化的 SDKMessage（新格式） */
  persistedSDKMessages?: SDKMessage[]
  streaming: boolean
  /** modern Runtime Rail 已接管运行状态与计时时隐藏旧消息区指示器。 */
  showRunningIndicator?: boolean
  streamState?: AgentStreamState
  /** Phase 2: 实时 SDKMessage 列表（流式期间累积） */
  liveMessages?: SDKMessage[]
  /** 当前会话工作目录，用于解析相对文件路径 */
  sessionPath?: string | null
  /** 附加目录列表（与 sessionPath 一并用作相对路径解析候选） */
  attachedDirs?: string[]
  /** 当前会话已发起的用户 turn 版本；递增时强制回到底部 */
  bottomFollowRevision?: number
  /** 最后一轮是否被用户中断 */
  stoppedByUser?: boolean
  onRetry?: () => void
  onRetryNow?: () => void
  retryNowPending?: boolean
  onRetryInNewSession?: () => void
  onRelinkProjectRoot?: () => void
  onRestoreProjectRoot?: () => void
  onFork?: (upToMessageUuid: string) => void
  onForkToWorktree?: (upToMessageUuid: string) => void
  onRewind?: (assistantMessageUuid: string) => void
  onCreateTodo?: (text: string) => void
  onCompact?: () => void
}

/** 空状态回退；正常的新 Work 会话由 AgentView 展示独立启动面板。 */
function EmptyState(): React.ReactElement {
  return <WelcomeEmptyState />
}

function AssistantLogo({ model }: { model?: string }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (model) {
    return (
      <BrandLogo
        src={getModelLogo(model, resolveModelProvider(model, channels))}
        alt={model}
        className="size-[35px] rounded-[25%] object-cover"
      />
    )
  }
  return (
    <div className="size-[35px] rounded-[25%] bg-primary/10 flex items-center justify-center">
      <Bot size={18} className="text-primary" />
    </div>
  )
}

/** 重试提示组件 - 折叠式 */
function RetryingNotice({
  retrying,
  onRetryNow,
  retryNowPending = false,
}: {
  retrying: NonNullable<AgentStreamState['retrying']>
  onRetryNow?: () => void
  retryNowPending?: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [countdown, setCountdown] = React.useState(0)

  // 仅 scheduled 阶段显示倒计时：此时 Pi 仍在 backoff，尚未重新发起模型请求。
  React.useEffect(() => {
    if (retrying.phase !== 'scheduled' || retrying.scheduledAt == null || retrying.delaySeconds == null) {
      setCountdown(0)
      return
    }

    const updateCountdown = (): void => {
      const elapsed = (Date.now() - retrying.scheduledAt!) / 1_000
      setCountdown(Math.ceil(Math.max(0, retrying.delaySeconds! - elapsed)))
    }

    updateCountdown()
    const timer = setInterval(updateCountdown, 100)
    return () => clearInterval(timer)
  }, [retrying.delaySeconds, retrying.phase, retrying.scheduledAt])

  const statusText = (() => {
    const suffix = `第 ${retrying.currentAttempt}/${retrying.maxAttempts} 次继续当前回答`
    switch (retrying.phase) {
      case 'scheduled':
        return countdown > 0 ? `网络暂时中断，${countdown} 秒后开始${suffix}` : `网络暂时中断，即将开始${suffix}`
      case 'running':
        return `正在${suffix}…`
      case 'succeeded':
        return `已在${suffix}时恢复`
      case 'exhausted':
        return retrying.totalAttempt != null && retrying.maxTotalAttempts != null
          ? `本轮自动恢复已耗尽（${retrying.totalAttempt}/${retrying.maxTotalAttempts}）`
          : `自动恢复已耗尽（${retrying.currentAttempt}/${retrying.maxAttempts}）`
      case 'cancelled':
        return '自动恢复已取消'
    }
  })()

  const isTerminal = retrying.phase === 'exhausted' || retrying.phase === 'cancelled'

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 p-3 mb-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-80 transition-opacity"
          onClick={() => setExpanded(!expanded)}
        >
          {retrying.phase === 'succeeded' ? (
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          ) : isTerminal ? (
            retrying.phase === 'cancelled'
              ? <Ban className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
              : <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
          ) : (
            <RotateCw className="size-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <span className="text-sm text-amber-900 dark:text-amber-100 flex-1 tabular-nums">
            {statusText}
            {retrying.reason && ` · ${retrying.reason}`}
          </span>
          {expanded ? (
            <ChevronDown className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
          ) : (
            <ChevronRight className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
        </button>
        {retrying.phase === 'scheduled' && onRetryNow && (
          <button
            type="button"
            className="h-7 shrink-0 rounded-md bg-amber-600 px-2.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-amber-700 disabled:cursor-wait disabled:opacity-60 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
            disabled={retryNowPending}
            onClick={onRetryNow}
          >
            {retryNowPending ? '正在重试…' : '立即重试'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-amber-200 dark:border-amber-800 pt-3">
          {retrying.maxTotalAttempts != null && (
            <div className="text-xs text-amber-700 dark:text-amber-300 tabular-nums">
              本轮已安排 {retrying.totalAttempt ?? 0}/{retrying.maxTotalAttempts} 次自动恢复
            </div>
          )}
          {retrying.history.length > 0 && (
            <>
              <div className="text-xs font-medium text-amber-900 dark:text-amber-100">
                已执行的恢复记录：
              </div>
              {retrying.history.map((attempt, index) => (
                <RetryAttemptItem
                  key={attempt.attempt}
                  attempt={attempt}
                  isLatest={index === retrying.history.length - 1}
                />
              ))}
            </>
          )}
          {retrying.phase === 'scheduled' && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 pl-6 tabular-nums">
              <RotateCw className="size-3 animate-spin" />
              <span>{countdown > 0 ? `等待 ${countdown} 秒后开始第 ${retrying.currentAttempt} 次继续当前回答` : `即将开始第 ${retrying.currentAttempt} 次继续当前回答`}</span>
            </div>
          )}
          {retrying.phase === 'running' && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 pl-6 tabular-nums">
              <RotateCw className="size-3 animate-spin" />
              <span>正在执行第 {retrying.currentAttempt} 次继续当前回答…</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 单条重试尝试记录 */
function RetryAttemptItem({
  attempt,
  isLatest,
}: {
  attempt: RetryAttempt
  isLatest: boolean
}): React.ReactElement {
  const [showStderr, setShowStderr] = React.useState(false)
  const [showStack, setShowStack] = React.useState(false)

  const time = new Date(attempt.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <div className={cn('pl-6 space-y-2', isLatest && 'font-medium')}>
      {/* 尝试头部 */}
      <div className="flex items-start gap-2">
        <span className="text-destructive shrink-0">❌</span>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-xs text-amber-900 dark:text-amber-100 tabular-nums">
            第 {attempt.attempt} 次恢复前的错误（{time}）- {attempt.reason}
          </div>
          <div className="text-xs text-amber-700 dark:text-amber-300 font-mono break-words">
            {attempt.errorMessage}
          </div>

          {/* 环境信息 */}
          {attempt.environment && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 space-y-0.5">
              <div>运行时: {attempt.environment.runtime}</div>
              <div>平台: {attempt.environment.platform}</div>
              <div>模型: {attempt.environment.model}</div>
              {attempt.environment.workspace && <div>项目: {attempt.environment.workspace}</div>}
            </div>
          )}

          {/* 可展开的 stderr */}
          {attempt.stderr && (
            <div className="mt-2">
              <button
                type="button"
                className="text-[11px] text-amber-700 dark:text-amber-300 hover:underline flex items-center gap-1"
                onClick={() => setShowStderr(!showStderr)}
              >
                {showStderr ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                显示 stderr 输出
              </button>
              {showStderr && (
                <pre className="mt-1 text-[10px] text-amber-800 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/30 p-2 rounded overflow-x-auto scrollbar-thin max-h-[200px] overflow-y-auto">
                  {attempt.stderr}
                </pre>
              )}
            </div>
          )}

          {/* 可展开的堆栈跟踪 */}
          {attempt.stack && (
            <div className="mt-2">
              <button
                type="button"
                className="text-[11px] text-amber-700 dark:text-amber-300 hover:underline flex items-center gap-1"
                onClick={() => setShowStack(!showStack)}
              >
                {showStack ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                显示堆栈跟踪
              </button>
              {showStack && (
                <pre className="mt-1 text-[10px] text-amber-800 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/30 p-2 rounded overflow-x-auto scrollbar-thin max-h-[200px] overflow-y-auto">
                  {attempt.stack}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 格式化耗时（毫秒 → 可读字符串） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s.toFixed(0)}s`
}

/** 构建 usage tooltip 多行文本 */
export function buildUsageTooltip(durationMs: number, usage?: AgentEventUsage): string {
  const lines: string[] = []
  lines.push(`耗时: ${formatDuration(durationMs)}`)

  if (usage) {
    const pureInput = (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0)
    if (pureInput > 0) lines.push(`输入: ${pureInput.toLocaleString()}`)
    if (usage.outputTokens) lines.push(`输出: ${usage.outputTokens.toLocaleString()}`)
    if (usage.cacheCreationTokens) lines.push(`缓存写入: ${usage.cacheCreationTokens.toLocaleString()}`)
    if (usage.cacheReadTokens) lines.push(`缓存读取: ${usage.cacheReadTokens.toLocaleString()}`)
  }

  return lines.join('\n')
}

/** 耗时徽章 — 悬浮显示 token 用量明细 */
export function DurationBadge({ durationMs, usage }: { durationMs: number; usage?: AgentEventUsage }): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-[15px] tabular-nums font-light cursor-default">
          {formatDuration(durationMs)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="whitespace-pre-line text-left">{buildUsageTooltip(durationMs, usage)}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/** Agent 运行指示器 — 轮换思考 Orb + 无括号的运行时间 */
function AgentRunningIndicator({ startedAt }: { startedAt?: number }): React.ReactElement {
  const [elapsed, setElapsed] = React.useState(0)

  React.useEffect(() => {
    const start = startedAt ?? Date.now()
    const update = (): void => setElapsed((Date.now() - start) / 1000)
    update()
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [startedAt])

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}m ${s.toFixed(1)}s`
  }

  return (
    <div className="flex items-center gap-2 min-h-[28px]">
      <RotatingAgentActivityOrb states={AGENT_RUNNING_ORB_STATES} size={20} aria-hidden="true" />
      <span className="text-[13px] font-light text-muted-foreground/75 tabular-nums">Agent Running {formatTime(elapsed)}</span>
    </div>
  )
}

function waitForHistoryDomCommit(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function AgentHistoryAutoLoader({
  loading,
  canLoadEarlier,
  canLoadLater,
  onLoad,
}: {
  loading: boolean
  canLoadEarlier: boolean
  canLoadLater: boolean
  onLoad: (direction: AgentHistoryLoadDirection, scrollElement: HTMLElement) => Promise<void>
}): null {
  const { scrollRef, stopScroll } = useStickToBottomContext()
  const requestInFlightRef = React.useRef(false)

  React.useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    let lastScrollTop = scrollElement.scrollTop

    const requestLoad = (intent: 'up' | 'down'): void => {
      if (loading || requestInFlightRef.current) return
      const direction = resolveAgentHistoryLoadDirection({
        scrollTop: scrollElement.scrollTop,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
        intent,
        canLoadEarlier,
        canLoadLater,
      })
      if (!direction) return

      requestInFlightRef.current = true
      stopScroll()
      void onLoad(direction, scrollElement).finally(() => {
        requestInFlightRef.current = false
        lastScrollTop = scrollElement.scrollTop
      })
    }

    const handleScroll = (): void => {
      const nextScrollTop = scrollElement.scrollTop
      const intent = nextScrollTop < lastScrollTop ? 'up' : 'down'
      lastScrollTop = nextScrollTop
      requestLoad(intent)
    }
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) requestLoad('up')
      else if (event.deltaY > 0) requestLoad('down')
    }

    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    scrollElement.addEventListener('wheel', handleWheel, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
      scrollElement.removeEventListener('wheel', handleWheel)
    }
  }, [canLoadEarlier, canLoadLater, loading, onLoad, scrollRef, stopScroll])

  return null
}

function AgentBottomFollowManager({
  sessionId,
  requestRevision,
}: AgentBottomFollowSnapshot): null {
  const { scrollToBottom } = useStickToBottomContext()
  const previousRef = React.useRef<AgentBottomFollowSnapshot>({ sessionId, requestRevision })

  React.useLayoutEffect(() => {
    const current = { sessionId, requestRevision }
    const decision = resolveAgentBottomFollow(previousRef.current, current)
    previousRef.current = current

    if (decision.shouldScrollToBottom) {
      clearScrollPositionMemory(sessionId)
      void scrollToBottom(AGENT_BOTTOM_FOLLOW_SCROLL_OPTIONS)
    }
  }, [requestRevision, scrollToBottom, sessionId])

  return null
}

export function AgentMessages({ sessionId, sessionModelId, messagesLoaded, persistedSDKMessages, streaming, showRunningIndicator = true, streamState, liveMessages, sessionPath, attachedDirs, bottomFollowRevision = 0, stoppedByUser, onRetry, onRetryNow, retryNowPending, onRetryInNewSession, onRelinkProjectRoot, onRestoreProjectRoot, onFork, onForkToWorktree, onRewind, onCreateTodo, onCompact }: AgentMessagesProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const setMinimapCache = useSetAtom(tabMinimapCacheAtom)
  const channels = useAtomValue(channelsAtom)
  const pendingExitPlanRequests = useAtomValue(allPendingExitPlanRequestsAtom)
  const pendingPlanRequest = pendingExitPlanRequests.get(sessionId)?.[0] ?? null
  const pendingPlan = extractPlanText(pendingPlanRequest?.toolInput)
  const historySelectionRootRef = React.useRef<HTMLDivElement>(null)
  /** 淡入控制：切换会话时先隐藏，等布局完成后再显示。 */
  const [ready, setReady] = React.useState(false)
  // 空会话无需淡入过渡（无消息则无滚动位置问题）
  const [skipFadeIn, setSkipFadeIn] = React.useState(false)
  const prevSessionIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId
      setReady(false)
      setSkipFadeIn(false)
    }
  }, [sessionId])

  React.useEffect(() => {
    if (ready) return

    // 必须等消息加载完成，否则空 SDK 消息会被误判为空对话
    if (messagesLoaded === false) return

    // 流式进行中且有实时内容 → 跳过 fade 直接显示
    if (streaming && liveMessages && liveMessages.length > 0) {
      setReady(true)
      return
    }

    if ((!persistedSDKMessages || persistedSDKMessages.length === 0) && !streaming) {
      setSkipFadeIn(true)
      setReady(true)
      return
    }
    let cancelled = false
    requestAnimationFrame(() => {
      if (!cancelled) setReady(true)
    })
    return () => { cancelled = true }
  }, [streaming, liveMessages, persistedSDKMessages, messagesLoaded])

  // 正文只来自 live SDKMessage；streamState 仅保留非正文运行信息。
  const streamingModelId = streamState?.model || sessionModelId
  const agentStreamingModel = streamingModelId ? resolveModelDisplayName(streamingModelId, channels) : undefined
  const retrying = streamState?.retrying
  const startedAt = streamState?.startedAt

  /**
   * 流式完成过渡：streaming 结束到持久化消息加载完成之间，
   * 强制 resize="instant" 避免中间高度变化触发平滑滚动动画。
   *
   * 使用 render-phase 计算避免 useEffect 延迟一帧的问题：
   * - streaming 变 false 的第一帧就能立即切到 instant，防止闪动
   * - 后续通过 ref+timeout 延迟 150ms 才允许切回 smooth
   */
  const [transitioningCooldown, setTransitioningCooldown] = React.useState(false)
  const wasStreamingRef = React.useRef(streaming)

  // render-phase 判断：是否处于需要 instant resize 的过渡期
  // liveMessages 非空说明持久化消息还没加载完（加载完后会清空 liveMessages）
  const needsInstant = !streaming && liveMessages != null && liveMessages.length > 0

  React.useEffect(() => {
    // 刚从 streaming → not-streaming：启动 cooldown
    if (wasStreamingRef.current && !streaming) {
      setTransitioningCooldown(true)
    }
    wasStreamingRef.current = streaming
  }, [streaming])

  React.useEffect(() => {
    if (needsInstant) return
    // 过渡完成后延迟 150ms 才关闭 cooldown，给 StickToBottom 时间稳定
    const timer = setTimeout(() => setTransitioningCooldown(false), 150)
    return () => clearTimeout(timer)
  }, [needsInstant])

  const transitioning = needsInstant || transitioningCooldown

  // 合并持久化 + 实时 SDKMessage（供 ContentBlock 内查找工具结果）
  const allSDKMessages = React.useMemo(() => {
    const persisted = persistedSDKMessages ?? []
    const live = liveMessages ?? []
    const stampStableKey = (message: SDKMessage): SDKMessage => {
      const key = getSDKMessageStableKey(message)
      ;(message as Record<string, unknown>)._domiStableKey = key
      return message
    }
    const keyOf = (message: SDKMessage): string =>
      (message as Record<string, unknown>)._domiStableKey as string

    const persistedWithKeys = persisted.map(stampStableKey)
    const liveWithKeys = live.map(stampStableKey)
    if (streaming || liveWithKeys.length === 0 || persistedWithKeys.length === 0) {
      return [...persistedWithKeys, ...liveWithKeys]
    }

    // 流式结束后的刷新中，持久化消息尾部可能已经包含 live 序列。
    // 只替换有序尾部重叠，避免按内容全局去重误删历史中的相同问答。
    let overlap = Math.min(persistedWithKeys.length, liveWithKeys.length)
    for (; overlap > 0; overlap--) {
      const persistedStart = persistedWithKeys.length - overlap
      const liveStart = liveWithKeys.length - overlap
      let matches = true
      for (let i = 0; i < overlap; i++) {
        if (keyOf(persistedWithKeys[persistedStart + i]!) !== keyOf(liveWithKeys[liveStart + i]!)) {
          matches = false
          break
        }
      }
      if (matches) break
    }

    if (overlap === 0) return [...persistedWithKeys, ...liveWithKeys]
    return [
      ...persistedWithKeys.slice(0, persistedWithKeys.length - overlap),
      ...liveWithKeys,
    ]
  }, [persistedSDKMessages, liveMessages, streaming])
  const toolPresentationIndex = React.useMemo(
    () => buildToolPresentationIndex(allSDKMessages),
    [allSDKMessages],
  )
  const hasContent = allSDKMessages.length > 0
  const pendingPlanAlreadyInMessages = React.useMemo(
    () => pendingPlan ? hasPersistedPlanToolUse(pendingPlan, allSDKMessages) : false,
    [allSDKMessages, pendingPlan],
  )
  const shouldRenderPendingPlan = pendingPlan !== null && !pendingPlanAlreadyInMessages

  // 仅扫描当前 live turn；不从持久化历史恢复任务，避免跨 turn 显示旧进度。
  const liveTaskActivities = React.useMemo(() => {
    const liveGroups = groupIntoTurns(liveMessages ?? [], sessionModelId)
    const currentTurn = [...liveGroups].reverse().find((group) => group.type === 'assistant-turn')
    return currentTurn ? buildTaskProgressDataForTurn(currentTurn).taskActivities : []
  }, [liveMessages, sessionModelId])

  const contextCompaction = React.useMemo(
    () => getContextCompactionProgress(liveMessages ?? [], streamState?.isCompacting, streamState?.contextCompaction),
    [liveMessages, streamState?.isCompacting, streamState?.contextCompaction],
  )
  // 压缩流程进行中（含收尾窗口：compact_boundary 已到但 result 未到）
  // → 抑制 AgentRunningIndicator，避免压缩分隔符切换期间闪烁。
  // Pi 同一 stream 续跑后，getContextCompactionProgress 会清除终态反馈；此时即使旧标记尚未刷新，
  // 也必须恢复正常运行指示器。
  const suppressAgentRunning = streamState?.isCompacting
    || (streamState?.compactInFlight && contextCompaction != null)

  // 统一分组：将持久化 + 实时消息合并后再分组，确保 system 消息（如压缩分割线）出现在正确位置
  const allGroups = React.useMemo(() => {
    return groupIntoTurns(allSDKMessages, sessionModelId)
  }, [allSDKMessages, sessionModelId])
  // 压缩过程由底部 Progress Overlay 独立承载，不占用对话历史、迷你地图或用户锚点。
  const visibleGroups = React.useMemo(
    () => buildVisibleConversationGroups(allGroups),
    [allGroups],
  )

  // 完整消息数据始终保留；默认只派生尾窗，不把派生 anchor 写回状态。
  // 只有用户实际向边界滚动或点击消息导航时才保存显式 range，避免结束过渡帧中
  // 仅有最后一个 live turn 时把它错误固化为历史起点。
  const [historyRangeState, setHistoryRangeState] = React.useState<({ sessionId: string } & AgentHistoryRange) | null>(null)
  const historyRangeStateRef = React.useRef(historyRangeState)
  historyRangeStateRef.current = historyRangeState
  const [historyExpansionInFlight, setHistoryExpansionInFlight] = React.useState(false)
  const historyExpansionInFlightRef = React.useRef(false)
  const activeHistorySessionIdRef = React.useRef(sessionId)
  const requestedHistoryRange = resolveAgentHistoryRangeForSession(historyRangeState, sessionId)
  const historyWindow = React.useMemo(
    () => resolveAgentHistoryWindow(
      visibleGroups,
      requestedHistoryRange?.startId ?? null,
      getGroupId,
      DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
      requestedHistoryRange?.endId ?? null,
    ),
    [requestedHistoryRange?.endId, requestedHistoryRange?.startId, visibleGroups],
  )
  const mountedGroups = historyWindow.mountedItems
  const hasUnmountedHistory = historyWindow.remainingCount > 0
    || historyWindow.remainingAfterCount > 0

  React.useEffect(() => {
    const previousRange = historyRangeStateRef.current
    if (previousRange && previousRange.sessionId !== sessionId) {
      clearScrollPositionMemory(previousRange.sessionId)
    }
    activeHistorySessionIdRef.current = sessionId
    setHistoryRangeState(null)
    historyExpansionInFlightRef.current = false
    setHistoryExpansionInFlight(false)
  }, [sessionId])

  const setHistoryLoading = React.useCallback((loading: boolean) => {
    historyExpansionInFlightRef.current = loading
    setHistoryExpansionInFlight(loading)
  }, [])

  const queryMountedHistoryGroup = React.useCallback((groupId: string): HTMLElement | null => {
    const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(groupId)
      : groupId
    return historySelectionRootRef.current
      ?.querySelector<HTMLElement>(`[data-message-id="${escapedId}"]`) ?? null
  }, [])

  const handleAutoLoadHistory = React.useCallback(async (
    direction: AgentHistoryLoadDirection,
    scrollElement: HTMLElement,
  ): Promise<void> => {
    if (historyExpansionInFlightRef.current) return

    if (direction === 'earlier') {
      const previousFirstGroupId = historyWindow.anchorId
      const nextStartId = expandAgentHistoryWindow(
        visibleGroups,
        previousFirstGroupId,
        getGroupId,
        DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
      )
      if (!previousFirstGroupId || !nextStartId || nextStartId === previousFirstGroupId) return

      const previousNode = queryMountedHistoryGroup(previousFirstGroupId)
      const previousOffset = previousNode
        ? previousNode.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
        : null
      const previousScrollHeight = scrollElement.scrollHeight
      const previousScrollTop = scrollElement.scrollTop
      setHistoryLoading(true)
      setHistoryRangeState({
        sessionId,
        startId: nextStartId,
        endId: historyWindow.endAnchorId,
      })
      await waitForHistoryDomCommit()
      if (activeHistorySessionIdRef.current !== sessionId) return

      const nextNode = queryMountedHistoryGroup(previousFirstGroupId)
      const nextOffset = nextNode
        ? nextNode.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
        : null
      scrollElement.scrollTop = resolveAgentHistoryPreservedScrollTop({
        previousScrollTop,
        previousScrollHeight,
        nextScrollHeight: scrollElement.scrollHeight,
        previousAnchorOffset: previousOffset,
        nextAnchorOffset: nextOffset,
      })
      setHistoryLoading(false)
      return
    }

    const currentEndAnchorId = historyWindow.endAnchorId
    if (!currentEndAnchorId) return
    const nextEndId = expandAgentHistoryWindowForward(
      visibleGroups,
      currentEndAnchorId,
      getGroupId,
      DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
    )
    const previousScrollTop = scrollElement.scrollTop
    setHistoryLoading(true)
    setHistoryRangeState({
      sessionId,
      startId: historyWindow.anchorId ?? getGroupId(visibleGroups[0]!),
      endId: nextEndId,
    })
    await waitForHistoryDomCommit()
    if (activeHistorySessionIdRef.current !== sessionId) return
    scrollElement.scrollTop = previousScrollTop
    setHistoryLoading(false)
  }, [historyWindow.anchorId, historyWindow.endAnchorId, queryMountedHistoryGroup, sessionId, setHistoryLoading, visibleGroups])

  const handleRequestHistoryGroupMount = React.useCallback(async (groupId: string): Promise<void> => {
    if (queryMountedHistoryGroup(groupId)) return
    for (let attempt = 0; attempt < 4 && historyExpansionInFlightRef.current; attempt++) {
      await waitForHistoryDomCommit()
    }
    if (queryMountedHistoryGroup(groupId) || historyExpansionInFlightRef.current) return
    const range = resolveAgentHistoryNavigationRange(
      visibleGroups,
      groupId,
      getGroupId,
      DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
    )
    if (!range) return

    setHistoryLoading(true)
    setHistoryRangeState({ sessionId, ...range })
    await waitForHistoryDomCommit()
    if (activeHistorySessionIdRef.current === sessionId) setHistoryLoading(false)
  }, [queryMountedHistoryGroup, sessionId, setHistoryLoading, visibleGroups])

  // 标记哪些 group 属于实时流式消息（用于 isStreaming / onFork 差异化渲染）
  const liveGroupSet = React.useMemo(() => {
    return buildLiveGroupSet({
      allGroups: visibleGroups,
      liveMessages,
      streaming,
    })
  }, [liveMessages, streaming, visibleGroups])

  // 消息导航覆盖完整会话；未挂载目标由 ScrollMinimap 请求有界挂载后再精确跳转。
  const minimapItems: MinimapItem[] = React.useMemo(
    () => visibleGroups.map((group) => ({
      id: getGroupId(group),
      role: group.type === 'user' ? 'user' as const
        : group.type === 'system' ? 'status' as const
        : 'assistant' as const,
      preview: getGroupPreview(group),
      avatar: group.type === 'user' ? userProfile.avatar : undefined,
      model: group.type === 'assistant-turn' ? group.model : undefined,
    })),
    [userProfile.avatar, visibleGroups]
  )

  // 同步 minimap 缓存到 Tab 级别（供 Tab hover 预览使用）
  React.useEffect(() => {
    if (minimapItems.length > 0) {
      setMinimapCache((prev) => {
        const next = new Map(prev)
        next.set(sessionId, minimapItems)
        return next
      })
    }
  }, [sessionId, minimapItems, setMinimapCache])

  // 已挂载的用户消息定位信息 — 供返回上一条提问快捷入口使用
  const userMessagesForStickyShortcut = React.useMemo(
    () => mountedGroups
      .filter((group) => group.type === 'user')
      .map((group) => {
        const createdAt = extractMeta(group.message).createdAt
        const rawText = extractUserText(group.message) ?? ''
        const { files, text } = sdkParseAttachedFiles(rawText)
        return {
          id: getGroupId(group),
          time: createdAt ? formatMessageTime(createdAt) : undefined,
          preview: buildStickyQuestionPreview(text),
          attachmentCount: files.length,
        }
      }),
    [mountedGroups],
  )

  // 实时消息中是否已有可渲染的助手内容
  // 流式中：通过 liveGroupSet 精确判断（只有 streaming 时 liveGroupSet 才非空）
  // 流式结束后：直接检查 liveMessages 中是否有助手消息，
  // 防止 streaming→false 到 liveMessages 被清除之间的过渡帧中 fallback 气泡重复渲染
  const hasLiveAssistantContent = streaming
    ? visibleGroups.some((g) => g.type === 'assistant-turn' && liveGroupSet.has(g))
    : (liveMessages != null && liveMessages.some((m) => (m as { type: string }).type === 'assistant'))

  const messageBasePaths = React.useMemo(
    () => [sessionPath, ...(attachedDirs ?? [])].filter((path): path is string => Boolean(path)),
    [sessionPath, attachedDirs],
  )
  const lastMountedAssistantIndex = mountedGroups.findLastIndex((group) => group.type === 'assistant-turn')

  return (
    <AgentBrowserLinkProvider sessionId={sessionId}>
    <BasePathsProvider basePaths={messageBasePaths}>
    <div ref={historySelectionRootRef} className="relative flex min-h-0 flex-1 flex-col">
      <Conversation resize={ready && !transitioning && !historyExpansionInFlight ? 'smooth' : 'instant'} className={ready ? (skipFadeIn ? 'opacity-100' : 'opacity-100 transition-opacity duration-200') : 'opacity-0'}>
        <ScrollPositionManager id={sessionId} ready={ready} />
        <AgentBottomFollowManager sessionId={sessionId} requestRevision={bottomFollowRevision} />
        <AgentHistoryAutoLoader
          loading={historyExpansionInFlight}
          canLoadEarlier={ready && !transitioning && messagesLoaded !== false && historyWindow.remainingCount > 0}
          canLoadLater={ready && !transitioning && messagesLoaded !== false && historyWindow.remainingAfterCount > 0}
          onLoad={handleAutoLoadHistory}
        />
        <PlanPreviewScrollControlProvider>
          <ConversationContent>
          {!hasContent && !streaming && !shouldRenderPendingPlan ? (
            <EmptyState />
          ) : (
            <>
              {/* 历史窗口在接近滚动边界时无感扩展，不再展示手动“加载更早消息”折叠入口。 */}
              {/* 统一消息渲染（持久化 + 实时合并为一个列表，确保 system 消息位置正确） */}
              {mountedGroups.map((group, idx) => {
                const isLive = liveGroupSet.has(group)
                const isErrorGroup = group.type === 'assistant-turn'
                  && group.assistantMessages.some((m) => !!m.error)
                const shouldDisableActions = isLive && !isErrorGroup
                // 仅在最后一个 assistant-turn 上显示"已被用户中断" badge
                const isLastAssistantTurn = !streaming && stoppedByUser
                  && group.type === 'assistant-turn'
                  && idx === lastMountedAssistantIndex
                return (
                  <MessageGroupRenderer
                    key={getGroupId(group)}
                    group={group}
                    allMessages={allSDKMessages}
                    basePath={sessionPath || undefined}
                    basePaths={attachedDirs}
                    onFork={shouldDisableActions ? undefined : onFork}
                    onForkToWorktree={shouldDisableActions ? undefined : onForkToWorktree}
                    onRewind={shouldDisableActions ? undefined : onRewind}
                    onCreateTodo={shouldDisableActions ? undefined : onCreateTodo}
                    onRetry={shouldDisableActions ? undefined : onRetry}
                    onRetryInNewSession={shouldDisableActions ? undefined : onRetryInNewSession}
                    onRelinkProjectRoot={shouldDisableActions ? undefined : onRelinkProjectRoot}
                    onRestoreProjectRoot={shouldDisableActions ? undefined : onRestoreProjectRoot}
                    onCompact={shouldDisableActions ? undefined : onCompact}
                    isStreaming={isLive || undefined}
                    stoppedByUser={isLastAssistantTurn || undefined}
                    sessionId={sessionId}
                    sessionModelId={sessionModelId}
                    toolPresentationIndex={toolPresentationIndex}
                  />
                )
              })}

              {/* 正式计划作为主会话区的一等 Markdown 内容展示；Direct 实施反馈由持久化 tool_use 就地渲染。 */}
              {shouldRenderPendingPlan && pendingPlan && pendingPlanRequest && (
                <PlanPreviewBlock
                  key={pendingPlanRequest.requestId}
                  sessionId={sessionId}
                  plan={pendingPlan}
                  allMessages={allSDKMessages}
                  basePath={sessionPath || undefined}
                  basePaths={attachedDirs}
                />
              )}

              {/* 有实时助手内容时：显示运行指示器或占位（防止 streaming 结束到 Actions Bar 出现之间的高度跳动） */}
              {/* 不使用 mt：ConversationContent 的 gap-1(4px) 已提供间距，
                  匹配内部 MessageActions 的 gap-0.5(2px)+mt-0.5(2px)=4px 间距 */}
              {hasLiveAssistantContent && !suppressAgentRunning && (
                <div className="pl-[56px] min-h-[28px]">
                  {retrying && (
                    <RetryingNotice
                      retrying={retrying}
                      onRetryNow={onRetryNow}
                      retryNowPending={retryNowPending}
                    />
                  )}
                  {streaming && showRunningIndicator && <AgentRunningIndicator startedAt={startedAt} />}
                </div>
              )}

              {/* 无实时助手内容时：显示完整气泡（含头像/名称/时间） */}
              {/* 注意：工具活动已通过 SDK 渲染路径（liveGroups）展示 */}
              {!hasLiveAssistantContent && !suppressAgentRunning && ((streaming && showRunningIndicator) || retrying) && (
                <Message from="assistant">
                  <MessageHeader
                    model={agentStreamingModel}
                    time={formatMessageTime(Date.now())}
                    logo={<AssistantLogo model={streamingModelId} />}
                  />
                  <MessageContent>
                    {retrying && (
                      <RetryingNotice
                        retrying={retrying}
                        onRetryNow={onRetryNow}
                        retryNowPending={retryNowPending}
                      />
                    )}
                    {streaming && showRunningIndicator && <AgentRunningIndicator startedAt={startedAt} />}
                  </MessageContent>
                </Message>
              )}

            </>
          )}
          </ConversationContent>
        </PlanPreviewScrollControlProvider>
        <ScrollMinimap
          items={minimapItems}
          hasUnmountedItems={hasUnmountedHistory}
          onRequestMount={handleRequestHistoryGroupMount}
        />
        <TaskProgressOverlay
          key={sessionId}
          activities={liveTaskActivities}
          streaming={streaming}
          contextCompaction={contextCompaction}
        />
        {userMessagesForStickyShortcut.length > 0 && (
          <StickyUserMessage
            userMessages={userMessagesForStickyShortcut}
            userName={userProfile.userName}
            userAvatar={userProfile.avatar}
          />
        )}
      </Conversation>
      <AgentHistorySelectionLayer sessionId={sessionId} rootRef={historySelectionRootRef} />
    </div>
    </BasePathsProvider>
    </AgentBrowserLinkProvider>
  )
}
