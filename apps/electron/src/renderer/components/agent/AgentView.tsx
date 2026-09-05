import { BrandLogo } from '@/components/ui/brand-logo'
/**
 * AgentView — Agent 模式主视图容器
 *
 * 职责：
 * - 加载当前 Agent 会话消息
 * - 发送/停止/压缩 Agent 消息
 * - 附件上传处理
 * - AgentHeader 提供当前会话工具栏、Session Target 与会话菜单
 *
 * 注意：IPC 流式事件监听已提升到全局 useGlobalAgentListeners，
 * 本组件为纯展示 + 交互组件。
 *
 * 布局：AgentHeader | AgentMessages | AgentInput + 可选 FileBrowser 侧面板
 */

import * as React from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, CornerDownLeft, Square, Settings, X, Copy, Check, RotateCw, Sparkles, ChevronDown, ChevronRight, Cpu, ListTodo, MessageSquarePlus, Paperclip, FileText, FolderOpen, GitFork, GitBranch, Zap, Telescope, ClipboardList, type LucideIcon } from 'lucide-react'
import { AgentMessages } from './AgentMessages'
import { AgentHeader } from './AgentHeader'
import { AgentMessageQueue } from './AgentMessageQueue'
import { ContextUsageBadge } from './ContextUsageBadge'
import { AgentStatusShortcut } from './AgentStatusShortcut.tsx'
import { PermissionBanner } from './PermissionBanner'
import { ExecutionControls } from './ExecutionControls.tsx'
import { AGENT_WORKFLOW_DISPLAY_OPTIONS } from '@/lib/agent-control-display.ts'
import { AskUserBanner } from './AskUserBanner'
import { ExitPlanModeBanner } from './ExitPlanModeBanner'
import { PlanModeDashedBorder } from './PlanModeDashedBorder'
import { AgentSessionTargetChooser } from './AgentSessionTarget.tsx'
import { WorktreeReviewStatus } from './worktree-review/WorktreeReviewStatus.tsx'
import {
  ComposerActionRail,
  composerRailOwnsRunningIndicator,
  resolveComposerActionRailKind,
  resolveWorktreeRailPriority,
} from './ComposerActionRail.tsx'
import {
  formatAgentRuntimeDuration,
  getAgentRuntimeProviderUsageSnapshot,
  isAgentRetryIssue,
  resolveAgentIssueLabel,
  useAgentRuntimeRailState,
} from './agent-runtime-telemetry.ts'
import { AgentRuntimeActionRail } from './AgentRuntimeActionRail.tsx'
import { calculateAgentSessionUsage, formatAgentUsageTokens } from './agent-session-usage.ts'
import {
  WORKTREE_ITERATION_RESUME_EVENT,
  claimQueuedWorktreeIterationResume,
  consumeQueuedWorktreeIterationResume,
  getQueuedWorktreeIterationResume,
  registerWorktreeIterationResumeConsumer,
  releaseClaimedWorktreeIterationResume,
  type WorktreeIterationResumeDetail,
} from '@/lib/worktree-iteration-resume.ts'
import { buildModelOptions, ModelSelector } from '@/components/chat/ModelSelector'
import { AttachmentPreviewItem } from '@/components/chat/AttachmentPreviewItem'
import { QuotedSelectionChip } from '@/components/diff/QuotedSelectionChip'
import {
  LOCAL_MAINTENANCE_RESUME_EVENT,
  buildLocalMaintenanceContinuationPrompt,
  consumeQueuedLocalMaintenanceResume,
  getQueuedLocalMaintenanceResume,
  type LocalMaintenanceResumeDetail,
} from '@/lib/local-maintenance-resume.ts'
import {
  WORKTREE_APPLY_CONFLICT_RESUME_EVENT,
  buildWorktreeApplyConflictContinuationPrompt,
  claimQueuedWorktreeApplyConflictResume,
  consumeQueuedWorktreeApplyConflictResume,
  getQueuedWorktreeApplyConflictResume,
  releaseClaimedWorktreeApplyConflictResume,
  type WorktreeApplyConflictResumeDetail,
} from '@/lib/worktree-apply-conflict-resume.ts'
import {
  WORKTREE_REVIEW_REGENERATION_EVENT,
  buildWorktreeReviewRegenerationPrompt,
  consumeQueuedWorktreeReviewRegeneration,
  getQueuedWorktreeReviewRegeneration,
  shouldDeferWorktreeReviewRegeneration,
  type WorktreeReviewRegenerationDetail,
} from '@/lib/worktree-review-regeneration.ts'
import { RichTextInput, type RichTextInputHandle } from '@/components/ai-elements/rich-text-input'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { ComposerPlusMenu } from '@/components/ai-elements/composer-plus-menu'
import { WorkWelcomeEmptyState } from '@/components/welcome/WorkWelcomeEmptyState'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import {
  inputToolbarActiveButtonClass,
  inputToolbarButtonClass,
  inputToolbarDangerButtonClass,
  inputToolbarDisabledButtonClass,
  inputToolbarSendButtonClass,
} from '@/components/ai-elements/input-toolbar-styles'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { AgentActivityOrb } from '@/components/ui/agent-activity-orb'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import { registerShortcut } from '@/lib/shortcut-registry'
import { supportsChannelPlanQuota } from '@/lib/channel-plan-quota'
import {
  AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS,
  decideAgentEscapeAbort,
  shouldHandleAgentEscapeAbort,
} from '@/lib/agent-escape-abort'
import { previewFileMapAtom, quotedSelectionMapAtom, currentQuotedSelectionAtom } from '@/atoms/preview-atoms'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms'
import {
  closeSessionTreeForEscape,
  isSessionTreeOpen,
  sessionTreeOpenMapAtom,
  setSessionTreeOpen,
  toggleSessionTreeOpen,
} from '@/atoms/session-tree-atoms'
import {
  agentStreamingStatesAtom,
  agentSessionStreamingStateAtomFamily,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  currentAgentWorkspaceIdAtom,
  agentPendingPromptAtom,
  agentPendingFilesAtomFamily,
  agentMessageQueueAtomFamily,
  agentWorkspacesAtom,
  agentStreamErrorsAtom,
  agentSessionDraftsAtom,
  agentSessionDraftAtomFamily,
  agentSessionDraftHtmlAtom,
  agentSessionDraftHtmlAtomFamily,
  agentPromptSuggestionsAtom,
  agentMessageRefreshAtom,
  agentSDKMessagesCacheAtom,
  setSessionMessagesCache,
  skillTriggersByToolCallAtom,
  agentDiffRefreshVersionAtom,
  agentSessionsAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  liveMessagesMapAtom,
  agentLiveMessagesAtomFamily,
  agentThinkingAtom,
  agentEffortAtom,
  stoppedByUserSessionsAtom,
  agentPlanModeSessionsAtom,
  agentSessionExecutionControlsAtomFamily,
  agentPermissionModeMapAtom,
  agentDefaultPermissionModeAtom,
  sessionPersistedPermissionModeAtom,
  agentSessionPathMapAtom,
  allPendingAskUserRequestsAtom,
  allPendingPermissionRequestsAtom,
  allPendingExitPlanRequestsAtom,
  clearHydratedAgentSessionRuntimeState,
  finalizeStreamingActivities,
} from '@/atoms/agent-atoms'
import type { AgentContextStatus } from '@/atoms/agent-atoms'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { longTextPasteAsAttachmentEnabledAtom } from '@/atoms/ui-preferences'
import { interfaceVariantAtom, themeStyleAtom } from '@/atoms/theme'
import { channelsAtom, modelSelectorOpenAtom } from '@/atoms/chat-atoms'
import { todoPlanningGroupsAtom } from '@/atoms/planning-atoms'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { AgentSessionProvider } from '@/contexts/session-context'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { sidebarViewModeAtom } from '@/atoms/sidebar-atoms'
import { sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { getModelLogo } from '@/lib/model-logo'
import type { AgentSendInput, AgentPendingFile, AgentThinkingLevel, AgentNextTurnAside, AgentQueueMessageKind, AgentQueueReplayMessageInput, AgentWorkflow, ComposerAttachmentKind, FileDialogLargeFile, FileDialogResult, ForkSessionTargetChoice, ModelOption, ModelPresentationPreset, ReasoningCapability, RewindSessionPreview, RewindUndoState, SDKMessage, SDKUserMessage, SessionTreeResult } from '@domi/shared'
import { inferReasoningTransport, isCodexFastModeSupportedModel, MAX_ATTACHMENT_SIZE, normalizeReasoningCapabilityLevel, resolveReasoningCapability, resolveReasoningProfile } from '@domi/shared'
import { fileToBase64, formatFileNames, getFileParentPath } from '@/lib/file-utils'
import { openDialogAfterDropdownMenu } from '@/lib/open-dialog-after-dropdown-menu'
import { resolveAttachmentMenuTooltipOpen } from './attachment-menu-state'
import { getFilePanelDragData, INSERT_FILE_MENTION_EVENT, type FilePanelDragItem } from '@/lib/file-panel-drag'
import {
  buildAgentContextWindowOwner,
  calculateAgentSessionCacheMetrics,
  mergeAgentContextUsageHydrationState,
  resolveRunContextWindow,
  restoreAgentContextUsageFromMessages,
  type AgentContextUsageTarget,
} from '@/lib/agent-context-usage'
import { buildQuotedSelectionBlock } from '@/lib/quoted-selection'
import { createClipboardPendingFile, createClipboardTextDraft, makeUniqueAttachmentName } from '@/lib/clipboard-text-attachment'
import { copyTextToClipboard } from '@/lib/clipboard'
import {
  buildQueuedMessageSendPayload,
  changeQueuedMessageKind,
  createAgentQueuedMessage,
  getAsideQueuedMessages,
  getMostRecentQueuedMessage,
  getNativeQueuedMessages,
  getVisibleQueuedMessages,
  hasActiveNativeMessageQueue,
  mergeRestoredQueuedMessagesIntoDraft,
  moveQueuedMessage,
  orderQueuedMessagesForDelivery,
  parseQueuedMessageMentions,
  queuedTextToParagraphHtml,
  reconcileSubmittedQueuedMessage,
  removeQueuedMessage,
  resolveClearedQueuedMessages,
  restoreFailedAsideMessages,
  restoreQueuedMessageToFront,
} from '@/lib/agent-message-queue'
import type { AgentAsideQueuedMessage, AgentQueuedAttachment, AgentQueuedMessage, QueueDropPlacement } from '@/lib/agent-message-queue'
import { buildAgentSendControlOverrides } from '@/lib/agent-execution-controls.ts'
import {
  reactivateAgentSessionForSend,
  replaceAgentSessionInFreshnessOrder,
} from '@/lib/agent-session-list'
import {
  DEFAULT_AGENT_SESSION_TITLE,
  generateInitialWorktreeSessionTitle,
} from '@/lib/worktree-session-title'
import { getAgentQueueSubmitKind } from '@/lib/agent-queue-enter-kind'
import { resolveDeferredWorkspaceSend, shouldDeferWorkspaceSend } from '@/lib/agent-workspace-send-gate.ts'
import { buildRetryInNewSessionIntent, getSessionTargetInteraction } from '@/lib/session-target-view-model.ts'
import {
  SESSION_TREE_NAVIGATED_EVENT,
  SESSION_TREE_SCROLL_EVENT,
  scrollSessionTreeMessageIntoView,
  type SessionTreeNavigatedEventDetail,
  type SessionTreeScrollEventDetail,
} from './session-tree-events'
import { SessionTreeDialog } from './SessionTreePanel'
import { RewindUndoBanner } from './RewindUndoBanner'
import { SlashStatusCard } from './SlashStatusCard'
import { SlashPickerMenu, type SlashPickerOption } from './SlashPickerMenu'
import { registerBuiltinSlashCommands, setSlashCommandHost, executeSlashCommand, type SlashCommandHost } from '@/lib/slash-commands'
import {
  bindSessionTargetAtomFamily,
  sessionTargetStateAtomFamily,
  sessionTargetWorktreePendingAtomFamily,
} from '@/atoms/session-target-atoms.ts'

const LONG_TEXT_ATTACHMENT_THRESHOLD = 2000

function endOfToday(): number {
  const date = new Date()
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

interface OptimisticSDKUserMessage extends SDKUserMessage {
  _createdAt: number
}

interface PreparedAgentAttachment {
  referenceBlock: string
  attachments: AgentQueuedAttachment[]
  additionalDirectories: string[]
}

interface DeferredWorkspaceSendRequest {
  overrideText?: string
  requestedQueueKind: AgentQueueMessageKind
}

function createAsideQueuedMessages(
  asides: readonly AgentNextTurnAside[] | undefined,
  createdAt = Date.now(),
): AgentAsideQueuedMessage[] {
  return (asides ?? []).map((aside, index) => createAgentQueuedMessage(
    aside.content,
    aside.id,
    createdAt + index,
    null,
    { kind: 'aside' },
  ) as AgentAsideQueuedMessage)
}

function createUserSDKMessage(
  text: string,
  uuid?: string,
  createdAt = Date.now(),
  nextTurnAsides: readonly AgentNextTurnAside[] = [],
): SDKMessage {
  const message: OptimisticSDKUserMessage = {
    type: 'user',
    uuid,
    message: {
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    _createdAt: createdAt,
    ...(nextTurnAsides.length > 0 && { _asides: [...nextTurnAsides] }),
  }
  return message
}

interface SDKMessageRecord {
  type?: string
  uuid?: string
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  error?: unknown
  message?: {
    content?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getUserTextFromSDKMessage(message: SDKMessage): string | null {
  const sdkMessage = message as unknown as SDKMessageRecord
  if (sdkMessage.type !== 'user' || sdkMessage.parent_tool_use_id || sdkMessage.isSynthetic) {
    return null
  }

  const content = sdkMessage.message?.content
  if (!Array.isArray(content)) return null
  if (content.some((block) => isRecord(block) && block.type === 'tool_result')) return null

  const texts = content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)

  return texts.length > 0 ? texts.join('\n') : null
}

function removeRetriedErrorSDKMessage(messages: SDKMessage[], errorUuid: string | undefined): SDKMessage[] {
  if (!errorUuid) return messages
  const next = messages.filter((message) => {
    const record = message as unknown as SDKMessageRecord
    return !(record.type === 'assistant' && record.uuid === errorUuid && record.error !== undefined && record.error !== null)
  })
  return next.length === messages.length ? messages : next
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStaleAgentQueueError(error: unknown): boolean {
  const message = getErrorMessage(error)
  return message.includes('会话未运行，无法追加消息') ||
    message.includes('无活跃消息通道可注入队列消息') ||
    message.includes('当前会话没有正在运行的 Agent')
}

// ===== 模型与推理强度组合 Popover =====

const OPENAI_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_STANDARD_THINKING_LEVELS = OPENAI_THINKING_LEVELS.slice(0, -1)
type OpenAIThinkingLevel = AgentThinkingLevel
// 档位名称统一使用英文，保持输入栏与弹层状态一致。
/** 思考强度 trigger 显示的英文档位（用户偏好英文展示） */
const OPENAI_THINKING_LABELS_EN: Record<OpenAIThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

const WORKFLOW_PICKER_ICONS: Record<AgentWorkflow, LucideIcon> = {
  'read-only': Telescope,
  'plan-first': ClipboardList,
  direct: Zap,
}

const WORKFLOW_PICKER_OPTIONS: SlashPickerOption[] = AGENT_WORKFLOW_DISPLAY_OPTIONS.map((option) => ({
  ...option,
  icon: WORKFLOW_PICKER_ICONS[option.value],
}))

const FORK_PICKER_OPTIONS: SlashPickerOption[] = [
  { value: 'inherit', label: 'Fork 为普通会话', description: 'Isolated 会话会复制当前修改到独立 Worktree', icon: GitFork },
  { value: 'isolated', label: 'Fork 到 Managed Worktree', description: '在隔离 Worktree 中继续（仅 Local 会话）', icon: GitBranch },
]

function normalizeOpenAIThinkingLevel(
  level: AgentThinkingLevel | undefined,
  levels: readonly OpenAIThinkingLevel[],
): OpenAIThinkingLevel {
  if (level === 'minimal') return 'low'
  // max 会话设置在切到非 GPT-5.6 时由主进程降级为 xhigh；UI 同步展示有效档位。
  if (level === 'max' && !levels.includes('max')) return 'xhigh'
  return levels.includes(level as OpenAIThinkingLevel) ? level as OpenAIThinkingLevel : 'off'
}

interface CodexThinkingConfig {
  thinkingLevel: AgentThinkingLevel
  levels: readonly OpenAIThinkingLevel[]
  onThinkingLevelChange: (level: AgentThinkingLevel) => void | Promise<void>
  /** 仅在 Fast Mode 可用时传入；弹出层内以 Switch 行呈现。 */
  fastMode?: { enabled: boolean; onChange: () => void }
}

interface AgentThinkingPopoverProps {
  agentThinking: import('@domi/shared').ThinkingConfig | undefined
  modelName: string
  modelLogo?: string
  channelName?: string
  onOpenModelSelector: () => void
  onToggle: () => void
  codexConfig?: CodexThinkingConfig
}

function AgentThinkingPopover({
  agentThinking,
  modelName,
  modelLogo,
  channelName,
  onOpenModelSelector,
  onToggle,
  codexConfig,
}: AgentThinkingPopoverProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const isCodex = Boolean(codexConfig)
  const thinkingLevels = codexConfig?.levels ?? OPENAI_STANDARD_THINKING_LEVELS
  const normalizedLevel = normalizeOpenAIThinkingLevel(
    codexConfig?.thinkingLevel,
    thinkingLevels,
  )
  const isEnabled = isCodex ? normalizedLevel !== 'off' : agentThinking?.type === 'adaptive'
  const sliderPosition = Math.max(0, thinkingLevels.indexOf(normalizedLevel))
  const [draftSliderPosition, setDraftSliderPosition] = React.useState<number | null>(null)
  const [reasoningCommitPending, setReasoningCommitPending] = React.useState(false)
  const displayedSliderPosition = draftSliderPosition ?? sliderPosition
  const displayedLevel = thinkingLevels[displayedSliderPosition] ?? normalizedLevel
  const isMaxLevel = displayedLevel === 'max'
  // trigger 只显示当前思考强度的英文档位：Codex 模式显示档位，开关模式显示 On/Off。
  const triggerLabel = isCodex
    ? OPENAI_THINKING_LABELS_EN[normalizedLevel]
    : isEnabled
      ? 'On'
      : 'Off'

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setDraftSliderPosition(null)
      }}
    >
      <Tooltip open={open || !channelName ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              aria-label={`${modelName}，推理强度：${triggerLabel}`}
              className={cn(
                'model-effort-trigger flex h-[26px] min-w-0 max-w-[min(200px,42vw)] shrink items-center gap-1 rounded-full px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                isEnabled && 'text-foreground',
                open && 'bg-accent text-foreground',
              )}
            >
              {modelLogo ? (
                <BrandLogo src={modelLogo} alt="" className="size-4 shrink-0 rounded object-cover" />
              ) : (
                <Cpu className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate">{modelName}</span>
              <span className="shrink-0 text-muted-foreground">{triggerLabel}</span>
              <ChevronDown className={cn('size-3 shrink-0 transition-transform duration-150', open && 'rotate-180')} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">渠道：{channelName}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[290px] overflow-hidden rounded-xl border-border/60 bg-popover/95 p-0 shadow-xl backdrop-blur-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <button
            type="button"
            className="flex h-10 min-w-0 items-center gap-3 px-3 text-left transition-colors hover:bg-accent/70"
            onClick={() => {
              setOpen(false)
              onOpenModelSelector()
            }}
          >
            <span className="shrink-0 text-xs text-muted-foreground">模型</span>
            <span className="ml-auto min-w-0 truncate text-right text-xs font-medium text-foreground">{modelName}</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
          <div className="border-t border-border/60 px-3 py-3">
            {codexConfig ? (
              <>
                <div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs font-medium text-foreground/80">推理强度</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {OPENAI_THINKING_LABELS_EN[displayedLevel]}
                  </span>
                </div>
                <div className="relative my-[7px] h-[30px]">
                  <Slider
                    className="h-[30px]"
                    value={[displayedSliderPosition]}
                    onValueChange={([position]) => setDraftSliderPosition(position ?? sliderPosition)}
                    onValueCommit={([position]) => {
                      const nextPosition = position ?? sliderPosition
                      const nextLevel = thinkingLevels[nextPosition]
                      if (!nextLevel || nextLevel === normalizedLevel) {
                        setDraftSliderPosition(null)
                        return
                      }
                      setReasoningCommitPending(true)
                      void Promise.resolve(codexConfig.onThinkingLevelChange(nextLevel)).finally(() => {
                        setReasoningCommitPending(false)
                        setDraftSliderPosition(null)
                      })
                    }}
                    min={0}
                    max={thinkingLevels.length - 1}
                    step={1}
                    disabled={reasoningCommitPending}
                    aria-label="推理强度"
                    trackClassName="h-[26px] bg-muted"
                    rangeClassName={cn('agent-effort-range', isMaxLevel && 'agent-effort-range-max')}
                    thumbClassName={cn(
                      'agent-effort-thumb z-20 size-[30px] border-0 bg-white shadow-none',
                      isMaxLevel && 'agent-effort-thumb-max',
                    )}
                  />
                  <div className="pointer-events-none absolute inset-x-[15px] top-1/2 z-10 -translate-y-1/2">
                    {thinkingLevels.map((level, index) => (
                      <span
                        key={level}
                        className={cn(
                          'absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full',
                          index <= displayedSliderPosition ? 'bg-white/55' : 'bg-muted-foreground/70',
                        )}
                        style={{ left: `${thinkingLevels.length === 1 ? 0 : (index / (thinkingLevels.length - 1)) * 100}%` }}
                      />
                    ))}
                  </div>
                </div>
                {/* 档位刻度内嵌在滑杆中，保持与参考控件一致的紧凑高度。 */}
                </div>
                {codexConfig.fastMode && (
                <div className="mt-3 flex items-center justify-between gap-4 border-t pt-2.5">
                  <span className="text-xs text-foreground/70">快速模式</span>
                  <Switch
                    checked={codexConfig.fastMode.enabled}
                    onCheckedChange={codexConfig.fastMode.onChange}
                    className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
                  />
                </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs text-foreground/70">思考模式</span>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={onToggle}
                  className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
                />
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function AgentView({ sessionId }: { sessionId: string }): React.ReactElement {
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const useModernComposerRail = interfaceVariant !== 'classic' && themeStyle !== 'terminal-dark'
  const [persistedSDKMessages, setPersistedSDKMessages] = React.useState<SDKMessage[]>([])
  const [sessionTree, setSessionTree] = React.useState<SessionTreeResult | null>(null)
  const [pendingTreeScroll, setPendingTreeScroll] = React.useState<{ index: number; refreshVersion: number } | null>(null)
  const persistedSDKMessagesRef = React.useRef<SDKMessage[]>([])
  const [bottomFollowRevision, setBottomFollowRevision] = React.useState(0)
  const escapeAbortArmedUntilRef = React.useRef<number | null>(null)
  persistedSDKMessagesRef.current = persistedSDKMessages
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  // 按 sessionId 切片订阅：仅本 session 的 streaming state 变化才让 AgentView 重渲染。
  // 流式期间其他 session 的高频更新（每 token 一次）通过 base map atom 传播但派生
  // atom 输出引用未变，订阅者跳过通知。
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const streaming = streamState?.running ?? false
  // 软空闲态：本轮主体已结束、UI 可输入，但 SDK 通道仍开着等后台任务唤醒。
  // 此时服务端 activeSessions 仍保留，新消息须走注入通道而非新建 run。
  const backgroundWaiting = streamState?.backgroundWaiting ?? false
  const stoppedByUserSessions = useAtomValue(stoppedByUserSessionsAtom)
  const sendWithCmdEnter = useAtomValue(sendWithCmdEnterAtom)
  const longTextPasteAsAttachmentEnabled = useAtomValue(longTextPasteAsAttachmentEnabledAtom)
  const stoppedByUser = stoppedByUserSessions.has(sessionId)
  // 按 sessionId 切片订阅：后台 Agent 的 partial frame 不再触发当前 AgentView 重渲染。
  const liveMessages = useAtomValue(agentLiveMessagesAtomFamily(sessionId))
  const currentRuntimeProviderUsage = React.useMemo(
    () => getAgentRuntimeProviderUsageSnapshot(liveMessages, streamState?.startedAt),
    [liveMessages, streamState?.startedAt],
  )
  const runtimeProviderUsageRef = React.useRef({
    startedAt: streamState?.startedAt,
    usage: currentRuntimeProviderUsage,
  })
  if (streamState?.startedAt !== undefined && runtimeProviderUsageRef.current.startedAt !== streamState.startedAt) {
    runtimeProviderUsageRef.current = { startedAt: streamState.startedAt, usage: currentRuntimeProviderUsage }
  } else if (currentRuntimeProviderUsage.providerRequestCount > 0) {
    runtimeProviderUsageRef.current = { startedAt: streamState?.startedAt, usage: currentRuntimeProviderUsage }
  }
  const runtimeProviderUsage = currentRuntimeProviderUsage.providerRequestCount > 0
    ? currentRuntimeProviderUsage
    : runtimeProviderUsageRef.current.usage
  const runtimeRailState = useAgentRuntimeRailState({
    enabled: useModernComposerRail,
    scopeKey: sessionId,
    streaming,
    startedAt: streamState?.startedAt,
    providerUsage: runtimeProviderUsage,
  })
  const setLiveMessagesMap = useSetAtom(liveMessagesMapAtom)
  // Per-session 渠道/模型配置（优先读 session map，回退到全局默认值）
  const sessionChannelMap = useAtomValue(agentSessionChannelMapAtom)
  const sessionModelMap = useAtomValue(agentSessionModelMapAtom)
  const setSessionChannelMap = useSetAtom(agentSessionChannelMapAtom)
  const setSessionModelMap = useSetAtom(agentSessionModelMapAtom)
  const [defaultChannelId, setDefaultChannelId] = useAtom(agentChannelIdAtom)
  const [defaultModelId, setDefaultModelId] = useAtom(agentModelIdAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const planningGroups = useAtomValue(todoPlanningGroupsAtom)
  const [todoDialogOpen, setTodoDialogOpen] = React.useState(false)
  const [todoDraftTitle, setTodoDraftTitle] = React.useState('')
  const [todoSourceText, setTodoSourceText] = React.useState('')
  const [todoGroupId, setTodoGroupId] = React.useState('__none__')
  const [creatingTodo, setCreatingTodo] = React.useState(false)
  React.useEffect(() => window.electronAPI.onPlanningAgentOperation((operation) => {
    if (operation.sessionId !== sessionId) return
    const target = operation.target === 'todo' ? 'Todo' : '日程'
    const action = operation.action === 'created' ? '创建' : operation.action === 'updated' ? '更新' : '删除'
    toast.success(`已${action}${target}`, { description: `「${operation.title}」` })
  }), [sessionId])
  const sessionMeta = React.useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  )
  const sessionMetaChannelId = sessionMeta?.channelId
  const sessionMetaModelId = sessionMeta?.modelId
  const hasSessionMeta = Boolean(sessionMeta)
  const agentChannelId = sessionMetaChannelId ?? sessionChannelMap.get(sessionId) ?? defaultChannelId
  const agentModelId = sessionMetaModelId ?? sessionModelMap.get(sessionId) ?? defaultModelId
  const [agentThinking, setAgentThinking] = useAtom(agentThinkingAtom)
  const agentEffort = useAtomValue(agentEffortAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const [draftSessionIds, setDraftSessionIds] = useAtom(draftSessionIdsAtom)
  const globalWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  // 从会话元数据派生 workspaceId：会话数据已加载时以自身为准，未加载时回退全局 atom
  const currentWorkspaceId = React.useMemo(() => {
    if (!sessionMeta) return globalWorkspaceId // 数据未加载，回退全局
    return sessionMeta.workspaceId ?? null     // 数据已加载，以会话自身为准
  }, [sessionMeta, globalWorkspaceId])
  const [pendingPrompt, setPendingPrompt] = useAtom(agentPendingPromptAtom)
  const [pendingFiles, setPendingFiles] = useAtom(agentPendingFilesAtomFamily(sessionId))
  const [queuedMessages, setQueuedMessages] = useAtom(agentMessageQueueAtomFamily(sessionId))
  const visibleQueuedMessages = React.useMemo(() => getVisibleQueuedMessages(queuedMessages), [queuedMessages])
  // 同一渲染帧内快速连续发送时，React 闭包仍可能看到旧队列；用稳定 ID 集防止同一附言绑定到两条消息。
  const consumedAsideIdsRef = React.useRef<Set<string>>(new Set())
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setWorkspaces = useSetAtom(agentWorkspacesAtom)
  const [restoreProjectRootDialogOpen, setRestoreProjectRootDialogOpen] = React.useState(false)
  const [restoringProjectRoot, setRestoringProjectRoot] = React.useState(false)
  // 保持 channelId 稳定：初始化前使用上次有效值，避免工具栏抖动
  const stableChannelIdRef = React.useRef(agentChannelId)
  if (agentChannelId) stableChannelIdRef.current = agentChannelId
  const stableChannelId = agentChannelId ?? stableChannelIdRef.current

  // 已有会话首次打开时，从会话元数据初始化 per-session map。
  // setter 内的 `prev.has(sessionId)` 守卫保证幂等，外层不再订阅 Map atom，
  // 避免 setter 写入 → atom 引用变化 → effect 重跑的自循环（React #185）。
  const sessionTargetState = useAtomValue(sessionTargetStateAtomFamily(sessionId))
  const sessionWorktreePending = useAtomValue(sessionTargetWorktreePendingAtomFamily(sessionId))
  const bindSessionTarget = useSetAtom(bindSessionTargetAtomFamily(sessionId))
  // 是否已绑定 Session Target：首次发送前（未绑定）只能预览/引用 Local 项目文件；
  // @ 引用回退搜索与文件树均需区分该状态。
  const hasBoundSessionTarget = sessionTargetState.snapshot !== null
    || (hasSessionMeta && sessionMeta?.sessionTarget?.kind !== 'unselected')
  const setTabs = useSetAtom(tabsAtom)
  const initialWorktreePreparationRef = React.useRef(false)
  const [initialWorktreePreparing, setInitialWorktreePreparing] = React.useState(false)
  const deferredWorkspaceSendRef = React.useRef<DeferredWorkspaceSendRequest | null>(null)
  const [workspaceSendDeferred, setWorkspaceSendDeferred] = React.useState(false)
  const sessionTargetInteraction = getSessionTargetInteraction({
    hasTarget: sessionTargetState.snapshot !== null,
    selectionRequired: sessionTargetState.selectionRequired
      || sessionMeta?.sessionTarget?.kind === 'unselected',
  })
  // 只有会话元数据尚未加载时，才允许使用全局默认值初始化新会话。
  React.useEffect(() => {
    if (!sessionId) return
    const initialChannelId = sessionMetaChannelId ?? (!hasSessionMeta ? defaultChannelId : undefined)
    const initialModelId = sessionMetaModelId ?? (!hasSessionMeta ? defaultModelId : undefined)
    if (initialChannelId) {
      setSessionChannelMap((prev) => {
        if (prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.set(sessionId, initialChannelId)
        return map
      })
    }
    if (initialModelId) {
      setSessionModelMap((prev) => {
        if (prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.set(sessionId, initialModelId)
        return map
      })
    }
  }, [sessionId, sessionMetaChannelId, sessionMetaModelId, hasSessionMeta, defaultChannelId, defaultModelId, setSessionChannelMap, setSessionModelMap])

  const sessionCacheMetrics = React.useMemo(
    () => calculateAgentSessionCacheMetrics(persistedSDKMessages, liveMessages),
    [persistedSDKMessages, liveMessages],
  )
  const sessionUsage = React.useMemo(
    () => calculateAgentSessionUsage(persistedSDKMessages),
    [persistedSDKMessages],
  )

  const contextStatus: AgentContextStatus = {
    isCompacting: streamState?.isCompacting ?? false,
    inputTokens: streamState?.inputTokens,
    outputTokens: streamState?.outputTokens,
    cacheReadTokens: streamState?.cacheReadTokens,
    cacheCreationTokens: streamState?.cacheCreationTokens,
    costUsd: streamState?.costUsd,
    contextBreakdown: streamState?.contextBreakdown,
    contextWindow: streamState?.contextWindow,
    contextWindowSource: streamState?.contextWindowSource,
    contextWindowOwner: streamState?.contextWindowOwner,
    contextUsageIsEstimated: streamState?.contextUsageIsEstimated,
    contextUsageInvalidated: streamState?.contextUsageInvalidated,
  }
  const setAgentStreamErrors = useSetAtom(agentStreamErrorsAtom)
  const streamErrors = useAtomValue(agentStreamErrorsAtom)
  const agentError = streamErrors.get(sessionId) ?? null
  const executionControls = useAtomValue(agentSessionExecutionControlsAtomFamily(sessionId))
  const planModeSessions = useAtomValue(agentPlanModeSessionsAtom)
  const isPlanMode = executionControls.workflow === 'plan-first' || planModeSessions.has(sessionId)
  const permissionModeMap = useAtomValue(agentPermissionModeMapAtom)
  const defaultPermissionMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedPermissionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const permissionMode = permissionModeMap.get(sessionId) ?? persistedPermissionMode ?? defaultPermissionMode
  const isPermissionPlanMode = permissionMode === 'plan'
  const store = useStore()
  const currentQuotedSelection = useAtomValue(currentQuotedSelectionAtom)
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const openPreview = useOpenPreview()

  /** 移除当前引用选中文本 */
  const handleRemoveQuotedSelection = React.useCallback(() => {
    setQuotedSelectionMap((prev) => {
      const m = new Map(prev)
      m.delete(sessionId)
      return m
    })
  }, [sessionId, setQuotedSelectionMap])

  /** 消费当前引用选区，用于把引用快照固定到本次发送/队列消息中 */
  const consumeQuotedSelection = React.useCallback((): QuotedSelection | null => {
    const quotedSelection = store.get(quotedSelectionMapAtom).get(sessionId) ?? null
    if (!quotedSelection) return null

    const capturedAt = quotedSelection.capturedAt
    store.set(quotedSelectionMapAtom, (prev) => {
      const m = new Map(prev)
      const current = m.get(sessionId)
      if (current && current.capturedAt === capturedAt) m.delete(sessionId)
      return m
    })
    return quotedSelection
  }, [sessionId, store])

  const suggestionsMap = useAtomValue(agentPromptSuggestionsAtom)
  const suggestion = suggestionsMap.get(sessionId) ?? null
  const setPromptSuggestions = useSetAtom(agentPromptSuggestionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setSidebarViewMode = useSetAtom(sidebarViewModeAtom)
  const openSession = useOpenSession()
  const setAttachedDirsMap = useSetAtom(agentAttachedDirectoriesMapAtom)
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? []
  const setAttachedFilesMap = useSetAtom(agentAttachedFilesMapAtom)
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const attachedFiles = attachedFilesMap.get(sessionId) ?? []
  const wsAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const wsAttachedDirs = currentWorkspaceId ? (wsAttachedDirsMap.get(currentWorkspaceId) ?? []) : []
  const setWsAttachedFilesMap = useSetAtom(workspaceAttachedFilesMapAtom)
  const wsAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const wsAttachedFiles = currentWorkspaceId ? (wsAttachedFilesMap.get(currentWorkspaceId) ?? []) : []

  // 按 sessionId 切片订阅 drafts/draftHtml：仅本 session 草稿变化才让 AgentView 重渲染。
  // 输入框每次按键都会写整 Map atom，若直接订阅整 Map，AgentView 跟着每键重渲染。
  const inputContent = useAtomValue(agentSessionDraftAtomFamily(sessionId))
  const setDraftsMap = useSetAtom(agentSessionDraftsAtom)
  const setInputContent = React.useCallback((value: string) => {
    setDraftsMap((prev) => {
      const map = new Map(prev)
      if (value.trim() === '') {
        map.delete(sessionId)
      } else {
        map.set(sessionId, value)
      }
      return map
    })
  }, [sessionId, setDraftsMap])
  const inputHtmlContent = useAtomValue(agentSessionDraftHtmlAtomFamily(sessionId))
  const setDraftHtmlMap = useSetAtom(agentSessionDraftHtmlAtom)
  const setInputHtmlContent = React.useCallback((html: string) => {
    setDraftHtmlMap((prev) => {
      const map = new Map(prev)
      if (!html || html === '<p></p>') {
        map.delete(sessionId)
      } else {
        map.set(sessionId, html)
      }
      return map
    })
  }, [sessionId, setDraftHtmlMap])

  const createTodoForCurrentSession = React.useCallback(async (title: string, groupId: string, sourceText?: string): Promise<boolean> => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) {
      toast.error('Todo 标题不能为空')
      return false
    }
    if (normalizedTitle.length > 500) {
      toast.error('Todo 标题不能超过 500 字')
      return false
    }

    try {
      await window.electronAPI.createTodo({
        title: normalizedTitle,
        notes: sourceText?.trim() && sourceText.trim() !== normalizedTitle ? sourceText.trim() : undefined,
        dueAt: endOfToday(),
        groupId: groupId === '__none__' ? undefined : groupId,
        sessionId,
        workspaceId: currentWorkspaceId ?? undefined,
      })
      toast.success('已添加 Todo', { description: '已关联当前 Agent 会话' })
      return true
    } catch (error) {
      console.error('[AgentView] 创建 Todo 失败:', error)
      toast.error('创建 Todo 失败', { description: String(error) })
      return false
    }
  }, [currentWorkspaceId, sessionId])

  const handleOpenReplyTodoDialog = React.useCallback((text: string): void => {
    const sourceText = text.trim()
    const firstLine = sourceText.split('\n').map((line) => line.trim()).find(Boolean) ?? sourceText
    setTodoSourceText(sourceText)
    setTodoDraftTitle(firstLine.replace(/^#{1,6}\s+/, '').slice(0, 500))
    setTodoGroupId('__none__')
    setTodoDialogOpen(true)
  }, [])

  const handleCreateReplyTodo = React.useCallback(async (): Promise<void> => {
    setCreatingTodo(true)
    try {
      if (await createTodoForCurrentSession(todoDraftTitle, todoGroupId, todoSourceText)) {
        setTodoDialogOpen(false)
      }
    } finally {
      setCreatingTodo(false)
    }
  }, [createTodoForCurrentSession, todoDraftTitle, todoGroupId, todoSourceText])

  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const setSessionPathMap = useSetAtom(agentSessionPathMapAtom)
  const sessionPath = sessionPathMap.get(sessionId) ?? null
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [errorCopied, setErrorCopied] = React.useState(false)
  const [retryNowPending, setRetryNowPending] = React.useState(false)
  const [attachmentMenuOpen, setAttachmentMenuOpen] = React.useState(false)

  // pendingFiles ref（供 addFilesAsAttachments 读取最新列表，避免闭包旧值）
  const pendingFilesRef = React.useRef(pendingFiles)
  // RichTextInput 命令接口 ref（右侧文件面板拖入时插入 @file 引用）
  const richTextInputRef = React.useRef<RichTextInputHandle>(null)
  const restoreComposerFocus = React.useCallback((): void => {
    richTextInputRef.current?.focus()
  }, [])
  React.useEffect(() => {
    pendingFilesRef.current = pendingFiles
  }, [pendingFiles])

  // 渠道已选但模型未选时，自动选择第一个可用模型
  const globalChannels = useAtomValue(channelsAtom)
  const stableChannel = React.useMemo(
    () => stableChannelId ? globalChannels.find((channel) => channel.id === stableChannelId) : undefined,
    [globalChannels, stableChannelId],
  )
  const planQuotaChannelId = stableChannel && supportsChannelPlanQuota(stableChannel)
    ? stableChannel.id
    : null
  const planQuotaChannelUpdatedAt = planQuotaChannelId ? stableChannel?.updatedAt : undefined
  const agentChannelProvider = React.useMemo(
    () => globalChannels.find((c) => c.id === agentChannelId)?.provider,
    [globalChannels, agentChannelId],
  )
  const contextUsageTarget = React.useMemo<AgentContextUsageTarget>(() => ({
    runtime: 'pi',
    channelId: agentChannelId || undefined,
    modelId: agentModelId || undefined,
    provider: agentChannelProvider,
  }), [agentChannelId, agentModelId, agentChannelProvider])
  const contextUsageTargetKey = `${buildAgentContextWindowOwner(
    contextUsageTarget.runtime,
    contextUsageTarget.channelId,
    contextUsageTarget.modelId,
  )}:${contextUsageTarget.provider ?? ''}`
  const isCodexFastModeAvailable = hasSessionMeta
    && agentChannelProvider === 'openai-codex'
    && isCodexFastModeSupportedModel(agentModelId ?? undefined)
  const codexFastModeEnabled = isCodexFastModeAvailable && sessionMeta?.codexFastMode === true
  // 模型呈现预设：极简 = 固定提示词 + 仅 Bash/Edit（评测控制变量），与 provider 无关。
  const minimalPresetEnabled = sessionMeta?.modelPresentationPreset === 'minimal'
  const reasoningProfile = hasSessionMeta
    ? resolveReasoningProfile({
      modelId: agentModelId ?? undefined,
      transport: inferReasoningTransport(agentChannelProvider),
    })
    : undefined
  const reasoningCapabilityKey = `pi:${agentChannelId ?? ''}:${agentModelId ?? ''}`
  const [piReasoningCapability, setPiReasoningCapability] = React.useState<{
    key: string
    capability: ReasoningCapability | undefined
  }>({ key: '', capability: undefined })
  React.useEffect(() => {
    if (!hasSessionMeta || !agentChannelId || !agentModelId) {
      setPiReasoningCapability({ key: reasoningCapabilityKey, capability: undefined })
      return
    }

    let cancelled = false
    void window.electronAPI.getPiReasoningCapability(agentChannelId, agentModelId)
      .then((capability) => {
        if (!cancelled) setPiReasoningCapability({ key: reasoningCapabilityKey, capability })
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[AgentView] 读取 Pi reasoning capability 失败:', error)
          setPiReasoningCapability({ key: reasoningCapabilityKey, capability: undefined })
        }
      })
    return () => { cancelled = true }
  }, [agentChannelId, agentModelId, hasSessionMeta, reasoningCapabilityKey, globalChannels])

  const effectiveReasoningCapability = piReasoningCapability.key === reasoningCapabilityKey
    ? piReasoningCapability.capability
    : resolveReasoningCapability({ profile: reasoningProfile })
  const isSessionThinkingAvailable = Boolean(effectiveReasoningCapability)
  const openAIThinkingLevels = effectiveReasoningCapability?.levels ?? OPENAI_STANDARD_THINKING_LEVELS
  const fallbackOpenAIThinkingLevel: AgentThinkingLevel = agentEffort === 'max'
    ? 'xhigh'
    : agentEffort ?? (agentThinking?.type === 'adaptive' ? 'medium' : 'off')
  const persistedReasoningLevel = sessionMeta?.reasoningLevel ?? sessionMeta?.openAIThinkingLevel
  const capabilityDefaultLevel = effectiveReasoningCapability
    && (effectiveReasoningCapability.source === 'temporary-adaptation'
      || effectiveReasoningCapability.source === 'provider-metadata')
    ? effectiveReasoningCapability.defaultLevel
    : fallbackOpenAIThinkingLevel
  const normalizedReasoningLevel = normalizeReasoningCapabilityLevel(
    effectiveReasoningCapability, persistedReasoningLevel ?? capabilityDefaultLevel,
  )
  const openAIThinkingLevel = normalizedReasoningLevel ?? (persistedReasoningLevel ?? fallbackOpenAIThinkingLevel)

  // 检查 Agent 渠道列表中是否存在可用的模型（渠道 enabled + 模型 enabled）
  const hasAvailableModel = React.useMemo(
    () => globalChannels.some((channel) => channel.enabled && channel.models.some((model) => model.enabled)),
    [globalChannels],
  )
  const deliveryState = sessionTargetState.snapshot?.delivery?.state
  const forcedReadOnlyReason = deliveryState === 'preview_active'
    ? 'preview_active' as const
    : deliveryState === 'retained'
      ? 'retained' as const
      : deliveryState === 'delivered' || deliveryState === 'finalized'
        ? 'delivered' as const
        : undefined
  const worktreeRailPriority = resolveWorktreeRailPriority(sessionTargetState.snapshot?.delivery, {
    preflightStatus: sessionTargetState.preflight?.status,
    preflightBlockedReason: sessionTargetState.preflight?.status === 'blocked'
      ? sessionTargetState.preflight.reason
      : undefined,
    checkoutPhase: sessionTargetState.snapshot?.checkout.phase,
  })
  const hasAgentIssue = agentError !== null || isAgentRetryIssue(streamState?.retrying)
  const runtimeSummary = runtimeRailState.summary
  const composerActionRailKind = resolveComposerActionRailKind({
    modern: useModernComposerRail,
    hasUrgentWorktreeAction: worktreeRailPriority === 'urgent',
    hasActiveWorktreeAction: worktreeRailPriority === 'active',
    hasAgentIssue,
    hasAgentRuntime: streaming,
    hasAgentSummary: runtimeSummary !== null,
    hasChannelSetupAction: !agentChannelId || !hasAvailableModel,
    hasSettledWorktreeAction: worktreeRailPriority === 'settled',
  })
  const runtimeRailOwnsRunningIndicator = composerRailOwnsRunningIndicator(composerActionRailKind)
  React.useEffect(() => {
    if (!agentChannelId || agentModelId) return

    const channel = globalChannels.find((c) => c.id === agentChannelId && c.enabled)
    if (!channel) return

    const firstModel = channel.models.find((m) => m.enabled)
    if (!firstModel) return

    // 更新 per-session map（带幂等守卫，避免无意义写入导致 effect 自循环）
    setSessionModelMap((prev) => {
      if (prev.get(sessionId) === firstModel.id) return prev
      const map = new Map(prev)
      map.set(sessionId, firstModel.id)
      return map
    })
    // 全局默认值 + 持久化 IPC 也加幂等：firstModel 与当前 defaultModelId 相同时跳过，
    // 避免每次 agentChannelId / globalChannels 变化都重复写盘和触发 agentModelIdAtom 更新。
    if (defaultModelId !== firstModel.id) {
      setDefaultModelId(firstModel.id)
      window.electronAPI.updateSettings({
        agentChannelId,
        agentModelId: firstModel.id,
      }).catch(console.error)
    }
  }, [agentChannelId, agentModelId, globalChannels, sessionId, setSessionModelMap, setDefaultModelId])

  // 获取当前 session 的工作路径（文件浏览器需要）
  React.useEffect(() => {
    if (!currentWorkspaceId) {
      setSessionPathMap((prev) => {
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })
      return
    }

    window.electronAPI
      .getAgentSessionPath(currentWorkspaceId, sessionId)
      .then((path) => {
        if (path) {
          setSessionPathMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, path)
            return map
          })
        } else {
          setSessionPathMap((prev) => {
            const map = new Map(prev)
            map.delete(sessionId)
            return map
          })
        }
      })
      .catch(() => {
        setSessionPathMap((prev) => {
          const map = new Map(prev)
          map.delete(sessionId)
          return map
        })
      })
  }, [sessionId, currentWorkspaceId, setSessionPathMap])

  // 获取工作区共享文件目录路径（@ 引用时需要搜索）
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId)
  const workspaceSlug = currentWorkspace?.slug ?? null
  const projectRootPath = currentWorkspace?.projectRootPath ?? null
  React.useEffect(() => {
    let disposed = false

    // 同一项目重新关联本地根时 slug 保持不变，必须立即废弃旧路径与旧请求结果。
    setWorkspaceFilesPath(null)
    if (!workspaceSlug) return

    window.electronAPI
      .getWorkspaceFilesPath(workspaceSlug)
      .then((path) => {
        if (!disposed) setWorkspaceFilesPath(path)
      })
      .catch(() => {
        if (!disposed) setWorkspaceFilesPath(null)
      })

    return () => {
      disposed = true
    }
  }, [workspaceSlug, projectRootPath])

  // 获取工作区级附加文件（@ 引用和路径解析都需要）
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI
      .getWorkspaceAttachedFiles(workspaceSlug)
      .then((files) => {
        setWsAttachedFilesMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, files)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // 工作区级目录（workspace shared files + 工作区级附加目录），@ 引用标记为工作区文件
  const workspaceDirs = React.useMemo(() => {
    const dirs: string[] = []
    if (workspaceFilesPath) dirs.push(workspaceFilesPath)
    for (const d of wsAttachedDirs) {
      if (!dirs.includes(d)) dirs.push(d)
    }
    return dirs
  }, [workspaceFilesPath, wsAttachedDirs])

  const attachedFileDirectories = React.useMemo(() => {
    const dirs: string[] = []
    for (const filePath of [...attachedFiles, ...wsAttachedFiles]) {
      const parent = getFileParentPath(filePath)
      if (parent && !dirs.includes(parent)) dirs.push(parent)
    }
    return dirs
  }, [attachedFiles, wsAttachedFiles])

  const workspaceMentionPaths = React.useMemo(() => {
    const paths = [...workspaceDirs]
    for (const filePath of wsAttachedFiles) {
      if (!paths.includes(filePath)) paths.push(filePath)
    }
    return paths
  }, [workspaceDirs, wsAttachedFiles])

  const sessionMentionPaths = React.useMemo(() => {
    const paths = [...attachedDirs]
    for (const filePath of attachedFiles) {
      if (!paths.includes(filePath)) paths.push(filePath)
    }
    return paths
  }, [attachedDirs, attachedFiles])

  // 合并会话级 + 工作区级附加目录，供消息区文件路径解析使用
  const allAttachedDirs = React.useMemo(() => {
    const dirs = [...attachedDirs]
    for (const d of workspaceDirs) {
      if (d && !dirs.includes(d)) dirs.push(d)
    }
    for (const filePath of [...attachedFiles, ...wsAttachedFiles]) {
      if (filePath && !dirs.includes(filePath)) dirs.push(filePath)
      const parent = getFileParentPath(filePath)
      if (parent && !dirs.includes(parent)) dirs.push(parent)
    }
    return dirs
  }, [attachedDirs, workspaceDirs, attachedFiles, wsAttachedFiles])

  const createBaseAdditionalDirectories = React.useCallback((): Set<string> => {
    const dirs = new Set(attachedDirs)
    for (const dir of attachedFileDirectories) {
      dirs.add(dir)
    }
    return dirs
  }, [attachedDirs, attachedFileDirectories])

  // 监听消息刷新版本号
  const refreshMap = useAtomValue(agentMessageRefreshAtom)
  const refreshVersion = refreshMap.get(sessionId) ?? 0

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.getSessionTree(sessionId)
      .then((tree) => { if (!cancelled) setSessionTree(tree) })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[AgentView] 读取 Session Tree 失败:', error)
          setSessionTree(null)
        }
      })
    return () => { cancelled = true }
  }, [refreshVersion, sessionId])

  // 持久化消息缓存 setter — 仅写入，读取时用 store.get 同步取值避免订阅触发重渲染
  const setMessagesCache = useSetAtom(agentSDKMessagesCacheAtom)
  // Skill 触发映射 setter — 历史会话拉取明细后合并，实时事件由全局监听器写入
  const setSkillTriggersMap = useSetAtom(skillTriggersByToolCallAtom)
  const appendOptimisticPersistedMessage = React.useCallback((message: SDKMessage) => {
    // 切会话时优先命中内存缓存，因此乐观插入的用户消息也要同步写入缓存，
    // 否则“发送后立刻切走再切回”会短暂回退到旧消息数组。
    const next = [...persistedSDKMessagesRef.current, message]
    persistedSDKMessagesRef.current = next
    setPersistedSDKMessages(next)
    setMessagesCache((prev) => setSessionMessagesCache(prev, sessionId, next))
    setBottomFollowRevision((revision) => revision + 1)
  }, [sessionId, setMessagesCache])

  const requestBottomFollow = React.useCallback(() => {
    setBottomFollowRevision((revision) => revision + 1)
  }, [])

  const appendLiveUserMessage = React.useCallback((message: SDKMessage) => {
    store.set(liveMessagesMapAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(sessionId) ?? []
      const messageUuid = (message as { uuid?: string }).uuid
      if (messageUuid && current.some((item) => (item as { uuid?: string }).uuid === messageUuid)) {
        return prev
      }
      map.set(sessionId, [...current, message])
      return map
    })
  }, [sessionId, store])


  const clearStoppedByUser = React.useCallback(() => {
    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [sessionId, store])

  const queueMessageIntoActiveAgent = React.useCallback(async (
    message: AgentQueuedMessage,
    rawText: string,
    sdkText: string,
    mentions: ReturnType<typeof parseQueuedMessageMentions>,
    interruptCurrentTurn: boolean,
    queueKind?: AgentQueueMessageKind,
  ): Promise<void> => {
    // 气泡显示用原文 text（保留 /skill:、#mcp:、&session:、&todo: 和 &calendar_event: 语法），
    // 让 message.tsx 的 remarkMentions 立即渲染出引用芯片；
    // 剥离后的 sdkText 仅用于传给 SDK，不作为展示文本。
    const isNativePiQueue = !interruptCurrentTurn && queueKind !== undefined
    if (!agentChannelId) throw new Error('当前会话尚未选择可用渠道')
    requestBottomFollow()

    const result = await window.electronAPI.submitOrEnqueueAgentMessage({
      sessionId,
      queueMessageId: message.id,
      queueKind,
      userMessage: sdkText,
      rawUserMessage: rawText,
      userMessageUuid: message.id,
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      additionalDirectories: message.additionalDirectories,
      dispatch: 'now',
      interrupt: interruptCurrentTurn,
      ...buildAgentSendControlOverrides(executionControls),
      ...(message.nextTurnAsides?.length ? { nextTurnAsides: message.nextTurnAsides } : {}),
      ...(mentions.mentionedSkills.length > 0 && { mentionedSkills: mentions.mentionedSkills }),
      ...(mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: mentions.mentionedMcpServers }),
      ...(mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: mentions.mentionedSessionIds }),
      ...(mentions.mentionedTodoIds.length > 0 && { mentionedTodoIds: mentions.mentionedTodoIds }),
      ...(mentions.mentionedCalendarEventIds.length > 0 && { mentionedCalendarEventIds: mentions.mentionedCalendarEventIds }),
    })

    if (result.disposition === 'injected') {
      if (!isNativePiQueue) {
        appendLiveUserMessage(createUserSDKMessage(rawText, message.id, Date.now(), message.nextTurnAsides))
      }
      return
    }

    // main 已接管消息。若仍等待当前 run，保留可编辑投影；若已同步启动，started 事件
    // 已负责移除卡片，不能在 IPC 响应回来后把它重新加回。
    setQueuedMessages((current) => reconcileSubmittedQueuedMessage(current, message, result))
  }, [
    agentChannelId,
    agentModelId,
    appendLiveUserMessage,
    currentWorkspaceId,
    executionControls,
    requestBottomFollow,
    sessionId,
    setQueuedMessages,
  ])

  const startQueuedMessageRun = React.useCallback(async (
    text: string,
    mentions: ReturnType<typeof parseQueuedMessageMentions>,
    channelId: string,
    queuedAdditionalDirectories: string[] = [],
    nextTurnAsides: AgentNextTurnAside[] = [],
  ): Promise<void> => {
    const streamStartedAt = Date.now()
    const additionalDirectoriesForRun = createBaseAdditionalDirectories()
    for (const dir of queuedAdditionalDirectories) {
      additionalDirectoriesForRun.add(dir)
    }
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      const modelId = agentModelId || undefined
      const contextWindowOwner = buildAgentContextWindowOwner('pi', channelId, modelId)
      const canReuseContextWindow = existing?.contextWindowOwner === contextWindowOwner
      const contextWindow = resolveRunContextWindow(
        modelId,
        agentChannelProvider,
        existing?.contextWindow,
        existing?.contextWindowOwner,
        contextWindowOwner,
      )
      map.set(sessionId, {
        running: true,
        toolActivities: [],
        model: modelId,
        startedAt: streamStartedAt,
        inputTokens: existing?.inputTokens,
        contextWindow,
        contextWindowSource: canReuseContextWindow
          ? existing?.contextWindowSource
          : contextWindow != null ? 'name_fallback' : undefined,
        contextWindowOwner,
      })
      return map
    })

    appendOptimisticPersistedMessage(createUserSDKMessage(text, undefined, streamStartedAt, nextTurnAsides))

    try {
      await window.electronAPI.sendAgentMessage({
        sessionId,
        userMessage: text,
        ...(nextTurnAsides.length > 0 && { nextTurnAsides }),
        channelId,
        modelId: agentModelId || undefined,
        workspaceId: currentWorkspaceId || undefined,
        startedAt: streamStartedAt,
        ...buildAgentSendControlOverrides(executionControls),
        ...(additionalDirectoriesForRun.size > 0 && {
          additionalDirectories: Array.from(additionalDirectoriesForRun),
        }),
        ...(mentions.mentionedSkills.length > 0 && { mentionedSkills: mentions.mentionedSkills }),
        ...(mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: mentions.mentionedMcpServers }),
        ...(mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: mentions.mentionedSessionIds }),
        ...(mentions.mentionedTodoIds.length > 0 && { mentionedTodoIds: mentions.mentionedTodoIds }),
        ...(mentions.mentionedCalendarEventIds.length > 0 && { mentionedCalendarEventIds: mentions.mentionedCalendarEventIds }),
      })
    } catch (error) {
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current) return prev
        const map = new Map(prev)
        map.set(sessionId, { ...current, running: false })
        return map
      })
      throw error
    }
  }, [
    agentModelId,
    appendOptimisticPersistedMessage,
    createBaseAdditionalDirectories,
    currentWorkspaceId,
    executionControls,
    permissionMode,
    agentChannelProvider,
    sessionId,
    setStreamingStates,
  ])

  const sendPlainTextAgentMessage = React.useCallback(async (
    message: AgentQueuedMessage,
    queueKind?: AgentQueueMessageKind,
  ): Promise<void> => {
    const quotedSelectionBlock = message.quotedSelection
      ? buildQuotedSelectionBlock(message.quotedSelection)
      : ''
    const payload = buildQueuedMessageSendPayload(message, quotedSelectionBlock)
    if (!payload.rawText || !agentChannelId || !hasAvailableModel) return

    clearStoppedByUser()

    // 发起新一轮（含队列消息自动发送、后台续轮注入等非用户显式路径）时，
    // 清除上一轮遗留的流式错误，避免正常输出后底部仍残留旧报错。
    setAgentStreamErrors((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // interrupt 由本函数读到的实时 streaming 决定，而非调用方传入的快照：
    // - streaming（本轮真正进行中）：注入前需软中断当前 turn
    // - backgroundWaiting（软空闲，无活跃 turn）：直接注入，无需中断
    // 避免"外层判定 streaming、内层已结束"两个快照不一致导致的竞态。
    if (streaming || backgroundWaiting) {
      await queueMessageIntoActiveAgent(message, payload.rawText, payload.sdkText, payload.mentions, streaming, queueKind)
      return
    }

    await startQueuedMessageRun(payload.rawText, payload.mentions, agentChannelId, message.additionalDirectories, message.nextTurnAsides)
  }, [
    agentChannelId,
    backgroundWaiting,
    clearStoppedByUser,
    hasAvailableModel,
    queueMessageIntoActiveAgent,
    sessionId,
    setAgentStreamErrors,
    startQueuedMessageRun,
    streaming,
  ])

  // 消息是否已完成首次加载（用于 auto-send 等待）
  const [messagesLoaded, setMessagesLoaded] = React.useState(false)
  const [messagesRefreshing, setMessagesRefreshing] = React.useState(false)
  const messagesRefreshingRef = React.useRef(false)
  const loadingSessionIdRef = React.useRef<string | null>(null)
  const messagesLoadedSessionIdRef = React.useRef<string | null>(null)

  // 加载当前会话消息
  React.useEffect(() => {
    // 只有切换会话时才进入 loading 态；同一会话在流式完成后的刷新要保留当前
    // persisted/live 消息，避免“助手气泡先消失、持久化消息再恢复”的空窗跳动。
    const isSessionSwitch = loadingSessionIdRef.current !== sessionId
    if (isSessionSwitch) {
      loadingSessionIdRef.current = sessionId
      // 命中缓存则立即填充，消除「先清空 → 等 IPC 全量读盘」的可见空窗；
      // IPC 返回后仍会以最新数据覆盖。未命中才回退到清空 + loading 态。
      // 注意：refreshVersion bump（流结束/出错/rewind）不是会话切换，
      // 走 else 分支保留当前消息，并在下方 IPC 覆盖时获得最新数据。
      const cached = store.get(agentSDKMessagesCacheAtom).get(sessionId)
      if (cached) {
        persistedSDKMessagesRef.current = cached
        messagesLoadedSessionIdRef.current = sessionId
        setPersistedSDKMessages(cached)
        setMessagesLoaded(true)
      } else {
        persistedSDKMessagesRef.current = []
        messagesLoadedSessionIdRef.current = null
        setPersistedSDKMessages([])
        setMessagesLoaded(false)
      }
    }
    messagesRefreshingRef.current = true
    setMessagesRefreshing(true)
    let cancelled = false
    window.electronAPI.getAgentSessionSDKMessages(sessionId)
      .then((sdkMsgs) => {
        if (cancelled) return
        // 写入缓存（含 LRU 淘汰，防止会话数增长导致内存无限膨胀）
        setMessagesCache((prev) => setSessionMessagesCache(prev, sessionId, sdkMsgs))
        // 合并该会话历史 Skill 触发明细，为工具行徽标提供历史回放数据
        window.electronAPI.getSessionSkillTriggers(sessionId)
          .then((triggers) => {
            if (cancelled || triggers.length === 0) return
            setSkillTriggersMap((prev) => {
              const next = { ...prev }
              for (const trigger of triggers) {
                if (!next[trigger.toolCallId]) next[trigger.toolCallId] = trigger
              }
              return next
            })
          })
          .catch(() => {})
        unstable_batchedUpdates(() => {
          persistedSDKMessagesRef.current = sdkMsgs
          messagesLoadedSessionIdRef.current = sessionId
          setPersistedSDKMessages(sdkMsgs)
          setMessagesLoaded(true)
          messagesRefreshingRef.current = false
          setMessagesRefreshing(false)

          const runtimeState = clearHydratedAgentSessionRuntimeState(
            store.get(agentStreamingStatesAtom),
            store.get(liveMessagesMapAtom),
            sessionId,
          )
          if (runtimeState.streamingStates !== store.get(agentStreamingStatesAtom)) {
            setStreamingStates(runtimeState.streamingStates)
          }
          if (runtimeState.liveMessages !== store.get(liveMessagesMapAtom)) {
            setLiveMessagesMap(runtimeState.liveMessages)
          }
        })
      })
      .catch((error) => {
        if (cancelled) return
        console.error(error)
        setMessagesLoaded(true)
        messagesRefreshingRef.current = false
        setMessagesRefreshing(false)
      })
    return () => { cancelled = true }
  }, [sessionId, refreshVersion, setStreamingStates, setLiveMessagesMap, setMessagesCache, store])

  // 历史 usage 水合与消息拉取解耦：缓存先恢复，权威 IPC 返回后可覆盖；
  // target 异步就绪或 runtime/channel/model 变化时也会重新校验并恢复。
  React.useEffect(() => {
    if (!messagesLoaded || messagesLoadedSessionIdRef.current !== sessionId) return

    const restoredUsage = restoreAgentContextUsageFromMessages(
      persistedSDKMessagesRef.current,
      contextUsageTarget,
    )
    const currentOwner = buildAgentContextWindowOwner(
      contextUsageTarget.runtime,
      contextUsageTarget.channelId,
      contextUsageTarget.modelId,
    )

    setStreamingStates((prev) => {
      const state = prev.get(sessionId)
      const nextState = mergeAgentContextUsageHydrationState({
        state,
        restoredUsage,
        currentOwner,
      })
      if (nextState === state) return prev

      const map = new Map(prev)
      if (nextState) {
        map.set(sessionId, nextState)
      } else if (state) {
        map.delete(sessionId)
      } else {
        return prev
      }
      return map
    })
  }, [
    contextUsageTarget,
    contextUsageTargetKey,
    messagesLoaded,
    persistedSDKMessages,
    sessionId,
    setStreamingStates,
  ])

  // 从会话元数据初始化附加目录（仅冷启动水合，后续由 handleAttachContent/handleDetachDirectory 实时写入）
  React.useEffect(() => {
    const meta = sessions.find((s) => s.id === sessionId)
    const dirs = meta?.attachedDirectories ?? []
    setAttachedDirsMap((prev) => {
      const existing = prev.get(sessionId)
      if (existing != null) return prev
      const map = new Map(prev)
      if (dirs.length > 0) {
        map.set(sessionId, dirs)
      }
      return map
    })
  }, [sessionId, sessions, setAttachedDirsMap])

  // 从会话元数据初始化附加文件（仅冷启动水合，后续由 attachFile/detachFile 实时写入）
  React.useEffect(() => {
    const meta = sessions.find((s) => s.id === sessionId)
    const files = meta?.attachedFiles ?? []
    setAttachedFilesMap((prev) => {
      const existing = prev.get(sessionId)
      if (existing != null) return prev
      const map = new Map(prev)
      if (files.length > 0) {
        map.set(sessionId, files)
      }
      return map
    })
  }, [sessionId, sessions, setAttachedFilesMap])

  // 自动发送 pending prompt（从快速任务窗口或设置页触发）
  // 等待 messagesLoaded 确保消息加载完成后再插入乐观消息，避免被加载结果覆盖。
  // 使用 queueMicrotask 延迟发送：避免 setState → 重渲染 → cleanup 取消 timer 的竞态。
  React.useEffect(() => {
    if (!messagesLoaded || sessionTargetInteraction.requireChoiceBeforeSend) return
    if (!pendingPrompt) return
    if (pendingPrompt.sessionId !== sessionId) return
    if (!agentChannelId || streaming) return

    // 快照当前上下文
    const snapshot = {
      message: pendingPrompt.message,
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      additionalDirectories: Array.from(new Set([...attachedDirs, ...attachedFileDirectories, ...(pendingPrompt.additionalDirectories ?? [])])),
      mentionedSessionIds: pendingPrompt.mentionedSessionIds,
      mentionedTodoIds: pendingPrompt.mentionedTodoIds,
    }
    setPendingPrompt(null)

    queueMicrotask(() => {
      // 初始化流式状态（startedAt 由渲染进程生成，传递给主进程原样回传，确保竞态保护使用同一个值）
      const streamStartedAt = Date.now()
      setStreamingStates((prev) => {
        const map = new Map(prev)
        const existing = prev.get(sessionId)
        const contextWindowOwner = buildAgentContextWindowOwner('pi', snapshot.channelId, snapshot.modelId)
        const canReuseContextWindow = existing?.contextWindowOwner === contextWindowOwner
        const contextWindow = resolveRunContextWindow(
          snapshot.modelId,
          agentChannelProvider,
          existing?.contextWindow,
          existing?.contextWindowOwner,
          contextWindowOwner,
        )
        map.set(sessionId, {
          running: true,
          toolActivities: [],
          model: snapshot.modelId,
          startedAt: streamStartedAt,
          inputTokens: existing?.inputTokens,
          contextWindow,
          contextWindowSource: canReuseContextWindow
            ? existing?.contextWindowSource
            : contextWindow != null ? 'name_fallback' : undefined,
          contextWindowOwner,
        })
        return map
      })

      // 乐观更新：SDKMessage 格式（Phase 4）
      const tempUserSDKMsg: SDKMessage = {
        type: 'user',
        message: {
          content: [{ type: 'text', text: snapshot.message }],
        },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
      } as unknown as SDKMessage
      appendOptimisticPersistedMessage(tempUserSDKMsg)

      // 发送消息
      const input: AgentSendInput = {
        sessionId,
        userMessage: snapshot.message,
        channelId: snapshot.channelId,
        modelId: snapshot.modelId,
        workspaceId: snapshot.workspaceId,
        startedAt: streamStartedAt,
        ...buildAgentSendControlOverrides(executionControls),
        ...(snapshot.additionalDirectories && snapshot.additionalDirectories.length > 0 && {
          additionalDirectories: snapshot.additionalDirectories,
        }),
        ...(snapshot.mentionedSessionIds && snapshot.mentionedSessionIds.length > 0 && {
          mentionedSessionIds: snapshot.mentionedSessionIds,
        }),
        ...(snapshot.mentionedTodoIds && snapshot.mentionedTodoIds.length > 0 && {
          mentionedTodoIds: snapshot.mentionedTodoIds,
        }),
      }
      window.electronAPI.sendAgentMessage(input).catch((error) => {
        console.error('[AgentView] 自动发送配置消息失败:', error)
        setStreamingStates((prev) => {
          const current = prev.get(sessionId)
          if (!current) return prev
          const map = new Map(prev)
          map.set(sessionId, { ...current, running: false })
          return map
        })
      })
    })
  }, [messagesLoaded, pendingPrompt, sessionId, agentChannelId, agentModelId, agentChannelProvider, currentWorkspaceId, streaming, setPendingPrompt, setStreamingStates, executionControls, permissionMode, attachedDirs, attachedFileDirectories, sessionTargetInteraction.requireChoiceBeforeSend])
  // ===== 附件处理 =====

  /** 为文件生成唯一文件名（避免粘贴多张图片时文件名重复导致覆盖） */
  const makeUniqueFilename = React.useCallback((originalName: string, existingNames: string[]): string => {
    return makeUniqueAttachmentName(originalName, existingNames)
  }, [])

  const attachSessionFile = React.useCallback(async (filePath: string): Promise<void> => {
    const updated = await window.electronAPI.attachFile({ sessionId, filePath })
    setAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedFilesMap])

  const preparePendingFilesForSend = React.useCallback(async (
    files: AgentPendingFile[],
    additionalDirectoriesForRun: Set<string>,
  ): Promise<PreparedAgentAttachment | null> => {
    if (files.length === 0) {
      return { referenceBlock: '', attachments: [], additionalDirectories: [] }
    }

    const workspace = workspaces.find((w) => w.id === currentWorkspaceId)
    if (!workspace) {
      toast.warning('暂时无法发送附件', {
        description: '当前 Agent 会话没有绑定有效项目。请在顶部选择项目，或新建 Agent 会话后重新上传。',
      })
      return null
    }

    // 区分三类：
    // - 剪贴板临时草稿（isClipboardDraft）：sourcePath 指向 os.tmpdir，可能被系统清理，
    //   需读取最新内容（含预览面板 autosave 的编辑）拷贝进 session 目录持久化
    // - 侧面板真实文件（仅 sourcePath）：原地引用，不复制
    // - 新上传文件（无 sourcePath）：从内存数据保存到 session 目录
    const existingFiles = files.filter((f) => f.sourcePath && !f.isClipboardDraft)
    const clipboardDrafts = files.filter((f) => f.sourcePath && f.isClipboardDraft)
    const newFiles = files.filter((f) => !f.sourcePath)

    const allRefs: Array<{ filename: string; targetPath: string; sourceFile: AgentPendingFile }> = []
    const queuedAdditionalDirectories = new Set<string>()

    // 已有路径的文件直接引用
    for (const f of existingFiles) {
      const sourcePath = f.sourcePath!
      allRefs.push({ filename: f.filename, targetPath: sourcePath, sourceFile: f })
      const parentPath = getFileParentPath(sourcePath)
      if (parentPath) {
        additionalDirectoriesForRun.add(parentPath)
        queuedAdditionalDirectories.add(parentPath)
      }
    }

    // 剪贴板草稿：读取临时文件最新内容，转为待保存数据
    const draftFilesToSave: Array<{ sourceFile: AgentPendingFile; filename: string; data: string }> = []
    const staleDraftFiles: string[] = []
    for (const f of clipboardDrafts) {
      const sourcePath = f.sourcePath!
      const parentPath = getFileParentPath(sourcePath)
      try {
        const read = await window.electronAPI.resolveAndReadFile(sourcePath, {
          sessionId,
          candidateBasePaths: parentPath ? [parentPath] : undefined,
        })
        if (!read) {
          staleDraftFiles.push(f.filename)
          continue
        }
        const data = await fileToBase64(new File([read.content], f.filename, { type: f.mediaType }))
        draftFilesToSave.push({ sourceFile: f, filename: f.filename, data })
      } catch (error) {
        console.error('[AgentView] 读取剪贴板草稿失败:', error)
        staleDraftFiles.push(f.filename)
      }
    }
    if (staleDraftFiles.length > 0) {
      toast.error('附件数据已失效', {
        description: `请移除后重新粘贴：${staleDraftFiles.join('、')}`,
      })
      return null
    }

    // 新上传的文件 + 剪贴板草稿一并保存到 session 目录
    const inMemoryFilesToSave = newFiles.map((f) => ({
      sourceFile: f,
      filename: f.filename,
      data: window.__pendingAgentFileData?.get(f.id) || '',
    }))
    const missingDataFiles = inMemoryFilesToSave.filter((f) => !f.data).map((f) => f.filename)
    if (missingDataFiles.length > 0) {
      toast.error('附件数据已失效', {
        description: `请移除后重新添加文件：${missingDataFiles.join('、')}`,
      })
      return null
    }

    const filesToSave = [...inMemoryFilesToSave, ...draftFilesToSave]
    if (filesToSave.length > 0) {
      try {
        const saved = await window.electronAPI.saveFilesToAgentSession({
          workspaceSlug: workspace.slug,
          sessionId,
          files: filesToSave.map(({ filename, data }) => ({ filename, data })),
        })
        saved.forEach((savedFile, index) => {
          const sourceFile = filesToSave[index]?.sourceFile
          if (!sourceFile) return
          allRefs.push({ ...savedFile, sourceFile })
        })
      } catch (error) {
        console.error('[AgentView] 保存附件到 session 失败:', error)
        toast.error('附件保存失败', {
          description: '请确认当前项目可用，或新建 Agent 会话后重新上传。',
        })
        return null
      }
    }

    if (allRefs.length === 0) {
      toast.error('附件没有成功加入消息', {
        description: '请重新上传文件，或切换到有效项目后再试。',
      })
      return null
    }

    const refs = allRefs.map((f) => `- ${f.filename}: ${f.targetPath}`).join('\n')

    for (const f of files) {
      if (f.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(f.previewUrl)
      window.__pendingAgentFileData?.delete(f.id)
    }
    setPendingFiles([])

    return {
      referenceBlock: `<attached_files>\n${refs}\n</attached_files>\n\n`,
      attachments: allRefs.map((ref) => ({
        filename: ref.filename,
        mediaType: ref.sourceFile.mediaType,
        size: ref.sourceFile.size,
        targetPath: ref.targetPath,
      })),
      additionalDirectories: Array.from(queuedAdditionalDirectories),
    }
  }, [currentWorkspaceId, sessionId, setPendingFiles, workspaces])

  const restoreQueuedAttachmentsToPending = React.useCallback((attachments?: AgentQueuedAttachment[]): void => {
    if (!attachments || attachments.length === 0) return
    setPendingFiles((prev) => [
      ...prev,
      ...attachments.map((attachment) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sourcePath: attachment.targetPath,
      })),
    ])
  }, [setPendingFiles])

  /** 将 File 对象列表添加为待发送附件 */
  const addFilesAsAttachments = React.useCallback(async (files: File[], sourcePaths?: Map<File, string>): Promise<void> => {
    // 收集已有的 pending 文件名，用于去重
    const usedNames: string[] = pendingFilesRef.current.map((f) => f.filename)

    const pathBackedFiles: string[] = []
    const rejectedLargeFiles: string[] = []

    for (const file of files) {
      try {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          const sourcePath = sourcePaths?.get(file)
          if (!sourcePath) {
            rejectedLargeFiles.push(file.name)
            continue
          }
          await attachSessionFile(sourcePath)

          const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
          const uniqueFilename = makeUniqueFilename(file.name, usedNames)
          usedNames.push(uniqueFilename)

          const pending: AgentPendingFile = {
            id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            filename: uniqueFilename,
            mediaType: file.type || 'application/octet-stream',
            size: file.size,
            previewUrl,
            sourcePath,
          }

          setPendingFiles((prev) => [...prev, pending])
          pathBackedFiles.push(uniqueFilename)
          continue
        }

        const base64 = await fileToBase64(file)
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        const uniqueFilename = makeUniqueFilename(file.name, usedNames)
        usedNames.push(uniqueFilename)

        const pending: AgentPendingFile = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: uniqueFilename,
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          previewUrl,
        }

        if (!window.__pendingAgentFileData) {
          window.__pendingAgentFileData = new Map<string, string>()
        }
        window.__pendingAgentFileData.set(pending.id, base64)

        setPendingFiles((prev) => [...prev, pending])
      } catch (error) {
        console.error('[AgentView] 添加附件失败:', error)
      }
    }

    if (pathBackedFiles.length > 0) {
      toast.success(`已将大文件作为附加文件引用：${formatFileNames(pathBackedFiles)}`)
    }
    if (rejectedLargeFiles.length > 0) {
      toast.error(`以下文件超过 100MB 且无法取得本地路径，已跳过：${formatFileNames(rejectedLargeFiles)}`)
    }
  }, [attachSessionFile, makeUniqueFilename, setPendingFiles])

  const addLargeDialogFilesAsReferences = React.useCallback(async (files: FileDialogLargeFile[]): Promise<void> => {
    if (files.length === 0) return
    const usedNames: string[] = pendingFilesRef.current.map((f) => f.filename)
    const added: string[] = []
    const rejected: string[] = []

    for (const file of files) {
      try {
        await attachSessionFile(file.path)
        const uniqueFilename = makeUniqueFilename(file.filename, usedNames)
        usedNames.push(uniqueFilename)

        const pending: AgentPendingFile = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: uniqueFilename,
          mediaType: file.mediaType,
          size: file.size,
          sourcePath: file.path,
        }

        setPendingFiles((prev) => [...prev, pending])
        added.push(uniqueFilename)
      } catch (error) {
        console.error('[AgentView] 附加大文件失败:', error)
        rejected.push(file.filename)
      }
    }

    if (added.length > 0) {
      toast.success(`已将大文件作为附加文件引用：${formatFileNames(added)}`)
    }
    if (rejected.length > 0) {
      toast.error(`以下文件附加失败，已跳过：${formatFileNames(rejected)}`)
    }
  }, [attachSessionFile, makeUniqueFilename, setPendingFiles])

  /** 将已选文件加入待发送附件，目录由外层走会话授权路径。 */
  const addDialogFilesAsAttachments = React.useCallback(async (result: FileDialogResult): Promise<void> => {
    const largeFiles = result.largeFiles ?? []
    const skippedFiles = result.skippedFiles ?? []
    const oversized: string[] = []

    for (const fileInfo of result.files) {
      if (fileInfo.size > MAX_ATTACHMENT_SIZE) {
        oversized.push(fileInfo.filename)
        continue
      }
      const previewUrl = fileInfo.mediaType.startsWith('image/')
        ? `data:${fileInfo.mediaType};base64,${fileInfo.data}`
        : undefined

      const pending: AgentPendingFile = {
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: fileInfo.filename,
        mediaType: fileInfo.mediaType,
        size: fileInfo.size,
        previewUrl,
      }

      if (!window.__pendingAgentFileData) {
        window.__pendingAgentFileData = new Map<string, string>()
      }
      window.__pendingAgentFileData.set(pending.id, fileInfo.data)

      setPendingFiles((prev) => [...prev, pending])
    }

    if (oversized.length > 0) {
      toast.error(`以下文件超过 100MB 且无法取得本地路径，已跳过：${formatFileNames(oversized)}`)
    }
    await addLargeDialogFilesAsReferences(largeFiles)
    if (skippedFiles.length > 0) {
      toast.warning(`以下文件无法读取，已跳过：${formatFileNames(skippedFiles.map((file) => file.filename))}`)
    }
  }, [addLargeDialogFilesAsReferences, setPendingFiles])

  /** 打开指定类型的选择器：文件作为附件，文件夹仅授权给当前会话。 */
  const handleAttachContent = React.useCallback(async (kind: ComposerAttachmentKind): Promise<void> => {
    try {
      const result = await window.electronAPI.openFileOrFolderDialog(sessionId, kind)
      const largeFiles = result.largeFiles ?? []
      const skippedFiles = result.skippedFiles ?? []
      if (result.files.length === 0 && largeFiles.length === 0 && skippedFiles.length === 0 && result.directories.length === 0) return

      await addDialogFilesAsAttachments(result)

      const attachedDirectoryNames: string[] = []
      const failedDirectoryNames: string[] = []
      for (const directory of result.directories) {
        try {
          const updated = await window.electronAPI.attachDirectory({
            sessionId,
            directoryPath: directory.path,
          })
          setAttachedDirsMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, updated)
            return map
          })
          attachedDirectoryNames.push(directory.name)
        } catch (error) {
          console.error('[AgentView] 附加文件夹失败:', error)
          failedDirectoryNames.push(directory.name)
        }
      }

      if (attachedDirectoryNames.length > 0) {
        toast.success(`已附加目录: ${formatFileNames(attachedDirectoryNames)}`)
      }
      if (failedDirectoryNames.length > 0) {
        toast.error(`以下文件夹附加失败：${formatFileNames(failedDirectoryNames)}`)
      }
    } catch (error) {
      console.error('[AgentView] 附加内容选择失败:', error)
      toast.error('附加文件或文件夹失败')
    }
  }, [addDialogFilesAsAttachments, sessionId, setAttachedDirsMap])

  /** 移除待发送文件 */
  const handleRemoveFile = React.useCallback((id: string): void => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id)
      if (file?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(file.previewUrl)
      }
      window.__pendingAgentFileData?.delete(id)
      return prev.filter((f) => f.id !== id)
    })
  }, [setPendingFiles])

  /** 图片附件编辑完成：用编辑后的图替换该附件（统一转为内存图片走 __pendingAgentFileData） */
  const handleAttachmentEditComplete = React.useCallback((fileId: string, editedDataUrl: string): void => {
    const base64 = editedDataUrl.split(',')[1]
    if (!base64) return
    if (!window.__pendingAgentFileData) {
      window.__pendingAgentFileData = new Map<string, string>()
    }
    window.__pendingAgentFileData.set(fileId, base64)
    setPendingFiles((prev) => prev.map((f) => {
      if (f.id !== fileId) return f
      if (f.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(f.previewUrl)
      }
      return {
        ...f,
        previewUrl: editedDataUrl,
        filename: f.filename.replace(/(\.[^.]+)?$/, '') + '_edited.png',
        mediaType: 'image/png',
        size: Math.round(base64.length * 0.75),
        // 编辑后统一当作内存图片：清除文件引用，发送时从 __pendingAgentFileData 读取最新数据
        sourcePath: undefined,
        isClipboardDraft: undefined,
      }
    }))
  }, [setPendingFiles])

  const openClipboardPreviewFile = React.useCallback((filePath: string): void => {
    const parentPath = getFileParentPath(filePath)
    openPreview(sessionId, {
      filePath,
      previewOnly: true,
      readOnly: false,
      basePaths: parentPath ? [parentPath] : undefined,
    })
  }, [sessionId, openPreview])

  /** 点击 clipboard 附件时，在当前会话的临时预览标签页中显示内容 */
  const handleClipboardPreview = React.useCallback(async (file: AgentPendingFile) => {
    if (file.sourcePath) {
      openClipboardPreviewFile(file.sourcePath)
      return
    }

    const base64 = window.__pendingAgentFileData?.get(file.id)
    if (!base64) return

    try {
      // atob 解码得到二进制字符串，需用 TextDecoder 正确还原 UTF-8 文本
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const text = new TextDecoder('utf-8').decode(bytes)
      const tmpPath = await window.electronAPI.writeClipboardPreview(file.filename, text)
      setPendingFiles((prev) => prev.map((item) => (
        item.id === file.id ? { ...item, sourcePath: tmpPath, isClipboardDraft: true } : item
      )))
      window.__pendingAgentFileData?.delete(file.id)
      openClipboardPreviewFile(tmpPath)
    } catch (error) {
      console.error('[AgentView] clipboard 预览写入失败:', error)
    }
  }, [openClipboardPreviewFile, setPendingFiles])

  const addClipboardTextDraft = React.useCallback(async (text: string): Promise<AgentPendingFile> => {
    const draft = createClipboardTextDraft(text, pendingFilesRef.current.map((f) => f.filename))
    const tmpPath = await window.electronAPI.writeClipboardPreview(draft.filename, text)
    const pending = createClipboardPendingFile(
      draft,
      tmpPath,
      `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    setPendingFiles((prev) => {
      const next = [...prev, pending]
      pendingFilesRef.current = next
      return next
    })
    return pending
  }, [setPendingFiles])

  /** 粘贴文件处理 */
  const handlePasteFiles = React.useCallback((files: File[]): void => {
    addFilesAsAttachments(files)
  }, [addFilesAsAttachments])

  /** 粘贴超长文本时转为待发送附件，避免把大段内容直接塞进输入框 */
  const handlePasteLongText = React.useCallback((text: string): void => {
    addClipboardTextDraft(text)
      .then((file) => {
        toast.success('已将超长文本转为附件', {
          description: `${file.filename}，点击附件可预览编辑。`,
        })
      })
      .catch((error) => {
        console.error('[AgentView] 超长文本转附件失败:', error)
        toast.error('超长文本转附件失败')
      })
  }, [addClipboardTextDraft])

  /** 将右侧文件面板拖入的目录附加到会话（保持 Agent 可访问）。返回是否成功。 */
  const addPanelDirectory = React.useCallback(async (dirPath: string): Promise<boolean> => {
    try {
      const updated = await window.electronAPI.attachDirectory({
        sessionId,
        directoryPath: dirPath,
      })
      setAttachedDirsMap((prev) => {
        const map = new Map(prev)
        map.set(sessionId, updated)
        return map
      })
      return true
    } catch (error) {
      console.error('[AgentView] 面板拖拽附加目录失败:', error)
      return false
    }
  }, [sessionId, setAttachedDirsMap])

  /** 拖放处理 */
  const handleDragOver = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = React.useCallback(async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    // 优先识别右侧文件面板的自定义拖拽载荷（会话文件 / 项目文件引用）
    // 文件直接插入引用；文件夹先附加到会话（Agent 可访问），附加成功后才插入引用，
    // 避免失败时留下 Agent 无法访问的无效引用。
    const panelItems = getFilePanelDragData(e.dataTransfer)
    if (panelItems && panelItems.length > 0) {
      const files = panelItems.filter((item) => !item.isDirectory)
      const dirs = panelItems.filter((item) => item.isDirectory)
      if (files.length > 0) {
        richTextInputRef.current?.insertFileMentions(files)
      }
      for (const dir of dirs) {
        const ok = await addPanelDirectory(dir.path)
        if (ok) {
          richTextInputRef.current?.insertFileMentions([dir])
        }
      }
      return
    }

    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length === 0) return

    // 通过 preload 的 webUtils.getPathForFile 获取真实路径
    const pathMap = new Map<string, File>()
    const paths: string[] = []
    for (const f of droppedFiles) {
      try {
        const p = window.electronAPI.getPathForFile(f)
        if (p) {
          paths.push(p)
          pathMap.set(p, f)
        }
      } catch { /* 无法获取路径时忽略 */ }
    }

    if (paths.length > 0) {
      try {
        // 通过主进程检测目录 vs 文件
        const { directories, files: filePaths } = await window.electronAPI.checkPathsType(paths)

        // 拖拽的文件夹：附加到会话 + 插入可见的文件夹引用（与右侧面板拖拽体验一致）
        for (const dirPath of directories) {
          try {
            const updated = await window.electronAPI.attachDirectory({
              sessionId,
              directoryPath: dirPath,
            })
            setAttachedDirsMap((prev) => {
              const map = new Map(prev)
              map.set(sessionId, updated)
              return map
            })
            const dirName = dirPath.split(/[\\/]/).pop() || dirPath
            // 在输入框插入文件夹引用 chip（Agent 通过附加目录可访问）
            richTextInputRef.current?.insertFileMentions([{
              path: dirPath,
              name: dirName,
              isDirectory: true,
              scope: 'project',
            }])
            toast.success(`已附加目录: ${dirName}`)
          } catch (error) {
            console.error('[AgentView] 拖拽附加文件夹失败:', error)
          }
        }

        // 普通文件作为附件
        const regularFiles = filePaths.map((p) => pathMap.get(p)!).filter(Boolean)
        if (regularFiles.length > 0) {
          const fileSourcePaths = new Map<File, string>()
          for (const path of filePaths) {
            const file = pathMap.get(path)
            if (file) fileSourcePaths.set(file, path)
          }
          addFilesAsAttachments(regularFiles, fileSourcePaths)
        }
      } catch (error) {
        console.error('[AgentView] 路径检测失败，回退处理:', error)
        addFilesAsAttachments(droppedFiles)
      }
    } else {
      // 无路径信息：回退，所有项按普通文件处理
      addFilesAsAttachments(droppedFiles)
    }
  }, [sessionId, addFilesAsAttachments, addPanelDirectory, setAttachedDirsMap])

  /** ModelSelector 选择回调 */
  const handleModelSelect = React.useCallback((option: ModelOption): void => {
    // 运行中的 Agent query 会继续使用启动时的模型；这里只更新会话配置，供本轮结束后的下一轮使用。
    const modelSwitchDeferred = streaming || backgroundWaiting

    // 更新当前会话的 per-session 配置
    setSessionChannelMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, option.channelId)
      return map
    })
    setSessionModelMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, option.modelId)
      return map
    })
    setAgentSessions((prev) => prev.map((session) => (
      session.id === sessionId
        ? { ...session, channelId: option.channelId, modelId: option.modelId }
        : session
    )))

    // 空闲切换时清除旧的 contextWindow，让下一轮 result 重新提供真实值。
    // 运行中不能清除：当前轮仍在使用旧模型，旧模型的用量显示应保持稳定。
    if (!modelSwitchDeferred) {
      setStreamingStates((prev) => {
        const state = prev.get(sessionId)
        if (!state) return prev
        const map = new Map(prev)
        map.set(sessionId, {
          ...state,
          contextBreakdown: undefined,
          contextWindow: undefined,
          contextWindowSource: undefined,
          contextWindowOwner: undefined,
        })
        return map
      })
    }

    // 同时更新全局默认值（新会话继承）
    setDefaultChannelId(option.channelId)
    setDefaultModelId(option.modelId)

    // 持久化到设置
    window.electronAPI.updateSettings({
      agentChannelId: option.channelId,
      agentModelId: option.modelId,
    }).catch(console.error)

    window.electronAPI.updateAgentSessionModel(sessionId, option.channelId, option.modelId)
      .then((updated) => {
        setAgentSessions((prev) => prev.map((session) => (
          session.id === updated.id ? updated : session
        )))
      })
      .catch(console.error)

    if (modelSwitchDeferred) {
      toast.info('模型已切换，本轮结束后生效')
    }
  }, [sessionId, streaming, backgroundWaiting, setSessionChannelMap, setSessionModelMap, setDefaultChannelId, setDefaultModelId, setAgentSessions])

  const handleCodexFastModeChange = React.useCallback(async (): Promise<void> => {
    if (!isCodexFastModeAvailable || streaming || backgroundWaiting || !sessionMeta) return

    const previousSessionMeta = sessionMeta
    const nextEnabled = !codexFastModeEnabled
    setAgentSessions((prev) => prev.map((item) => (
      item.id === sessionId ? { ...item, codexFastMode: nextEnabled, updatedAt: Date.now() } : item
    )))

    try {
      const updated = await window.electronAPI.updateSessionCodexFastMode(sessionId, nextEnabled)
      setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? updated : item))
    } catch (error) {
      console.error('[AgentView] 切换 Codex Fast Mode 失败:', error)
      setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? previousSessionMeta : item))
      toast.error('快速模式切换失败', { description: getErrorMessage(error) })
    }
  }, [backgroundWaiting, codexFastModeEnabled, isCodexFastModeAvailable, sessionId, sessionMeta, setAgentSessions, streaming])

  const setModelPresentationPreset = React.useCallback(async (nextPreset: ModelPresentationPreset): Promise<void> => {
    if (streaming || backgroundWaiting || !sessionMeta) return
    if (sessionMeta.modelPresentationPreset === nextPreset) return

    const previousSessionMeta = sessionMeta
    setAgentSessions((prev) => prev.map((item) => (
      item.id === sessionId ? { ...item, modelPresentationPreset: nextPreset, updatedAt: Date.now() } : item
    )))

    try {
      const updated = await window.electronAPI.updateSessionModelPresentationPreset(sessionId, nextPreset)
      setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? updated : item))
    } catch (error) {
      console.error('[AgentView] 切换模型呈现预设失败:', error)
      setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? previousSessionMeta : item))
      toast.error('极简模式切换失败', { description: getErrorMessage(error) })
    }
  }, [backgroundWaiting, sessionId, sessionMeta, setAgentSessions, streaming])

  const updateReasoningLevel = React.useCallback(async (thinkingLevel: AgentThinkingLevel): Promise<void> => {
    if (!isSessionThinkingAvailable || !sessionMeta) return

    const reasoningLevelSwitchDeferred = streaming || backgroundWaiting
    const previousSessionMeta = sessionMeta
    setAgentSessions((prev) => prev.map((item) => (
      item.id === sessionId ? { ...item, reasoningLevel: thinkingLevel, updatedAt: Date.now() } : item
    )))

    try {
      const updated = await window.electronAPI.updateSessionReasoningLevel(sessionId, thinkingLevel)
      setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? updated : item))

      try {
        await window.electronAPI.updateSettings({ defaultOpenAIThinkingLevel: thinkingLevel })
      } catch (error) {
        console.error('[AgentView] 保存 OpenAI 默认思考深度失败:', error)
        toast.error('默认思考深度保存失败', { description: getErrorMessage(error) })
      }
      if (reasoningLevelSwitchDeferred) {
        toast.info('思考强度已切换，本轮结束后生效', { id: `agent-reasoning-level-deferred-${sessionId}` })
      }
    } catch (error) {
      console.error('[AgentView] 更新 OpenAI 思考深度失败:', error)
      setAgentSessions((prev) => prev.map((item) => item.id === sessionId ? previousSessionMeta : item))
      toast.error('思考深度切换失败', { description: getErrorMessage(error) })
    }
  }, [backgroundWaiting, isSessionThinkingAvailable, sessionId, sessionMeta, setAgentSessions, streaming])

  /** 构建 externalSelectedModel 给 ModelSelector */
  const computedSelectedModel = React.useMemo(() => {
    if (!agentChannelId || !agentModelId) return null
    return { channelId: agentChannelId, modelId: agentModelId }
  }, [agentChannelId, agentModelId])

  // 防止瞬态 null 传递给 ModelSelector（防御 overflow remount 时 stableModelInfoRef 丢失）
  const stableSelectedModelRef = React.useRef(computedSelectedModel)
  if (computedSelectedModel) stableSelectedModelRef.current = computedSelectedModel
  const externalSelectedModel = computedSelectedModel ?? stableSelectedModelRef.current
  const selectedModelOption = React.useMemo(() => {
    if (!externalSelectedModel) return undefined
    return buildModelOptions(globalChannels).find((option) => (
      option.channelId === externalSelectedModel.channelId && option.modelId === externalSelectedModel.modelId
    ))
  }, [externalSelectedModel, globalChannels])
  const composerModelName = selectedModelOption?.modelName ?? externalSelectedModel?.modelId ?? '选择模型'
  const composerChannelName = selectedModelOption?.channelName
  const composerModelLogo = selectedModelOption
    ? getModelLogo(selectedModelOption.modelId, selectedModelOption.provider)
    : undefined

  /** 把当前文本保存为随下一条用户消息发送的附言；不进入 Pi 原生 steering/follow-up 队列。 */
  const handleQueueAside = React.useCallback((): void => {
    const content = inputContent.trim()
    if (!content) {
      toast.info('请先输入附言内容')
      return
    }
    const aside = createAgentQueuedMessage(content, crypto.randomUUID(), Date.now(), null, { kind: 'aside' })
    setQueuedMessages((current) => orderQueuedMessagesForDelivery([...current, aside]))
    setInputContent('')
    setInputHtmlContent('')
    setPromptSuggestions((current) => {
      if (!current.has(sessionId)) return current
      const next = new Map(current)
      next.delete(sessionId)
      return next
    })
    toast.success('已排为附言', { description: '将在下一条正常消息发送时一起提供给 Agent。' })
    if (pendingFilesRef.current.length > 0) {
      toast.info('文件附件仍保留在输入区', { description: '附言当前只收集文本；文件会随下一条用户消息发送。' })
    }
    requestAnimationFrame(() => richTextInputRef.current?.focus())
  }, [inputContent, sessionId, setInputContent, setInputHtmlContent, setPromptSuggestions, setQueuedMessages])

  /** 新 Worktree 会话必须先拥有稳定标题，物理目录创建后不再随标题变化。 */
  const ensureInitialWorktreeTitle = React.useCallback(async (
    userText: string,
    attachments: readonly AgentPendingFile[],
  ): Promise<void> => {
    if (sessionMeta && sessionMeta.title !== DEFAULT_AGENT_SESSION_TITLE) return

    const generatedTitle = await generateInitialWorktreeSessionTitle({
      userText,
      attachments,
      ...(agentModelId ? {
        generateTitle: (userMessage) => window.electronAPI.generateAgentTitle({
          userMessage,
          channelId: agentChannelId!,
          modelId: agentModelId,
        }),
      } : {}),
    })

    // 标题请求期间用户可能已手工改名；重新读取权威 metadata，绝不覆盖新标题。
    let latestSession: (typeof sessions)[number] | undefined
    try {
      latestSession = (await window.electronAPI.listAgentSessions())
        .find((session) => session.id === sessionId)
    } catch (error) {
      console.warn('[AgentView] Worktree 创建前刷新会话标题失败，保留当前权威标题:', error)
      return
    }
    if (!latestSession) return
    if (latestSession.title !== DEFAULT_AGENT_SESSION_TITLE) {
      setAgentSessions((prev) => prev.map((session) => (
        session.id === latestSession!.id ? latestSession! : session
      )))
      setTabs((prev) => updateTabTitle(prev, latestSession!.id, latestSession!.title))
      return
    }

    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(sessionId, generatedTitle)
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
      setTabs((prev) => updateTabTitle(prev, updated.id, updated.title))
    } catch (error) {
      // 标题失败不能阻止 Worktree 创建；main 侧会用 worktree--<sessionId8> 兜底。
      console.warn('[AgentView] Worktree 创建前持久化标题失败，继续使用目录名兜底:', error)
    }
  }, [agentChannelId, agentModelId, sessionId, sessionMeta, setAgentSessions, setTabs])

  /** 发送消息 */
  const handleSend = React.useCallback(async (
    overrideText?: string,
    requestedQueueKind: AgentQueueMessageKind = getAgentQueueSubmitKind(false),
    runOptions?: {
      worktreeContinuation?: boolean
      worktreeContinuationAuthorizationToken?: string
      propagateSendFailure?: boolean
    },
  ): Promise<void> => {
    const isAuthorizedWorktreeContinuation = Boolean(runOptions?.worktreeContinuationAuthorizationToken)
    const isWorktreeContinuation = runOptions?.worktreeContinuation === true || isAuthorizedWorktreeContinuation
    const text = (overrideText ?? inputContent).trim()
    // 一次性 Worktree continuation 必须逐字使用宿主返回的 canonical message，
    // 不读取 composer suggestion、附件、附言、引用或 mention。
    const effectiveText = isWorktreeContinuation ? text : (text || suggestion || '')
    const pendingAsideMessages = isWorktreeContinuation
      ? []
      : getAsideQueuedMessages(queuedMessages).filter((aside) => !consumedAsideIdsRef.current.has(aside.id))
    const pendingAsideIds = new Set(pendingAsideMessages.map((aside) => aside.id))
    const nextTurnAsides: AgentNextTurnAside[] = pendingAsideMessages.map((aside) => ({
      id: aside.id,
      content: aside.text,
    }))
    const consumePendingAsides = (): void => {
      if (pendingAsideIds.size === 0) return
      for (const id of pendingAsideIds) consumedAsideIdsRef.current.add(id)
      setQueuedMessages((current) => current.filter((message) => !pendingAsideIds.has(message.id)))
    }
    const restorePendingAsides = (): void => {
      if (pendingAsideMessages.length === 0) return
      for (const aside of pendingAsideMessages) consumedAsideIdsRef.current.delete(aside.id)
      setQueuedMessages((current) => restoreFailedAsideMessages(current, pendingAsideMessages))
    }
    const pendingFilesSnapshot = isWorktreeContinuation ? [] : pendingFilesRef.current
    if ((!effectiveText && pendingFilesSnapshot.length === 0) || !agentChannelId || !hasAvailableModel) return
    if (sessionTargetInteraction.requireChoiceBeforeSend) {
      toast.info('请先选择工作区', { description: '完成 Session Target 选择后即可发送。' })
      return
    }
    if (initialWorktreePreparationRef.current) {
      toast.info('消息正在发送', { description: 'Domi 正在生成标题并创建 Worktree，无需重复提交。' })
      return
    }
    // confirmIteration 会先把 atom 从 loading=true 收敛为新 Worktree 快照，再同步派发续跑事件。
    // React 事件闭包可能尚未赶上这次 atom render；授权续跑必须读取 Jotai 当前值，不能被旧 loading
    // 快照误判为失败。普通 composer 发送继续使用当前 render 快照，保持原有交互节奏。
    const targetStateForSend = isWorktreeContinuation
      ? store.get(sessionTargetStateAtomFamily(sessionId))
      : sessionTargetState
    if (shouldDeferWorkspaceSend({
      hasSnapshot: targetStateForSend.snapshot !== null,
      loading: targetStateForSend.loading,
    })) {
      if (isAuthorizedWorktreeContinuation) {
        toast.error('本次执行未启动', { description: '工作区状态已变化，请在续跑卡片中重新确认。' })
        return
      }
      if (!deferredWorkspaceSendRef.current) {
        deferredWorkspaceSendRef.current = { overrideText, requestedQueueKind }
        setWorkspaceSendDeferred(true)
        toast.info('消息已排队', { description: '工作区准备完成后会自动发送，无需再次按 Enter。' })
      } else {
        toast.info('消息已在等待工作区', { description: '准备完成后会自动发送，无需重复提交。' })
      }
      return
    }
    if (!messagesLoaded) return
    if (isAuthorizedWorktreeContinuation && (streaming || backgroundWaiting || messagesRefreshingRef.current)) {
      toast.error('本次执行未启动', { description: '会话已有新活动，请在续跑卡片中重新确认。' })
      return
    }
    // 全新会话未绑定 target：发送前自动绑定（默认 Local；已勾选 Worktree 则创建隔离 Worktree）。
    if (!targetStateForSend.snapshot) {
      const kind = sessionWorktreePending ? 'isolated' : 'local'
      let bound = false
      if (kind === 'isolated') {
        initialWorktreePreparationRef.current = true
        setInitialWorktreePreparing(true)
        try {
          await ensureInitialWorktreeTitle(effectiveText, pendingFilesSnapshot)
          bound = await bindSessionTarget(kind)
        } finally {
          initialWorktreePreparationRef.current = false
          setInitialWorktreePreparing(false)
        }
      } else {
        bound = await bindSessionTarget(kind)
      }
      if (!bound) {
        const bindError = store.get(sessionTargetStateAtomFamily(sessionId)).error?.message
        toast.error(kind === 'isolated' ? 'Worktree 创建失败' : '工作区绑定失败', {
          description: bindError ?? '绑定失败，请重试。',
        })
        return
      }
    }
    if (!streaming && messagesRefreshingRef.current) {
      toast.info('上一轮消息正在同步', {
        description: '请稍等片刻再发送；队列会在同步完成后继续。',
      })
      return
    }
    const additionalDirectoriesForRun = isWorktreeContinuation
      ? new Set<string>()
      : createBaseAdditionalDirectories()

    if (streaming) {
      const attachmentContext = pendingFilesSnapshot.length > 0
        ? await preparePendingFilesForSend(pendingFilesSnapshot, additionalDirectoriesForRun)
        : null
      if (pendingFilesSnapshot.length > 0 && !attachmentContext) return

      const quotedSelection = consumeQuotedSelection()
      // Pi SDK 原生处理 steer/followUp；本地 atom 只作为可编辑/可排序的展示镜像。
      const kind: AgentQueueMessageKind = requestedQueueKind
      const message = createAgentQueuedMessage(
        effectiveText,
        crypto.randomUUID(),
        Date.now(),
        quotedSelection,
        {
          kind,
          ...(attachmentContext ? {
            fileReferenceBlock: attachmentContext.referenceBlock,
            attachments: attachmentContext.attachments,
            additionalDirectories: attachmentContext.additionalDirectories,
          } : {}),
          ...(nextTurnAsides.length > 0 ? { nextTurnAsides } : {}),
        },
      )
      const quotedSelectionBlock = message.quotedSelection
        ? buildQuotedSelectionBlock(message.quotedSelection)
        : ''
      const payload = buildQueuedMessageSendPayload(message, quotedSelectionBlock)
      for (const id of pendingAsideIds) consumedAsideIdsRef.current.add(id)
      setQueuedMessages((prev) => {
        const remaining = prev.filter((item) => !pendingAsideIds.has(item.id))
        return orderQueuedMessagesForDelivery([...remaining, message])
      })
      if (overrideText === undefined) {
        setInputContent('')
        setInputHtmlContent('')
      }
      setPromptSuggestions((prev) => {
        if (!prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })

      try {
        await queueMessageIntoActiveAgent(
          message,
          payload.rawText,
          payload.sdkText,
          payload.mentions,
          false,
          kind,
        )
      } catch (error) {
        setQueuedMessages((prev) => removeQueuedMessage(prev, message.id))
        restorePendingAsides()
        setInputContent(effectiveText)
        setInputHtmlContent('')
        restoreQueuedAttachmentsToPending(message.attachments)
        if (message.quotedSelection) {
          setQuotedSelectionMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, message.quotedSelection!)
            return map
          })
        }
        toast.error('消息入队失败', { description: String(error) })
      }
      return
    }

    if (backgroundWaiting) {
      // 软空闲态没有活跃输出，直接注入，无需中断。
      const attachmentContext = pendingFilesSnapshot.length > 0
        ? await preparePendingFilesForSend(pendingFilesSnapshot, additionalDirectoriesForRun)
        : null
      if (pendingFilesSnapshot.length > 0 && !attachmentContext) return

      const quotedSelection = consumeQuotedSelection()
      const backgroundQueueKind: AgentQueueMessageKind = requestedQueueKind
      const message = createAgentQueuedMessage(effectiveText, crypto.randomUUID(), Date.now(), quotedSelection, {
        ...(attachmentContext ? {
          fileReferenceBlock: attachmentContext.referenceBlock,
          attachments: attachmentContext.attachments,
          additionalDirectories: attachmentContext.additionalDirectories,
        } : {}),
        ...(nextTurnAsides.length > 0 ? { nextTurnAsides } : {}),
        kind: backgroundQueueKind,
      })
      consumePendingAsides()
      if (overrideText === undefined) {
        setInputContent('')
        setInputHtmlContent('')
      }
      setPromptSuggestions((prev) => {
        if (!prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })
      sendPlainTextAgentMessage(message, backgroundQueueKind).catch((error) => {
        restorePendingAsides()
        console.error('[AgentView] 追加消息失败:', error)
        toast.error('追加消息失败', { description: String(error) })
        // 回滚：恢复输入框内容和建议，避免用户输入丢失
        setInputContent(effectiveText)
        setInputHtmlContent('')
        setPromptSuggestions((prev) => {
          const map = new Map(prev)
          if (suggestion) {
            map.set(sessionId, suggestion)
          } else {
            map.delete(sessionId)
          }
          return map
        })
        const failedQuotedSelection = message.quotedSelection
        if (failedQuotedSelection) {
          setQuotedSelectionMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, failedQuotedSelection)
            return map
          })
        }
        restoreQueuedAttachmentsToPending(message.attachments)
      })
      return
    }

    // 清除当前会话的错误消息
    setAgentStreamErrors((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 清除当前会话的提示建议
    setPromptSuggestions((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 1. 如果有 pending 文件，先保存到 session 目录
    const attachmentContext = pendingFilesSnapshot.length > 0
      ? await preparePendingFilesForSend(pendingFilesSnapshot, additionalDirectoriesForRun)
      : null
    if (pendingFilesSnapshot.length > 0 && !attachmentContext) return
    let fileReferences = attachmentContext?.referenceBlock ?? ''

    // 构建引用选中文本：内联 XML 拼入 prompt，对话框不展示（parseAttachedFiles 剥离）
    const quotedSelection = isWorktreeContinuation ? null : consumeQuotedSelection()
    if (quotedSelection) {
      fileReferences = fileReferences + buildQuotedSelectionBlock(quotedSelection)
    }

    // 2. 构建最终消息
    const finalMessage = fileReferences + effectiveText
    const mentions = parseQueuedMessageMentions(isWorktreeContinuation ? '' : effectiveText)

    // 清除打断状态（上一轮的打断标记不再显示）
    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })

    // 取消 draft 标记，让会话出现在侧边栏
    setDraftSessionIds((prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })

    // 初始化流式状态（startedAt 由渲染进程生成，传递给主进程原样回传，确保竞态保护使用同一个值）
    const streamStartedAt = Date.now()

    // 重新对话即恢复为活跃会话：发送瞬间取消归档、刷新新鲜度并回到活跃列表。
    // 主进程启动 run 时会持久化相同语义；这里避免运行期间仍被归档视图隐藏。
    setAgentSessions((prev) => reactivateAgentSessionForSend(prev, sessionId, streamStartedAt))
    if (sessionMeta?.archived || store.get(sidebarViewModeAtom) === 'archived') {
      setSidebarViewMode('active')
    }

    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      const modelId = agentModelId || undefined
      const contextWindowOwner = buildAgentContextWindowOwner('pi', agentChannelId || undefined, modelId)
      const canReuseContextWindow = existing?.contextWindowOwner === contextWindowOwner
      const contextWindow = resolveRunContextWindow(
        modelId,
        agentChannelProvider,
        existing?.contextWindow,
        existing?.contextWindowOwner,
        contextWindowOwner,
      )
      map.set(sessionId, {
        running: true,
        toolActivities: [],
        model: modelId,
        startedAt: streamStartedAt,
        inputTokens: existing?.inputTokens,
        contextWindow,
        contextWindowSource: canReuseContextWindow
          ? existing?.contextWindowSource
          : contextWindow != null ? 'name_fallback' : undefined,
        contextWindowOwner,
      })
      return map
    })

    // 乐观更新：附言作为展示元数据挂在用户消息上，不混入正文与树摘要。
    const tempUserSDKMsg = createUserSDKMessage(finalMessage, undefined, Date.now(), nextTurnAsides)
    appendOptimisticPersistedMessage(tempUserSDKMsg)

    const input: AgentSendInput = {
      sessionId,
      userMessage: finalMessage,
      ...(nextTurnAsides.length > 0 && { nextTurnAsides }),
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      startedAt: streamStartedAt,
      ...(!isAuthorizedWorktreeContinuation ? buildAgentSendControlOverrides(executionControls) : {}),
      ...(runOptions?.worktreeContinuationAuthorizationToken && {
        worktreeContinuationAuthorizationToken: runOptions.worktreeContinuationAuthorizationToken,
      }),
      ...(additionalDirectoriesForRun.size > 0 && { additionalDirectories: Array.from(additionalDirectoriesForRun) }),
      ...(mentions.mentionedSkills.length > 0 && { mentionedSkills: mentions.mentionedSkills }),
      ...(mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: mentions.mentionedMcpServers }),
      ...(mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: mentions.mentionedSessionIds }),
      ...(mentions.mentionedTodoIds.length > 0 && { mentionedTodoIds: mentions.mentionedTodoIds }),
      ...(mentions.mentionedCalendarEventIds.length > 0 && { mentionedCalendarEventIds: mentions.mentionedCalendarEventIds }),
    }

    // 清空输入框（仅当发送的是用户自己输入的内容，而非推荐建议时）
    // 用 === undefined 与上方 `overrideText ?? inputContent` 的取值语义保持一致，
    // 避免未来出现 handleSend('') 时两条路径行为割裂
    if (overrideText === undefined) {
      setInputContent('')
      setInputHtmlContent('')
    }
    consumePendingAsides()

    try {
      await window.electronAPI.sendAgentMessage(input)
    } catch (error) {
      restorePendingAsides()
      console.error('[AgentView] 发送消息失败:', error)
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current) return prev
        const map = new Map(prev)
        map.set(sessionId, { ...current, running: false })
        return map
      })
      if (runOptions?.propagateSendFailure) throw error
    }
  }, [inputContent, createBaseAdditionalDirectories, preparePendingFilesForSend, restoreQueuedAttachmentsToPending, sessionId, sessionMeta?.archived, agentChannelId, agentModelId, agentChannelProvider, currentWorkspaceId, streaming, backgroundWaiting, suggestion, hasAvailableModel, store, consumeQuotedSelection, setStreamingStates, setAgentStreamErrors, setPromptSuggestions, setInputContent, setLiveMessagesMap, setAgentSessions, setSidebarViewMode, executionControls, permissionMode, messagesLoaded, queuedMessages, setQueuedMessages, setQuotedSelectionMap, sendPlainTextAgentMessage, sessionTargetInteraction.requireChoiceBeforeSend, sessionWorktreePending, sessionTargetState, bindSessionTarget, ensureInitialWorktreeTitle])

  React.useEffect(() => {
    if (!workspaceSendDeferred || !deferredWorkspaceSendRef.current) return
    if (!messagesLoaded || !agentChannelId || !hasAvailableModel) return
    if (!streaming && (messagesRefreshing || messagesRefreshingRef.current)) return

    const resolution = resolveDeferredWorkspaceSend({
      hasSnapshot: sessionTargetState.snapshot !== null,
      loading: sessionTargetState.loading || initialWorktreePreparing,
      errorMessage: sessionTargetState.error?.message,
    })
    if (resolution === 'wait') return

    const request = deferredWorkspaceSendRef.current
    deferredWorkspaceSendRef.current = null
    setWorkspaceSendDeferred(false)
    if (resolution === 'fail') {
      toast.error('工作区准备失败，消息未发送', {
        description: sessionTargetState.error?.message
          ? `${sessionTargetState.error.message}。输入内容已保留。`
          : '输入内容已保留，请重试检查工作区。',
      })
      return
    }

    queueMicrotask(() => {
      void handleSend(request.overrideText, request.requestedQueueKind)
    })
  }, [agentChannelId, handleSend, hasAvailableModel, initialWorktreePreparing, messagesLoaded, messagesRefreshing, sessionTargetState.error?.message, sessionTargetState.loading, sessionTargetState.snapshot, streaming, workspaceSendDeferred])

  const resumedIterationRequestIdsRef = React.useRef(new Set<string>())
  const pendingIterationResumeRef = React.useRef<WorktreeIterationResumeDetail | null>(null)
  const sendIterationContinuation = React.useCallback((detail: WorktreeIterationResumeDetail): void => {
    if (resumedIterationRequestIdsRef.current.has(detail.requestId)) return
    if (detail.mode === 'next_iteration' && (!detail.authorizationToken || !detail.continuationMessage)) {
      consumeQueuedWorktreeIterationResume(detail.sessionId, detail.requestId)
      toast.error('本次执行未启动', { description: '缺少宿主签发的续跑授权，请在请求卡片中重新确认。' })
      return
    }
    const currentTargetState = store.get(sessionTargetStateAtomFamily(sessionId))
    const currentStreamState = store.get(agentStreamingStatesAtom).get(sessionId)
    const delivery = currentTargetState.snapshot?.delivery
    const targetIteration = delivery?.state === 'working' ? delivery.iteration : null
    if (
      currentStreamState?.running
      || currentStreamState?.backgroundWaiting
      || messagesRefreshingRef.current
      || !messagesLoaded
      || !agentChannelId
      || !hasAvailableModel
      || sessionTargetInteraction.requireChoiceBeforeSend
      || initialWorktreePreparationRef.current
      || currentTargetState.loading
      || currentTargetState.snapshot?.checkout.kind !== 'isolated'
      || targetIteration !== detail.iteration
    ) {
      pendingIterationResumeRef.current = detail
      return
    }
    pendingIterationResumeRef.current = null
    if (!claimQueuedWorktreeIterationResume(detail.sessionId, detail.requestId)) return
    resumedIterationRequestIdsRef.current.add(detail.requestId)
    const continuation = detail.mode === 'preview_revision'
      ? `第 ${detail.iteration} 轮 Local Preview 已安全撤回，验收槽位已释放。请立即在原 Worktree 中继续执行以下已确认调整，不要再次请求撤回验收：\n\n${detail.task}`
      : detail.continuationMessage!
    void handleSend(continuation, getAgentQueueSubmitKind(false), {
      worktreeContinuation: true,
      ...(detail.authorizationToken && { worktreeContinuationAuthorizationToken: detail.authorizationToken }),
      propagateSendFailure: true,
    }).then(() => {
      consumeQueuedWorktreeIterationResume(detail.sessionId, detail.requestId)
    }).catch((error) => {
      releaseClaimedWorktreeIterationResume(detail.sessionId, detail.requestId)
      resumedIterationRequestIdsRef.current.delete(detail.requestId)
      pendingIterationResumeRef.current = detail
      console.error('[AgentView] Worktree 自动续跑失败:', error)
      toast.error('Worktree 已准备完成，但自动续跑失败', {
        description: '续跑任务仍保留；重新打开该 Agent 会话后会再次尝试。',
      })
    })
  }, [agentChannelId, handleSend, hasAvailableModel, messagesLoaded, sessionId, sessionTargetInteraction.requireChoiceBeforeSend, store])
  React.useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeIterationResumeDetail>).detail
      if (!detail || detail.sessionId !== sessionId) return
      sendIterationContinuation(detail)
    }
    window.addEventListener(WORKTREE_ITERATION_RESUME_EVENT, handler)
    const unregisterConsumer = registerWorktreeIterationResumeConsumer(sessionId, sendIterationContinuation)
    const queued = getQueuedWorktreeIterationResume(sessionId)
    if (queued) sendIterationContinuation(queued)
    return () => {
      unregisterConsumer()
      window.removeEventListener(WORKTREE_ITERATION_RESUME_EVENT, handler)
    }
  }, [sendIterationContinuation, sessionId])
  React.useEffect(() => {
    const pending = pendingIterationResumeRef.current
    if (pending) sendIterationContinuation(pending)
  }, [agentChannelId, hasAvailableModel, messagesLoaded, messagesRefreshing, sendIterationContinuation, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])

  const resumedLocalMaintenanceRequestIdsRef = React.useRef(new Set<string>())
  const pendingLocalMaintenanceResumeRef = React.useRef<LocalMaintenanceResumeDetail | null>(null)
  const sendLocalMaintenanceContinuation = React.useCallback((detail: LocalMaintenanceResumeDetail): void => {
    if (resumedLocalMaintenanceRequestIdsRef.current.has(detail.requestId)) return
    if (
      streaming
      || messagesRefreshing
      || messagesRefreshingRef.current
      || !messagesLoaded
      || !agentChannelId
      || !hasAvailableModel
      || sessionTargetInteraction.requireChoiceBeforeSend
      || initialWorktreePreparationRef.current
      || sessionTargetState.loading
      || !sessionTargetState.snapshot
    ) {
      pendingLocalMaintenanceResumeRef.current = detail
      return
    }
    pendingLocalMaintenanceResumeRef.current = null
    resumedLocalMaintenanceRequestIdsRef.current.add(detail.requestId)
    const message = createAgentQueuedMessage(
      buildLocalMaintenanceContinuationPrompt(detail),
      crypto.randomUUID(),
      Date.now(),
      null,
      { additionalDirectories: [...createBaseAdditionalDirectories()] },
    )
    void sendPlainTextAgentMessage(message).then(() => {
      consumeQueuedLocalMaintenanceResume(detail.sessionId, detail.requestId)
    }).catch((error) => {
      resumedLocalMaintenanceRequestIdsRef.current.delete(detail.requestId)
      pendingLocalMaintenanceResumeRef.current = detail
      console.error('[AgentView] Local 维修事务自动续跑失败:', error)
      toast.error('Local 维修事务已开启，但自动续跑失败', {
        description: '续跑任务仍保留；重新打开该 Agent 会话后会再次尝试。',
      })
    })
  }, [agentChannelId, createBaseAdditionalDirectories, hasAvailableModel, messagesLoaded, messagesRefreshing, sendPlainTextAgentMessage, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])
  React.useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<LocalMaintenanceResumeDetail>).detail
      if (!detail || detail.sessionId !== sessionId) return
      sendLocalMaintenanceContinuation(detail)
    }
    window.addEventListener(LOCAL_MAINTENANCE_RESUME_EVENT, handler)
    const queued = getQueuedLocalMaintenanceResume(sessionId)
    if (queued) sendLocalMaintenanceContinuation(queued)
    return () => window.removeEventListener(LOCAL_MAINTENANCE_RESUME_EVENT, handler)
  }, [sendLocalMaintenanceContinuation, sessionId])
  React.useEffect(() => {
    const pending = pendingLocalMaintenanceResumeRef.current
    if (pending) sendLocalMaintenanceContinuation(pending)
  }, [agentChannelId, hasAvailableModel, messagesLoaded, messagesRefreshing, sendLocalMaintenanceContinuation, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])

  const resumedWorktreeConflictRequestIdsRef = React.useRef(new Set<string>())
  const pendingWorktreeConflictResumeRef = React.useRef<WorktreeApplyConflictResumeDetail | null>(null)
  const sendWorktreeConflictContinuation = React.useCallback((detail: WorktreeApplyConflictResumeDetail): void => {
    if (resumedWorktreeConflictRequestIdsRef.current.has(detail.requestId)) return
    if (
      streaming
      || messagesRefreshing
      || messagesRefreshingRef.current
      || !messagesLoaded
      || !agentChannelId
      || !hasAvailableModel
      || sessionTargetInteraction.requireChoiceBeforeSend
      || initialWorktreePreparationRef.current
      || sessionTargetState.loading
      || !sessionTargetState.snapshot
      || sessionTargetState.snapshot.checkout.kind !== 'isolated'
      || sessionTargetState.snapshot.checkout.id !== detail.checkoutId
    ) {
      pendingWorktreeConflictResumeRef.current = detail
      return
    }
    const claimedDetail = claimQueuedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)
    if (!claimedDetail) return
    pendingWorktreeConflictResumeRef.current = null
    resumedWorktreeConflictRequestIdsRef.current.add(claimedDetail.requestId)
    const message = createAgentQueuedMessage(
      buildWorktreeApplyConflictContinuationPrompt(claimedDetail),
      claimedDetail.requestId,
      Date.now(),
      null,
      { additionalDirectories: [...createBaseAdditionalDirectories()] },
    )
    void sendPlainTextAgentMessage(message).then(() => {
      consumeQueuedWorktreeApplyConflictResume(claimedDetail.sessionId, claimedDetail.requestId)
    }).catch((error) => {
      resumedWorktreeConflictRequestIdsRef.current.delete(claimedDetail.requestId)
      releaseClaimedWorktreeApplyConflictResume(claimedDetail.sessionId, claimedDetail.requestId)
      pendingWorktreeConflictResumeRef.current = claimedDetail
      console.error('[AgentView] Worktree Apply 冲突自动续跑失败:', error)
      toast.error('冲突处理任务已保留，但自动续跑失败', {
        description: '重新打开该 Agent 会话后会再次尝试。',
      })
    })
  }, [agentChannelId, createBaseAdditionalDirectories, hasAvailableModel, messagesLoaded, messagesRefreshing, sendPlainTextAgentMessage, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])
  React.useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeApplyConflictResumeDetail>).detail
      if (!detail || detail.sessionId !== sessionId) return
      sendWorktreeConflictContinuation(detail)
    }
    window.addEventListener(WORKTREE_APPLY_CONFLICT_RESUME_EVENT, handler)
    const queued = getQueuedWorktreeApplyConflictResume(sessionId)
    if (queued) sendWorktreeConflictContinuation(queued)
    return () => window.removeEventListener(WORKTREE_APPLY_CONFLICT_RESUME_EVENT, handler)
  }, [sendWorktreeConflictContinuation, sessionId])
  React.useEffect(() => {
    const pending = pendingWorktreeConflictResumeRef.current
    if (pending) sendWorktreeConflictContinuation(pending)
  }, [agentChannelId, hasAvailableModel, messagesLoaded, messagesRefreshing, sendWorktreeConflictContinuation, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])

  const resumedReviewRegenerationRequestIdsRef = React.useRef(new Set<string>())
  const pendingReviewRegenerationRef = React.useRef<WorktreeReviewRegenerationDetail | null>(null)
  const lastSentReviewRegenerationRef = React.useRef<WorktreeReviewRegenerationDetail | null>(null)
  const sendReviewRegenerationContinuation = React.useCallback((detail: WorktreeReviewRegenerationDetail): void => {
    if (resumedReviewRegenerationRequestIdsRef.current.has(detail.requestId)) return
    if (shouldDeferWorktreeReviewRegeneration(detail, {
      streaming,
      messagesRefreshing,
      messagesRefreshingRef: messagesRefreshingRef.current,
      messagesLoaded,
      hasAgentChannel: Boolean(agentChannelId),
      hasAvailableModel,
      requiresTargetChoice: sessionTargetInteraction.requireChoiceBeforeSend,
      preparingInitialWorktree: initialWorktreePreparationRef.current,
      targetLoading: sessionTargetState.loading,
      checkoutKind: sessionTargetState.snapshot?.checkout.kind ?? null,
      checkoutId: sessionTargetState.snapshot?.checkout.id ?? null,
    })) {
      pendingReviewRegenerationRef.current = detail
      return
    }
    pendingReviewRegenerationRef.current = null
    resumedReviewRegenerationRequestIdsRef.current.add(detail.requestId)
    lastSentReviewRegenerationRef.current = detail
    const message = createAgentQueuedMessage(
      buildWorktreeReviewRegenerationPrompt(detail),
      crypto.randomUUID(),
      Date.now(),
      null,
      { additionalDirectories: [...createBaseAdditionalDirectories()] },
    )
    void sendPlainTextAgentMessage(message).then(() => {
      consumeQueuedWorktreeReviewRegeneration(detail.sessionId, detail.requestId)
    }).catch((error) => {
      resumedReviewRegenerationRequestIdsRef.current.delete(detail.requestId)
      lastSentReviewRegenerationRef.current = null
      pendingReviewRegenerationRef.current = detail
      console.error('[AgentView] Worktree 验收结果重新生成续跑失败:', error)
      toast.error('重新验证任务已保留，但自动发送失败', {
        description: '重新打开该 Agent 会话后会再次尝试；Local 未修改。',
      })
    })
  }, [agentChannelId, createBaseAdditionalDirectories, hasAvailableModel, messagesLoaded, messagesRefreshing, sendPlainTextAgentMessage, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])
  React.useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeReviewRegenerationDetail>).detail
      if (!detail || detail.sessionId !== sessionId) return
      sendReviewRegenerationContinuation(detail)
    }
    window.addEventListener(WORKTREE_REVIEW_REGENERATION_EVENT, handler)
    const queued = getQueuedWorktreeReviewRegeneration(sessionId)
    if (queued) sendReviewRegenerationContinuation(queued)
    return () => window.removeEventListener(WORKTREE_REVIEW_REGENERATION_EVENT, handler)
  }, [sendReviewRegenerationContinuation, sessionId])
  React.useEffect(() => {
    const pending = pendingReviewRegenerationRef.current
    if (pending) sendReviewRegenerationContinuation(pending)
  }, [agentChannelId, hasAvailableModel, messagesLoaded, messagesRefreshing, sendReviewRegenerationContinuation, sessionTargetInteraction.requireChoiceBeforeSend, sessionTargetState.loading, sessionTargetState.snapshot, streaming])
  React.useEffect(() => {
    if (streaming || messagesRefreshing) return
    const sent = lastSentReviewRegenerationRef.current
    if (!sent) return
    const delivery = sessionTargetState.snapshot?.delivery
    if (delivery?.state === 'ready_for_review' && delivery.review.reviewId === sent.reviewId) {
      resumedReviewRegenerationRequestIdsRef.current.delete(sent.requestId)
    }
    lastSentReviewRegenerationRef.current = null
  }, [messagesRefreshing, sessionTargetState.snapshot?.delivery, streaming])

  React.useEffect(() => {
    if (streamState?.retrying?.phase !== 'scheduled') setRetryNowPending(false)
  }, [sessionId, streamState?.retrying?.currentAttempt, streamState?.retrying?.phase])

  /** 跳过当前自动重试等待，立即执行已经安排的恢复。 */
  const handleRetryNow = React.useCallback(async (): Promise<void> => {
    if (retryNowPending || streamState?.retrying?.phase !== 'scheduled') return
    setRetryNowPending(true)
    try {
      const started = await window.electronAPI.retryAgentNow(sessionId)
      if (!started) setRetryNowPending(false)
    } catch (error) {
      setRetryNowPending(false)
      console.error('[AgentView] 立即重试失败:', error)
      toast.error('立即重试失败', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [retryNowPending, sessionId, streamState?.retrying?.phase])

  /** 停止生成 */
  const handleStop = React.useCallback((): void => {
    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })

    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current || !current.running) return prev
      const map = new Map(prev)
      map.set(sessionId, {
        ...current,
        running: false,
        ...finalizeStreamingActivities(current.toolActivities),
      })
      return map
    })

    window.electronAPI.stopAgent(sessionId).catch(console.error)
  }, [sessionId, setStreamingStates, store])

  /** 手动发送 /compact 命令 */
  const handleCompact = React.useCallback((): void => {
    if (!agentChannelId || streaming) return

    const streamStartedAt = Date.now()
    const localUuid = crypto.randomUUID()
    const modelId = agentModelId || undefined
    const contextWindowOwner = buildAgentContextWindowOwner('pi', agentChannelId, modelId)

    // 1. 立即注入合成用户消息（/compact 气泡立刻可见，与普通发送路径一致）
    const syntheticMsg: import('@domi/shared').SDKMessage = {
      type: 'user',
      uuid: localUuid,
      message: {
        content: [{ type: 'text', text: '/compact' }],
      },
      parent_tool_use_id: null,
      _createdAt: streamStartedAt,
    } as unknown as import('@domi/shared').SDKMessage

    store.set(liveMessagesMapAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(sessionId) ?? []
      map.set(sessionId, [...current, syntheticMsg])
      return map
    })

    // 2. 初始化流式状态 + 乐观设 isCompacting=true（SDK compacting 事件之前就显示"正在压缩..."分隔符）
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      const current = existing ?? {
        running: true,
        toolActivities: [],
        model: modelId,
        startedAt: streamStartedAt,
      }
      const canReuseContextWindow = existing?.contextWindowOwner === contextWindowOwner
      const contextWindow = resolveRunContextWindow(
        modelId,
        agentChannelProvider,
        existing?.contextWindow,
        existing?.contextWindowOwner,
        contextWindowOwner,
      )
      map.set(sessionId, {
        ...current,
        running: true,
        startedAt: streamStartedAt,
        contextWindow,
        contextWindowSource: canReuseContextWindow
          ? existing?.contextWindowSource
          : contextWindow != null ? 'name_fallback' : undefined,
        contextWindowOwner,
        isCompacting: true,
        compactInFlight: true,
        contextCompaction: { status: 'running' },
      })
      return map
    })

    window.electronAPI.sendAgentMessage({
      sessionId,
      userMessage: '/compact',
      channelId: agentChannelId,
      modelId,
      workspaceId: currentWorkspaceId || undefined,
      startedAt: streamStartedAt,
      ...buildAgentSendControlOverrides(executionControls),
    }).catch((error) => {
      console.error('[AgentView] /compact 发送失败:', error)
      // 回滚：移除合成用户消息 + 清除 isCompacting flag
      store.set(liveMessagesMapAtom, (prev) => {
        const map = new Map(prev)
        const current = (map.get(sessionId) ?? []).filter(
          (m) => (m as unknown as { uuid?: string }).uuid !== localUuid,
        )
        map.set(sessionId, current)
        return map
      })
      setStreamingStates((prev) => {
        const map = new Map(prev)
        const current = prev.get(sessionId)
        if (!current) return prev
        map.set(sessionId, { ...current, isCompacting: false, compactInFlight: false })
        return map
      })
    })
  }, [sessionId, agentChannelId, agentModelId, agentChannelProvider, currentWorkspaceId, streaming, setStreamingStates, store, executionControls, permissionMode])

  /** 复制错误信息到剪贴板 */
  const handleCopyError = React.useCallback(async (): Promise<void> => {
    if (!agentError) return

    try {
      await copyTextToClipboard(agentError)
      setErrorCopied(true)
      setTimeout(() => setErrorCopied(false), 2000)
    } catch (error) {
      console.error('[AgentView] 复制错误信息失败:', error)
    }
  }, [agentError])

  const handleRelinkProjectRoot = React.useCallback(async (): Promise<void> => {
    if (!currentWorkspaceId) return
    try {
      const folder = await window.electronAPI.openFolderDialog()
      if (!folder) return
      const updated = await window.electronAPI.relinkAgentWorkspaceProjectRoot(currentWorkspaceId, folder.path)
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)))
      toast.success('本地项目根已重新关联', { description: folder.path })
    } catch (error) {
      console.error('[AgentView] 重新关联本地项目根失败:', error)
      toast.error(error instanceof Error ? error.message : '重新关联项目文件夹失败')
    }
  }, [currentWorkspaceId, setWorkspaces])

  const handleRestoreProjectRoot = React.useCallback(async (): Promise<void> => {
    if (!currentWorkspaceId) return
    try {
      setRestoringProjectRoot(true)
      const updated = await window.electronAPI.restoreAgentWorkspaceProjectRoot(currentWorkspaceId)
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)))
      toast.success('已在原路径新建空项目文件夹', { description: updated.projectRootPath })
      setRestoreProjectRootDialogOpen(false)
    } catch (error) {
      console.error('[AgentView] 恢复本地项目根失败:', error)
      toast.error(error instanceof Error ? error.message : '恢复项目文件夹失败')
    } finally {
      setRestoringProjectRoot(false)
    }
  }, [currentWorkspaceId, setWorkspaces])

  /** 重试：在当前会话中重新发送最后一条用户消息 */
  const handleRetry = React.useCallback((retryOfErrorUuid?: string): void => {
    if (!agentChannelId || streaming) return

    // 找到最后一条用户消息
    const lastUserMessage = [...persistedSDKMessages]
      .reverse()
      .map(getUserTextFromSDKMessage)
      .find((text): text is string => text !== null)
    if (!lastUserMessage) return

    // 与主进程按 UUID 的原子删除同步更新当前 React 状态和 LRU cache，避免旧错误
    // 在下一轮回复开始前仍被页面渲染。旧会话没有 UUID 时保留历史，由主进程幂等处理。
    const messagesAfterCleanup = removeRetriedErrorSDKMessage(persistedSDKMessages, retryOfErrorUuid)
    if (messagesAfterCleanup !== persistedSDKMessages) {
      persistedSDKMessagesRef.current = messagesAfterCleanup
      setPersistedSDKMessages(messagesAfterCleanup)
      setMessagesCache((prev) => setSessionMessagesCache(prev, sessionId, messagesAfterCleanup))
    }

    // 清除错误状态
    setAgentStreamErrors((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 初始化流式状态（startedAt 由渲染进程生成，传递给主进程原样回传）
    const streamStartedAt = Date.now()
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      const modelId = agentModelId || undefined
      const contextWindowOwner = buildAgentContextWindowOwner('pi', agentChannelId || undefined, modelId)
      const canReuseContextWindow = existing?.contextWindowOwner === contextWindowOwner
      const contextWindow = resolveRunContextWindow(
        modelId,
        agentChannelProvider,
        existing?.contextWindow,
        existing?.contextWindowOwner,
        contextWindowOwner,
      )
      map.set(sessionId, {
        running: true,
        toolActivities: [],
        model: modelId,
        startedAt: streamStartedAt,
        inputTokens: existing?.inputTokens,
        contextWindow,
        contextWindowSource: canReuseContextWindow
          ? existing?.contextWindowSource
          : contextWindow != null ? 'name_fallback' : undefined,
        contextWindowOwner,
      })
      return map
    })

    window.electronAPI.sendAgentMessage({
      sessionId,
      userMessage: lastUserMessage,
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      startedAt: streamStartedAt,
      ...buildAgentSendControlOverrides(executionControls),
      ...(retryOfErrorUuid && { retryOfErrorUuid }),
    }).catch(console.error)
  }, [persistedSDKMessages, sessionId, agentChannelId, agentModelId, agentChannelProvider, currentWorkspaceId, streaming, setAgentStreamErrors, setStreamingStates, setMessagesCache, executionControls, permissionMode])

  /** 在新对话继续：创建新会话 + 切换 tab + 使用 &session 引用旧会话 */
  const handleRetryInNewSession = React.useCallback(async (): Promise<void> => {
    if (!agentChannelId) return

    try {
      const meta = await window.electronAPI.createAgentSession(
        undefined, agentChannelId, currentWorkspaceId || undefined, agentModelId || undefined,
      )
      setAgentSessions((prev) => [meta, ...prev])
      const intent = buildRetryInNewSessionIntent(sessionId)
      if (intent.markAsDraft) {
        setDraftSessionIds((prev) => new Set(prev).add(meta.id))
      }

      // 切换到新会话 tab；Pi 草稿先显示 target chooser，pending prompt 在绑定后发送。
      openSession('agent', meta.id, meta.title)

      setPendingPrompt({
        sessionId: meta.id,
        message: intent.prompt,
        mentionedSessionIds: intent.mentionedSessionIds,
      })
    } catch (error) {
      console.error('[AgentView] 在新会话中重试失败:', error)
    }
  }, [sessionId, agentChannelId, agentModelId, currentWorkspaceId, openSession, setAgentSessions, setDraftSessionIds, setPendingPrompt])

  const [forkToWorktreeTargetUuid, setForkToWorktreeTargetUuid] = React.useState<string | null>(null)
  const [forkingSession, setForkingSession] = React.useState(false)
  const forkingSessionRef = React.useRef(false)

  /** 从指定消息创建子会话；目标选择由 main 作为一个生命周期操作执行。 */
  const forkSessionFromMessage = React.useCallback(async (
    upToMessageUuid: string,
    target: ForkSessionTargetChoice,
  ): Promise<void> => {
    if (forkingSessionRef.current) return
    if (agentModelId && agentChannelId && sessionMetaChannelId && agentChannelId !== sessionMetaChannelId) {
      toast.error('分叉会话失败', {
        description: '分叉只能使用源会话同一渠道下的模型，请切回当前会话渠道后再试。',
      })
      return
    }
    const forkModelId = agentChannelId === sessionMetaChannelId ? agentModelId || undefined : undefined

    forkingSessionRef.current = true
    setForkingSession(true)
    try {
      const meta = await window.electronAPI.forkAgentSession({
        sessionId,
        upToMessageUuid,
        modelId: forkModelId,
        target,
      })
      setAgentSessions((prev) => [meta, ...prev])
      openSession('agent', meta.id, meta.title)
      toast.success(
        target.kind === 'isolated-copy'
          ? '已复制当前修改到独立 Worktree'
          : target.kind === 'isolated'
            ? '已创建 Worktree 分叉'
            : '已创建分叉会话',
        { description: meta.title },
      )
    } catch (error) {
      console.error('[AgentView] 分叉会话失败:', error)
      const rawMsg = error instanceof Error ? error.message : '未知错误'
      const friendlyDesc = /not found in session/i.test(rawMsg)
        ? '该消息无法作为分叉起点（可能属于子代理执行过程或已被清理）。请选择主对话中的其他消息再试。'
        : rawMsg
      toast.error(
        target.kind === 'isolated-copy'
          ? 'Worktree 复制失败'
          : target.kind === 'isolated'
            ? 'Worktree 分叉失败'
            : '分叉会话失败',
        { description: friendlyDesc },
      )
    } finally {
      forkingSessionRef.current = false
      setForkingSession(false)
    }
  }, [sessionId, agentChannelId, agentModelId, sessionMetaChannelId, openSession, setAgentSessions])

  const handleFork = React.useCallback((upToMessageUuid: string): void => {
    void forkSessionFromMessage(upToMessageUuid, sessionTargetState.snapshot?.checkout.kind === 'isolated'
      ? { kind: 'isolated-copy' }
      : { kind: 'inherit' })
  }, [forkSessionFromMessage, sessionTargetState.snapshot?.checkout.kind])

  const handleForkToWorktree = React.useCallback((upToMessageUuid: string): void => {
    if (sessionTargetState.snapshot?.checkout.kind !== 'local') return
    setForkToWorktreeTargetUuid(upToMessageUuid)
  }, [sessionTargetState.snapshot?.checkout.kind])

  const handleForkToWorktreeConfirm = React.useCallback(async (): Promise<void> => {
    const targetUuid = forkToWorktreeTargetUuid
    if (!targetUuid) return
    await forkSessionFromMessage(targetUuid, { kind: 'isolated', confirmDirty: true })
    setForkToWorktreeTargetUuid(null)
  }, [forkSessionFromMessage, forkToWorktreeTargetUuid])

  // ===== Slash 命令宿主（/ 菜单 → 会话控制） =====
  const [slashStatusOpen, setSlashStatusOpen] = React.useState(false)
  const [slashReasoningOpen, setSlashReasoningOpen] = React.useState(false)
  const [slashWorkflowOpen, setSlashWorkflowOpen] = React.useState(false)
  const [slashForkOpen, setSlashForkOpen] = React.useState(false)

  const setSessionWorkflow = React.useCallback((workflow: AgentWorkflow): void => {
    void window.electronAPI.updateSessionExecutionControls(sessionId, { workflow })
      .then((persisted) => setAgentSessions((prev) => prev.map((s) => (s.id === sessionId ? persisted : s))))
      .catch((error) => toast.error('工作方式切换失败', { description: getErrorMessage(error) }))
  }, [sessionId, setAgentSessions])

  const slashHost = React.useMemo<SlashCommandHost>(() => ({
    openStatusCard: () => setSlashStatusOpen(true),
    openModelSelector: () => store.set(modelSelectorOpenAtom, true),
    openReasoningPicker: () => setSlashReasoningOpen(true),
    openWorkflowPicker: () => setSlashWorkflowOpen(true),
    openSessionTree: () => {
      const next = toggleSessionTreeOpen(store.get(sessionTreeOpenMapAtom), sessionId)
      store.set(sessionTreeOpenMapAtom, next)
    },
    openForkPicker: () => setSlashForkOpen(true),
    setWorkflow: setSessionWorkflow,
  }), [store, sessionId, setSessionWorkflow])

  React.useEffect(() => {
    registerBuiltinSlashCommands()
    setSlashCommandHost(slashHost)
    return () => setSlashCommandHost(null)
  }, [slashHost])

  const handleSlashCommand = React.useCallback((commandId: string, args: string[]): void => {
    executeSlashCommand(commandId, args, {
      sessionId,
      getState: store.get,
      workspaceSlug,
      isStreaming: streaming,
    })
  }, [sessionId, store, workspaceSlug, streaming])

  /** /fork 默认以最后一条可引用消息为起点。 */
  const handleSlashFork = React.useCallback((choice: string): void => {
    const lastMessage = [...liveMessages].reverse().find(
      (m) => typeof (m as { uuid?: unknown }).uuid === 'string',
    ) as (SDKMessage & { uuid: string }) | undefined
    if (!lastMessage) {
      toast.error('无法 Fork', { description: '当前没有可用的分叉起点消息' })
      return
    }
    if (choice === 'isolated' && sessionTargetState.snapshot?.checkout.kind !== 'local') {
      toast.error('无法 Fork 到 Worktree', { description: '仅 Local 会话可 Fork 到 Managed Worktree' })
      return
    }
    void forkSessionFromMessage(lastMessage.uuid, choice === 'isolated'
      ? { kind: 'isolated', confirmDirty: true }
      : sessionTargetState.snapshot?.checkout.kind === 'isolated'
        ? { kind: 'isolated-copy' }
        : { kind: 'inherit' })
  }, [liveMessages, forkSessionFromMessage, sessionTargetState.snapshot?.checkout.kind])

  /** 快照回退：同一会话内回退到指定消息点，恢复文件 + 截断对话 */
  const [rewindTargetUuid, setRewindTargetUuid] = React.useState<string | null>(null)
  const [rewindPreview, setRewindPreview] = React.useState<RewindSessionPreview | null>(null)
  const [rewindPreviewLoading, setRewindPreviewLoading] = React.useState(false)
  const [rewindInProgress, setRewindInProgress] = React.useState(false)
  const [rewindUndoState, setRewindUndoState] = React.useState<RewindUndoState | null>(null)
  const [rewindUndoInProgress, setRewindUndoInProgress] = React.useState(false)
  const rewindPreviewRequestRef = React.useRef(0)

  const refreshRewindUndoState = React.useCallback(async (): Promise<void> => {
    try {
      const state = await window.electronAPI.getRewindUndoState({ sessionId })
      setRewindUndoState(state)
      if (state.recoveryPerformed) {
        store.set(agentMessageRefreshAtom, (prev) => {
          const map = new Map(prev)
          map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
          return map
        })
        store.set(agentDiffRefreshVersionAtom, (prev) => {
          const map = new Map(prev)
          map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
          return map
        })
        void window.electronAPI.getSessionTree(sessionId).then(setSessionTree).catch(console.warn)
      }
    } catch (error) {
      console.warn('[AgentView] 读取撤销回退状态失败:', error)
      setRewindUndoState(null)
    }
  }, [sessionId, store])

  React.useEffect(() => {
    void refreshRewindUndoState()
  }, [persistedSDKMessages.length, refreshRewindUndoState])

  const handleRewindRequest = React.useCallback((assistantMessageUuid: string): void => {
    const requestId = ++rewindPreviewRequestRef.current
    setRewindTargetUuid(assistantMessageUuid)
    setRewindPreview(null)
    setRewindPreviewLoading(true)
    void window.electronAPI.previewRewindSession({ sessionId, assistantMessageUuid })
      .then((preview) => {
        if (rewindPreviewRequestRef.current === requestId) setRewindPreview(preview)
      })
      .catch((error) => {
        if (rewindPreviewRequestRef.current !== requestId) return
        setRewindPreview({
          fileRewind: {
            available: false,
            changes: [],
            conflicts: [],
            unsupported: [],
            error: error instanceof Error ? error.message : '无法预览文件影响',
          },
        })
      })
      .finally(() => {
        if (rewindPreviewRequestRef.current === requestId) setRewindPreviewLoading(false)
      })
  }, [sessionId])

  const handleRewindConfirm = React.useCallback(async (): Promise<void> => {
    if (!rewindTargetUuid) return
    const targetUuid = rewindTargetUuid
    setRewindInProgress(true)

    try {
      const result = await window.electronAPI.rewindSession({
        sessionId,
        assistantMessageUuid: targetUuid,
      })

      // 回退会截断未来 turn；先使 live usage 失效，让截断后的权威历史重新水合。
      setStreamingStates((prev) => {
        const state = prev.get(sessionId)
        if (!state) return prev
        const map = new Map(prev)
        map.set(sessionId, {
          ...state,
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          cacheCreationTokens: undefined,
          costUsd: undefined,
          contextBreakdown: undefined,
          contextWindow: undefined,
          contextWindowSource: undefined,
          contextWindowOwner: undefined,
          contextUsageIsEstimated: undefined,
          contextUsageOrigin: undefined,
        })
        return map
      })

      // 刷新消息列表
      store.set(agentMessageRefreshAtom, (prev) => {
        const map = new Map(prev)
        map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
        return map
      })

      // 刷新预览面板的 diff（文件已被回退，当前显示的内容已过期）
      store.set(agentDiffRefreshVersionAtom, (prev) => {
        const m = new Map(prev); m.set(sessionId, (prev.get(sessionId) ?? 0) + 1); return m
      })

      if (result.fileRewind?.canRewind) {
        const fileCount = result.fileRewind.filesChanged?.length ?? 0
        toast.success('已回退到此处', {
          description: fileCount > 0
            ? `${fileCount} 个文件已恢复${result.verificationInvalidated ? '，需要重新验证' : ''}`
            : '文件无变化',
        })
      } else if (result.fileRewind?.error) {
        toast.warning('已回退对话', {
          description: `文件恢复不可用：${result.fileRewind.error}`,
        })
      } else {
        toast.success('已回退到此处')
      }
      await refreshRewindUndoState()
      setRewindTargetUuid(null)
      setRewindPreview(null)
    } catch (error) {
      console.error('[AgentView] 回退失败:', error)
      toast.error('回退失败', {
        description: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setRewindInProgress(false)
    }
  }, [refreshRewindUndoState, rewindTargetUuid, sessionId, setStreamingStates, store])

  const handleUndoRewind = React.useCallback(async (): Promise<void> => {
    if (!rewindUndoState?.available || rewindUndoInProgress) return
    setRewindUndoInProgress(true)
    try {
      const result = await window.electronAPI.undoRewindSession({ sessionId })
      setStreamingStates((prev) => {
        const state = prev.get(sessionId)
        if (!state) return prev
        const map = new Map(prev)
        map.set(sessionId, {
          ...state,
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          cacheCreationTokens: undefined,
          costUsd: undefined,
          contextBreakdown: undefined,
          contextWindow: undefined,
          contextWindowSource: undefined,
          contextWindowOwner: undefined,
          contextUsageIsEstimated: undefined,
          contextUsageOrigin: undefined,
        })
        return map
      })
      store.set(agentMessageRefreshAtom, (prev) => {
        const map = new Map(prev)
        map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
        return map
      })
      store.set(agentDiffRefreshVersionAtom, (prev) => {
        const map = new Map(prev)
        map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
        return map
      })
      void window.electronAPI.getSessionTree(sessionId).then(setSessionTree).catch(console.warn)
      setRewindUndoState({ exists: false, available: false, filesChanged: [], conflicts: [] })
      toast.success('已撤销回退', {
        description: result.filesChanged.length > 0
          ? `${result.filesChanged.length} 个文件和对话已恢复${result.verificationInvalidated ? '，需要重新验证' : ''}`
          : '对话已恢复',
      })
    } catch (error) {
      console.error('[AgentView] 撤销回退失败:', error)
      toast.error('撤销回退失败', { description: error instanceof Error ? error.message : '未知错误' })
      await refreshRewindUndoState()
    } finally {
      setRewindUndoInProgress(false)
    }
  }, [refreshRewindUndoState, rewindUndoInProgress, rewindUndoState?.available, sessionId, setStreamingStates, store])

  // 监听快捷键系统分发的 stop-generation 事件
  React.useEffect(() => {
    const handler = (): void => {
      if (streaming) handleStop()
    }
    window.addEventListener('proma:stop-generation', handler)
    return () => window.removeEventListener('proma:stop-generation', handler)
  }, [streaming, handleStop])

  // 监听快捷键系统分发的 focus-input 事件（Cmd+L）
  React.useEffect(() => {
    const handler = (): void => {
      const proseMirror = document.querySelector('[data-input-mode="agent"] .ProseMirror') as HTMLElement | null
      proseMirror?.focus()
    }
    window.addEventListener('proma:focus-input', handler)
    return () => window.removeEventListener('proma:focus-input', handler)
  }, [])

  // 监听文件面板三点菜单「引用到 Agent」事件：在输入框插入 @file 引用
  React.useEffect(() => {
    const handler = (event: Event): void => {
      const items = (event as CustomEvent<FilePanelDragItem[]>).detail
      if (!items || items.length === 0) return
      richTextInputRef.current?.insertFileMentions(items)
    }
    window.addEventListener(INSERT_FILE_MENTION_EVENT, handler)
    return () => window.removeEventListener(INSERT_FILE_MENTION_EVENT, handler)
  }, [])

  const allAskUserRequests = useAtomValue(allPendingAskUserRequestsAtom)
  const allPermissionRequests = useAtomValue(allPendingPermissionRequestsAtom)
  const allExitPlanRequests = useAtomValue(allPendingExitPlanRequestsAtom)
  const hasBannerOverlay =
    (allAskUserRequests.get(sessionId)?.length ?? 0) > 0 ||
    (allExitPlanRequests.get(sessionId)?.length ?? 0) > 0
  const hasBlockingRequests = hasBannerOverlay
    || (allPermissionRequests.get(sessionId)?.some((request) => !request.deferred) ?? false)
  // 新会话只替换消息区域内容，Composer 的位置与宽度沿用普通会话。
  // 等待首次消息加载完成后再判定，避免切换会话时闪烁。
  const isSessionEmpty = messagesLoaded
    && persistedSDKMessages.length === 0
    && liveMessages.length === 0
    && !streaming

  /** 新会话任务入口：预填 Composer 并聚焦，由用户补全任务描述后发送。 */
  const handleWelcomePromptPick = React.useCallback((text: string): void => {
    setInputContent(text)
    setInputHtmlContent('')
    requestAnimationFrame(() => richTextInputRef.current?.focus())
  }, [setInputContent, setInputHtmlContent])
  const hasActiveNativeQueue = hasActiveNativeMessageQueue(streaming, backgroundWaiting)
  const canAdjustQueuedDirection = messagesLoaded && hasActiveNativeQueue && !!agentChannelId && hasAvailableModel && !hasBlockingRequests
  const autoSendingQueuedRef = React.useRef(false)

  const buildQueueReplayInputs = React.useCallback((messages: AgentQueuedMessage[]): AgentQueueReplayMessageInput[] => (
    getNativeQueuedMessages(orderQueuedMessagesForDelivery(messages)).map((message) => {
      const quotedSelectionBlock = message.quotedSelection
        ? buildQuotedSelectionBlock(message.quotedSelection)
        : ''
      const payload = buildQueuedMessageSendPayload(message, quotedSelectionBlock)
      return {
        uuid: message.id,
        kind: message.kind,
        userMessage: payload.sdkText,
        rawUserMessage: payload.rawText,
        ...(message.nextTurnAsides?.length ? { nextTurnAsides: message.nextTurnAsides } : {}),
        ...(payload.mentions.mentionedSkills.length > 0 && { mentionedSkills: payload.mentions.mentionedSkills }),
        ...(payload.mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: payload.mentions.mentionedMcpServers }),
        ...(payload.mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: payload.mentions.mentionedSessionIds }),
        ...(payload.mentions.mentionedTodoIds.length > 0 && { mentionedTodoIds: payload.mentions.mentionedTodoIds }),
        ...(payload.mentions.mentionedCalendarEventIds.length > 0 && { mentionedCalendarEventIds: payload.mentions.mentionedCalendarEventIds }),
      }
    })
  ), [])

  const replacePiNativeQueue = React.useCallback(async (messages: AgentQueuedMessage[]): Promise<void> => {
    const result = await window.electronAPI.replaceAgentMessageQueue({
      sessionId,
      messages: buildQueueReplayInputs(messages),
    })
    const replayedIds = new Set(result.messageUuids)
    setQueuedMessages((current) => current.filter((message) => (
      message.kind === 'aside' || replayedIds.has(message.id)
    )))
  }, [buildQueueReplayInputs, sessionId, setQueuedMessages])

  const restoreQueuedMessageToEditor = React.useCallback((message: AgentQueuedMessage): void => {
    if (message.quotedSelection) {
      setQuotedSelectionMap((prev) => {
        const map = new Map(prev)
        map.set(sessionId, message.quotedSelection!)
        return map
      })
    }
    restoreQueuedAttachmentsToPending(message.attachments)
    const hasDraft = inputContent.trim().length > 0
    setInputContent(hasDraft ? `${inputContent.trimEnd()}\n\n${message.text}` : message.text)
    if (hasDraft) {
      const draftHtml = inputHtmlContent.trim().length > 0
        ? inputHtmlContent
        : queuedTextToParagraphHtml(inputContent)
      setInputHtmlContent(`${draftHtml}${queuedTextToParagraphHtml(message.text)}`)
    } else {
      setInputHtmlContent('')
    }
  }, [inputContent, inputHtmlContent, restoreQueuedAttachmentsToPending, sessionId, setInputContent, setInputHtmlContent, setQuotedSelectionMap])

  const handleAdjustQueuedDirection = React.useCallback((messageId: string): void => {
    const previous = queuedMessages
    const message = previous.find((item) => item.id === messageId)
    if (message?.kind !== 'followUp' || message.delivery === 'deferred') return
    const next = changeQueuedMessageKind(previous, messageId, 'steering')
    setQueuedMessages(next)
    if (!hasActiveNativeQueue) return
    void replacePiNativeQueue(next).catch((error) => {
      if (isStaleAgentQueueError(error)) return
      setQueuedMessages((current) => changeQueuedMessageKind(current, messageId, 'followUp'))
      toast.error('调整方向失败', { description: String(error) })
    })
  }, [hasActiveNativeQueue, queuedMessages, replacePiNativeQueue, setQueuedMessages])

  const handleRecallQueuedMessage = React.useCallback((messageId: string): void => {
    const message = queuedMessages.find((item) => item.id === messageId)
    if (!message) return
    const previous = queuedMessages
    const withoutMessage = removeQueuedMessage(previous, messageId)
    const next = message.kind === 'aside'
      ? withoutMessage
      : restoreFailedAsideMessages(withoutMessage, createAsideQueuedMessages(message.nextTurnAsides))
    setQueuedMessages(next)
    if (message.delivery === 'deferred') {
      void window.electronAPI.cancelDeferredAgentMessage({ sessionId, messageId })
        .then((cancelled) => {
          if (cancelled) {
            restoreQueuedMessageToEditor(message)
          } else {
            setQueuedMessages(previous)
            toast.info('消息已开始发送，无法撤回')
          }
        })
        .catch((error) => {
          setQueuedMessages(previous)
          toast.error('撤回排队消息失败', { description: String(error) })
        })
      return
    }
    if (message.kind === 'aside' || !hasActiveNativeQueue) {
      restoreQueuedMessageToEditor(message)
      return
    }
    void replacePiNativeQueue(next)
      .then(() => restoreQueuedMessageToEditor(message))
      .catch((error) => {
        if (isStaleAgentQueueError(error)) {
          restoreQueuedMessageToEditor(message)
          return
        }
        setQueuedMessages(previous)
        toast.error('撤回排队消息失败', { description: String(error) })
      })
  }, [hasActiveNativeQueue, queuedMessages, replacePiNativeQueue, restoreQueuedMessageToEditor, setQueuedMessages])

  const handleRemoveQueuedMessage = React.useCallback((messageId: string): void => {
    const previous = queuedMessages
    const message = previous.find((item) => item.id === messageId)
    const next = removeQueuedMessage(previous, messageId)
    setQueuedMessages(next)
    if (message?.delivery === 'deferred') {
      void window.electronAPI.cancelDeferredAgentMessage({ sessionId, messageId })
        .then((cancelled) => {
          if (!cancelled) setQueuedMessages(previous)
        })
        .catch((error) => {
          setQueuedMessages(previous)
          toast.error('删除排队消息失败', { description: String(error) })
        })
      return
    }
    if (message?.kind === 'aside' || !hasActiveNativeQueue) return
    void replacePiNativeQueue(next).catch((error) => {
      if (isStaleAgentQueueError(error)) return
      setQueuedMessages(previous)
      toast.error('删除排队消息失败', { description: String(error) })
    })
  }, [hasActiveNativeQueue, queuedMessages, replacePiNativeQueue, setQueuedMessages])

  const handleMoveQueuedMessage = React.useCallback((
    sourceId: string,
    targetId: string,
    placement: QueueDropPlacement,
  ): void => {
    const previous = queuedMessages
    const source = previous.find((item) => item.id === sourceId)
    const next = moveQueuedMessage(previous, sourceId, targetId, placement)
    setQueuedMessages(next)
    if (source?.delivery === 'deferred') {
      void window.electronAPI.moveDeferredAgentMessage({ sessionId, sourceId, targetId, placement })
        .then((moved) => {
          if (!moved) setQueuedMessages(previous)
        })
        .catch((error) => {
          setQueuedMessages(previous)
          toast.error('调整排队顺序失败', { description: String(error) })
        })
      return
    }
    if (source?.kind === 'aside' || !hasActiveNativeQueue) return
    void replacePiNativeQueue(next).catch((error) => {
      if (isStaleAgentQueueError(error)) return
      setQueuedMessages(previous)
      toast.error('调整排队顺序失败', { description: String(error) })
    })
  }, [hasActiveNativeQueue, queuedMessages, replacePiNativeQueue, setQueuedMessages])

  const handleEscapeAbortAndRestore = React.useCallback(async (): Promise<void> => {
    if (!streaming) return
    // Escape 可能紧跟在一次入队 setAtom 后发生；同步读取 store，避免 React 闭包漏掉最后一条的附件/引用等元数据。
    const queueSnapshot = store.get(agentMessageQueueAtomFamily(sessionId))
    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => new Set(prev).add(sessionId))
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current) return prev
      const next = new Map(prev)
      next.set(sessionId, {
        ...current,
        running: false,
        ...finalizeStreamingActivities(current.toolActivities),
      })
      return next
    })

    try {
      const cleared = await window.electronAPI.clearAgentMessageQueue({ sessionId, abort: true })
      const restoredRecords = [...cleared.steering, ...cleared.followUp]
      const restoredMessages = resolveClearedQueuedMessages(queueSnapshot, restoredRecords)
      // 附言不属于 SDK clearQueue；尚未绑定的附言继续等待，已绑定到原生队列消息的附言拆回可编辑附言。
      const restoredBoundAsides = restoredMessages.flatMap((message) => (
        createAsideQueuedMessages(message.nextTurnAsides)
      ))
      setQueuedMessages(restoreFailedAsideMessages(
        getAsideQueuedMessages(queueSnapshot),
        restoredBoundAsides,
      ))

      if (restoredMessages.length > 0) {
        for (const message of restoredMessages) restoreQueuedAttachmentsToPending(message.attachments)
        const messagesWithQuote = restoredMessages.filter((message) => message.quotedSelection)
        if (messagesWithQuote.length === 1) {
          const quoted = messagesWithQuote[0]!.quotedSelection!
          setQuotedSelectionMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, quoted)
            return map
          })
        }
        // 输入区只能承载一个引用 chip；多条队列各自带引用时改为内联协议块，确保 Escape 恢复内容无损。
        const editorMessages = messagesWithQuote.length > 1
          ? restoredMessages.map((message) => message.quotedSelection
            ? { ...message, text: `${buildQuotedSelectionBlock(message.quotedSelection)}\n\n${message.text}` }
            : message)
          : restoredMessages
        const restoredText = editorMessages.map((message) => message.text).filter(Boolean).join('\n\n')
        const hasDraft = inputContent.trim().length > 0
        setInputContent(mergeRestoredQueuedMessagesIntoDraft(inputContent, editorMessages))
        if (hasDraft) {
          const draftHtml = inputHtmlContent.trim().length > 0
            ? inputHtmlContent
            : queuedTextToParagraphHtml(inputContent)
          setInputHtmlContent(`${draftHtml}${queuedTextToParagraphHtml(restoredText)}`)
        } else {
          setInputHtmlContent('')
        }
      }
    } catch (error) {
      console.error('[AgentView] Escape 中止并恢复队列失败:', error)
      toast.error('中止并恢复队列失败', { description: String(error) })
    }
  }, [inputContent, inputHtmlContent, restoreQueuedAttachmentsToPending, sessionId, setInputContent, setInputHtmlContent, setQueuedMessages, setQuotedSelectionMap, setStreamingStates, store, streaming])

  React.useEffect(() => {
    const handleQueueKeyboard = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === 'ArrowUp' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const recent = getMostRecentQueuedMessage(queuedMessages)
        if (!recent) return
        event.preventDefault()
        event.stopPropagation()
        handleRecallQueuedMessage(recent.id)
        return
      }
      if (event.key !== 'Escape') return

      // 键盘分发优先级：mention 弹窗 > Session Tree 非模态浮窗 > 页面/模态层 > Agent abort。
      // 只检查当前 session 容器，避免后台 tab 的 TipTap decoration 吞掉本会话 Escape。
      const sessionRoot = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-session-id]'))
        .find((element) => element.dataset.agentSessionId === sessionId)
      if (sessionRoot?.querySelector('[data-decoration-id]')) return
      const treeEscape = closeSessionTreeForEscape(store.get(sessionTreeOpenMapAtom), sessionId)
      if (treeEscape.handled) {
        event.preventDefault()
        event.stopPropagation()
        store.set(sessionTreeOpenMapAtom, treeEscape.state)
        return
      }
      if (!streaming) return

      // 设置页会保留后台 AgentView 但把主工作区标为 aria-hidden；Radix Dialog/AlertDialog
      // 也应先消费 Escape。否则这里的 window 监听会把“返回/关闭弹窗”误判成停止 Agent。
      const hasOpenDialog = document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      ) !== null
      if (!shouldHandleAgentEscapeAbort({
        sessionRootPresent: sessionRoot !== undefined,
        sessionRootHidden: sessionRoot?.closest('[aria-hidden="true"]') !== null,
        hasOpenDialog,
      })) return

      event.preventDefault()
      event.stopPropagation()
      const decision = decideAgentEscapeAbort(escapeAbortArmedUntilRef.current)
      escapeAbortArmedUntilRef.current = decision.armedUntil
      const toastId = `agent-escape-abort-${sessionId}`
      if (decision.action === 'confirm') {
        toast.info('再次按 Esc 停止 Agent', {
          id: toastId,
          description: '当前任务仍在运行',
          duration: AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS,
        })
        return
      }

      toast.dismiss(toastId)
      void handleEscapeAbortAndRestore()
    }
    // 使用 bubble 阶段，让输入控件、Radix 浮层等局部 Escape 行为先执行并设置 defaultPrevented。
    window.addEventListener('keydown', handleQueueKeyboard)
    return () => window.removeEventListener('keydown', handleQueueKeyboard)
  }, [handleEscapeAbortAndRestore, handleRecallQueuedMessage, queuedMessages, sessionId, store, streaming])

  React.useEffect(() => {
    if (streaming) return
    escapeAbortArmedUntilRef.current = null
    toast.dismiss(`agent-escape-abort-${sessionId}`)
  }, [sessionId, streaming])

  // ===== Right Workspace Preview 与 Session Tree 浮窗使用完全独立的状态 =====
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const rightWorkspaceOpen = useAtomValue(rightWorkspaceOpenAtom)
  const rightWorkspaceStateMap = useAtomValue(rightWorkspaceSessionStateMapAtom)
  const setRightWorkspaceOpen = useSetAtom(rightWorkspaceOpenAtom)
  const setRightWorkspaceState = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const sessionTreeOpenMap = useAtomValue(sessionTreeOpenMapAtom)
  const setSessionTreeOpenMap = useSetAtom(sessionTreeOpenMapAtom)
  const sessionTreeOpen = isSessionTreeOpen(sessionTreeOpenMap, sessionId)

  const togglePreviewPanel = React.useCallback(() => {
    if (!previewFileMap.get(sessionId)) return
    if (rightWorkspaceOpen && rightWorkspaceStateMap.get(sessionId)?.activeTool === 'preview') {
      setRightWorkspaceOpen(false)
      return
    }
    setRightWorkspaceState((current) => activateSessionRightWorkspaceTab(current, sessionId, 'preview'))
    setRightWorkspaceOpen(true)
  }, [
    previewFileMap,
    rightWorkspaceOpen,
    rightWorkspaceStateMap,
    sessionId,
    setRightWorkspaceOpen,
    setRightWorkspaceState,
  ])

  const updateSessionTreeOpen = React.useCallback((open: boolean) => {
    setSessionTreeOpenMap((prev) => setSessionTreeOpen(prev, sessionId, open))
  }, [sessionId, setSessionTreeOpenMap])

  const toggleSessionTree = React.useCallback(() => {
    setSessionTreeOpenMap((prev) => toggleSessionTreeOpen(prev, sessionId))
  }, [sessionId, setSessionTreeOpenMap])

  React.useEffect(() => registerShortcut('toggle-preview-panel', togglePreviewPanel), [togglePreviewPanel])
  React.useEffect(() => registerShortcut('toggle-session-tree', toggleSessionTree), [toggleSessionTree])

  const scrollToTreeNode = React.useCallback((index: number): void => {
    scrollSessionTreeMessageIntoView(sessionId, index)
  }, [sessionId])

  React.useEffect(() => {
    const handleScroll = (event: Event): void => {
      const detail = (event as CustomEvent<SessionTreeScrollEventDetail>).detail
      if (detail?.sessionId !== sessionId || !detail.node.isOnActiveBranch) return
      scrollToTreeNode(detail.node.branchMessageIndex)
    }
    const handleNavigated = (event: Event): void => {
      const detail = (event as CustomEvent<SessionTreeNavigatedEventDetail>).detail
      if (detail?.sessionId !== sessionId) return
      if (detail.editorText !== undefined) {
        setInputContent(detail.editorText)
        setInputHtmlContent('')
        requestAnimationFrame(() => richTextInputRef.current?.focus())
      }
      if (detail.abortedRun) {
        setStreamingStates((prev) => {
          const current = prev.get(sessionId)
          if (!current) return prev
          const next = new Map(prev)
          next.set(sessionId, { ...current, running: false, ...finalizeStreamingActivities(current.toolActivities) })
          return next
        })
      }
      setLiveMessagesMap((prev) => {
        if (!prev.has(sessionId)) return prev
        const next = new Map(prev)
        next.delete(sessionId)
        return next
      })
      const currentVersion = store.get(agentMessageRefreshAtom).get(sessionId) ?? 0
      const targetVersion = currentVersion + 1
      store.set(agentMessageRefreshAtom, (prev) => {
        const next = new Map(prev)
        next.set(sessionId, targetVersion)
        return next
      })
      if (detail.editorText === undefined) {
        setPendingTreeScroll({ index: detail.node.branchMessageIndex, refreshVersion: targetVersion })
      }
      void window.electronAPI.getSessionTree(sessionId).then(setSessionTree).catch(console.warn)
      void refreshRewindUndoState()
    }
    window.addEventListener(SESSION_TREE_SCROLL_EVENT, handleScroll)
    window.addEventListener(SESSION_TREE_NAVIGATED_EVENT, handleNavigated)
    return () => {
      window.removeEventListener(SESSION_TREE_SCROLL_EVENT, handleScroll)
      window.removeEventListener(SESSION_TREE_NAVIGATED_EVENT, handleNavigated)
    }
  }, [refreshRewindUndoState, scrollToTreeNode, sessionId, setInputContent, setInputHtmlContent, setLiveMessagesMap, setStreamingStates, store])

  React.useEffect(() => {
    if (!pendingTreeScroll || refreshVersion < pendingTreeScroll.refreshVersion || messagesRefreshing) return
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToTreeNode(pendingTreeScroll.index))
    })
    setPendingTreeScroll(null)
    return () => cancelAnimationFrame(frame)
  }, [messagesRefreshing, pendingTreeScroll, refreshVersion, scrollToTreeNode])

  const hasTextInput = inputContent.trim().length > 0
  const initialWorkspaceLoading = shouldDeferWorkspaceSend({
    hasSnapshot: sessionTargetState.snapshot !== null,
    loading: sessionTargetState.loading,
  })
  const canSend = !workspaceSendDeferred && !initialWorktreePreparing && !sessionTargetInteraction.requireChoiceBeforeSend && (messagesLoaded || initialWorkspaceLoading) && (streaming || !messagesRefreshing || initialWorkspaceLoading) && (hasTextInput || pendingFiles.length > 0 || !!suggestion) && agentChannelId !== null && hasAvailableModel && (!streaming || hasTextInput)
  const alternateQueueEnterKind = getAgentQueueSubmitKind(true)

  const inputToolbarItems = React.useMemo<ToolbarItem[]>(() => [
    {
      key: 'composer-plus',
      node: (
        <ComposerPlusMenu
          onInsertTrigger={(char) => richTextInputRef.current?.insertMentionTrigger(char)}
          disabled={!agentChannelId || !hasAvailableModel || workspaceSendDeferred}
        />
      ),
    },
    {
      key: 'model-presentation-preset',
      node: (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-8 min-w-10 rounded-md px-2 text-xs font-medium text-foreground/60 transition-transform hover:bg-muted/50 hover:text-foreground active:scale-[0.96]"
              disabled={streaming || backgroundWaiting}
              aria-label="模型呈现预设"
            >
              {minimalPresetEnabled ? '极简' : '标准'}
              <ChevronDown className="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            sideOffset={8}
            className="w-64 p-1.5"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-muted/50"
              onClick={() => { void setModelPresentationPreset('standard') }}
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-xs font-medium">标准</span>
                <span className="text-[11px] text-muted-foreground">完整提示词与全量工具</span>
              </span>
              {!minimalPresetEnabled && <Check className="size-3.5" />}
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-muted/50"
              onClick={() => { void setModelPresentationPreset('minimal') }}
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-xs font-medium">极简</span>
                <span className="text-[11px] text-muted-foreground">固定提示词 + 仅 Bash/Edit，评测对照；权限与门禁不变</span>
              </span>
              {minimalPresetEnabled && <Check className="size-3.5" />}
            </button>
          </PopoverContent>
        </Popover>
      ),
    },
    {
      key: 'execution-controls',
      node: <ExecutionControls sessionId={sessionId} forcedReadOnlyReason={forcedReadOnlyReason} />,
    },
    { key: 'speech', node: <SpeechButton className={inputToolbarButtonClass} /> },
    {
      key: 'attach-content',
      node: (
        <Tooltip open={resolveAttachmentMenuTooltipOpen(attachmentMenuOpen)}>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DropdownMenu open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={inputToolbarButtonClass}
                    aria-label="附加文件或文件夹"
                  >
                    <Paperclip className="size-[17px]" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" className="z-[9999] min-w-40">
                  <DropdownMenuItem onSelect={() => openDialogAfterDropdownMenu(() => { void handleAttachContent('file') })}>
                    <FileText />添加文件
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openDialogAfterDropdownMenu(() => { void handleAttachContent('directory') })}>
                    <FolderOpen />添加文件夹
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top"><p>附加文件或文件夹</p></TooltipContent>
        </Tooltip>
      ),
    },
    {
      key: 'session-status',
      node: <AgentStatusShortcut running={streaming || backgroundWaiting} onOpen={() => setSlashStatusOpen(true)} />,
    },
  ], [
    minimalPresetEnabled,
    setModelPresentationPreset,
    backgroundWaiting,
    sessionId,
    streaming,
    handleAttachContent,
    attachmentMenuOpen,
    forcedReadOnlyReason,
  ])

  const stopControl = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid="stop-button"
          type="button"
          variant="ghost"
          size="icon"
          className={inputToolbarDangerButtonClass}
          onClick={handleStop}
        >
          <Square className="size-[16px]" fill="currentColor" strokeWidth={0} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>停止 Agent ({getAcceleratorDisplay(getActiveAccelerator('stop-generation'))})</p>
      </TooltipContent>
    </Tooltip>
  )

  const primarySendButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        canSend ? inputToolbarSendButtonClass : inputToolbarDisabledButtonClass
      )}
      onClick={() => handleSend()}
      disabled={!canSend}
    >
      <CornerDownLeft className="size-[22px]" />
    </Button>
  )

  const sendButton = (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(inputToolbarButtonClass, !hasTextInput && 'text-foreground/35')}
            onClick={handleQueueAside}
            aria-label="排为附言"
          >
            <MessageSquarePlus className="size-[17px]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>排为附言：随下一条正常消息发送（Cmd/Ctrl+Shift+Enter）</p>
        </TooltipContent>
      </Tooltip>
      {primarySendButton}
    </div>
  )

  const sendControl = streaming ? (
    <>
      {hasTextInput && sendButton}
      {stopControl}
    </>
  ) : sendButton

  const inputTrailingNode = (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <ContextUsageBadge
          inputTokens={contextStatus.inputTokens}
          outputTokens={contextStatus.outputTokens}
          cacheReadTokens={contextStatus.cacheReadTokens}
          cacheCreationTokens={contextStatus.cacheCreationTokens}
          costUsd={contextStatus.costUsd}
          sessionCacheMetrics={sessionCacheMetrics}
          contextBreakdown={contextStatus.contextBreakdown}
          contextWindow={contextStatus.contextWindow}
          contextWindowSource={contextStatus.contextWindowSource}
          contextWindowOwner={contextStatus.contextWindowOwner}
          isEstimated={contextStatus.contextUsageIsEstimated === true}
          contextUsageInvalidated={contextStatus.contextUsageInvalidated}
          isPiRuntime
          isCompacting={contextStatus.isCompacting}
          isProcessing={streaming}
          sessionId={sessionId}
          channelId={planQuotaChannelId}
          channelUpdatedAt={planQuotaChannelUpdatedAt}
          onCompact={handleCompact}
        />
        <ModelSelector
          filterChannelIds={undefined}
          externalSelectedModel={externalSelectedModel}
          onModelSelect={handleModelSelect}
          useSharedOpenState
          hideTrigger
          restoreFocusOnClose={restoreComposerFocus}
        />
        <AgentThinkingPopover
          agentThinking={agentThinking}
          modelName={composerModelName}
          modelLogo={composerModelLogo}
          channelName={composerChannelName}
          onOpenModelSelector={() => store.set(modelSelectorOpenAtom, true)}
          onToggle={() => {
            const next = agentThinking?.type === 'adaptive'
              ? { type: 'disabled' as const }
              : { type: 'adaptive' as const }
            setAgentThinking(next)
            window.electronAPI.updateSettings({ agentThinking: next })
          }}
          codexConfig={isSessionThinkingAvailable ? {
            thinkingLevel: openAIThinkingLevel,
            levels: openAIThinkingLevels,
            onThinkingLevelChange: updateReasoningLevel,
            fastMode: isCodexFastModeAvailable ? {
              enabled: codexFastModeEnabled,
              onChange: handleCodexFastModeChange,
            } : undefined,
          } : undefined}
        />
      </div>
      {sendControl}
    </>
  )

  // 同批图片附件 — 用于大图预览时左右翻页（提取到 useMemo 避免每次渲染重建）
  const pendingImageFiles = React.useMemo(
    () => pendingFiles.filter((f) => f.mediaType.startsWith('image/') && !!f.previewUrl),
    [pendingFiles]
  )
  const imageSiblingsForPending = React.useMemo(
    () => pendingImageFiles.map((f) => ({
      previewUrl: f.previewUrl as string,
      filename: f.filename,
      onEditComplete: (editedDataUrl: string) => handleAttachmentEditComplete(f.id, editedDataUrl),
    })),
    [pendingImageFiles, handleAttachmentEditComplete]
  )

  return (
    <>
    <AgentSessionProvider sessionId={sessionId}>
      <div data-agent-session-id={sessionId} className="flex h-full min-h-0 flex-1 min-w-0 max-w-[min(72rem,100%)] flex-col overflow-hidden mx-auto">
        {/* Agent Header */}
        <AgentHeader
          sessionId={sessionId}
          branchCount={sessionTree?.branchCount ?? 0}
          onToggleSessionTree={toggleSessionTree}
          sessionTreeOpen={sessionTreeOpen}
        />

        {/* 空会话欢迎区独立占满 Header 与 Composer 之间的空间，确保视觉中心稳定。 */}
        {isSessionEmpty ? (
          <WorkWelcomeEmptyState onPickPrompt={handleWelcomePromptPick} />
        ) : (
          <AgentMessages
            sessionId={sessionId}
            sessionModelId={agentModelId || undefined}
            messagesLoaded={messagesLoaded}
            persistedSDKMessages={persistedSDKMessages}
            streaming={streaming}
            showRunningIndicator={!runtimeRailOwnsRunningIndicator}
            streamState={streamState}
            liveMessages={liveMessages}
            sessionPath={sessionPath}
            attachedDirs={allAttachedDirs}
            bottomFollowRevision={bottomFollowRevision}
            stoppedByUser={stoppedByUser}
            onRetry={handleRetry}
            onRetryNow={streamState?.retrying?.phase === 'scheduled' ? handleRetryNow : undefined}
            retryNowPending={retryNowPending}
            onRetryInNewSession={handleRetryInNewSession}
            onRelinkProjectRoot={handleRelinkProjectRoot}
            onRestoreProjectRoot={() => setRestoreProjectRootDialogOpen(true)}
            onFork={handleFork}
            onForkToWorktree={sessionTargetState.snapshot?.checkout.kind === 'local'
              ? handleForkToWorktree
              : undefined}
            onRewind={handleRewindRequest}
            onCreateTodo={handleOpenReplyTodoDialog}
            onCompact={handleCompact}
          />
        )}

        {/* 权限请求横幅 */}
        <PermissionBanner sessionId={sessionId} />

        {/* AskUserQuestion 交互式问答横幅 */}
        <AskUserBanner sessionId={sessionId} />


        {/* ExitPlanMode 计划审批横幅 */}
        <ExitPlanModeBanner sessionId={sessionId} />

        {/* 输入区域 — 交互横幅显示时隐藏，由横幅替代；所有会话保持相同宽度。 */}
        {!hasBannerOverlay && (
        <div className="px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]">
          {((!sessionTargetState.snapshot && sessionTargetState.loading) || workspaceSendDeferred) && (
            <div
              className="flex items-center justify-center gap-2 pb-2 text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <AgentActivityOrb state="listening" size={20} aria-hidden="true" />
              <span>{workspaceSendDeferred ? '消息已排队，工作区就绪后自动发送…' : '正在准备工作区…'}</span>
            </div>
          )}
          <div
            data-input-mode="agent"
            data-agent-composer-stack="true"
            className="space-y-1"
          >
            <AgentSessionTargetChooser
              sessionId={sessionId}
              projectName={currentWorkspace?.name ?? '当前项目'}
              projectRootPath={currentWorkspace?.projectRootPath ?? workspaceFilesPath ?? undefined}
              persistedTarget={sessionMeta?.sessionTarget}
            />
            {/* modern 模式只显示一个最高优先级 Action Rail：
                AI 异常/重试 → AI Runtime → urgent Worktree → active Worktree → 本轮完成摘要 → 渠道配置 → settled Worktree。
                classic 与 terminal/CRT 继续沿用原有 Composer 内布局。 */}
            {composerActionRailKind === 'agent_issue' && (
              <ComposerActionRail
                dataKind="agent_issue"
                icon={<AlertTriangle className="size-3.5 text-amber-500" />}
                className="border-amber-500/25 bg-amber-500/[0.06]"
                actions={(
                  <>
                    {streamState?.retrying?.phase === 'scheduled' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[11px] text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                        disabled={retryNowPending}
                        onClick={() => { void handleRetryNow() }}
                      >
                        <RotateCw className={cn('mr-1 size-3', retryNowPending && 'animate-spin')} />
                        {retryNowPending ? '正在重试…' : '立即重试'}
                      </Button>
                    )}
                    {agentError && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[11px]"
                        onClick={() => { void handleCopyError() }}
                      >
                        {errorCopied ? <Check className="mr-1 size-3" /> : <Copy className="mr-1 size-3" />}
                        {errorCopied ? '已复制' : '复制错误'}
                      </Button>
                    )}
                  </>
                )}
              >
                {resolveAgentIssueLabel(streamState?.retrying, agentError)}
              </ComposerActionRail>
            )}
            {useModernComposerRail && streaming && (
              <AgentRuntimeActionRail
                visible={composerActionRailKind === 'agent_runtime'}
                streamState={streamState}
                liveMessages={liveMessages}
                providerUsage={runtimeProviderUsage}
                onTelemetry={runtimeRailState.captureTelemetry}
              />
            )}
            {composerActionRailKind === 'worktree_active' && (
              <WorktreeReviewStatus sessionId={sessionId} railKind="worktree_active" />
            )}
            {composerActionRailKind === 'agent_summary' && runtimeSummary && (
              <ComposerActionRail
                dataKind="agent_summary"
                dataTestId="agent-runtime-summary-rail"
                icon={<CheckCircle2 className="size-3.5 text-emerald-500" />}
                contentClassName="max-w-[36%] flex-none"
                actions={(
                  <>
                    {runtimeSummary.inputTokens !== null && (
                      <span
                        data-testid="agent-runtime-summary-input-tokens"
                        className="composer-runtime-tokens hidden shrink-0 tabular-nums text-sky-700/80 min-[680px]:inline dark:text-sky-300/75"
                      >
                        输入 {formatAgentUsageTokens(runtimeSummary.inputTokens)}
                      </span>
                    )}
                    {runtimeSummary.outputTokens !== null && (
                      <span
                        data-testid="agent-runtime-summary-output-tokens"
                        className="composer-runtime-tokens hidden shrink-0 tabular-nums text-emerald-700/80 min-[600px]:inline dark:text-emerald-300/75"
                      >
                        输出 {runtimeSummary.outputTokensEstimated ? '~' : ''}{formatAgentUsageTokens(runtimeSummary.outputTokens)}
                      </span>
                    )}
                    <span
                      data-testid="agent-runtime-summary-duration"
                      className="shrink-0 tabular-nums text-muted-foreground/80"
                    >
                      {formatAgentRuntimeDuration(runtimeSummary.elapsedSeconds)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0"
                      aria-label="关闭本轮摘要"
                      onClick={runtimeRailState.dismissSummary}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                )}
              >
                <span className="font-medium text-foreground/80">Run completed</span>
                <span className="composer-runtime-detail hidden min-[520px]:inline"> · Run summary</span>
              </ComposerActionRail>
            )}
            {composerActionRailKind === 'channel_setup' && (
              <ComposerActionRail
                dataKind="channel_setup"
                icon={<Settings className="size-3.5 text-amber-500" />}
                actions={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => setSettingsOpen(true)}
                  >
                    前往设置
                  </Button>
                )}
              >
                {!agentChannelId ? '请在设置中选择 Agent 供应商' : '暂无可用模型，请在设置中启用 Agent 渠道并配置模型'}
              </ComposerActionRail>
            )}
            {composerActionRailKind === 'worktree_settled' && (
              <WorktreeReviewStatus sessionId={sessionId} railKind="worktree_settled" />
            )}
            <div
            data-agent-composer-surface="true"
            className={cn(
              'agent-composer-surface rounded-[10px] border-[0.5px] border-border bg-background/70 backdrop-blur-sm transition-all duration-200',
              workspaceSendDeferred && 'pointer-events-none opacity-80',
              (isPlanMode || isPermissionPlanMode) && !isDragOver && 'plan-mode-border',
              isDragOver && 'border-[2px] border-dashed border-[#2ecc71] bg-[#2ecc71]/[0.03]'
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {(isPlanMode || isPermissionPlanMode) && !isDragOver && <PlanModeDashedBorder />}
            <RewindUndoBanner
              state={rewindUndoState}
              inProgress={rewindUndoInProgress}
              onUndo={() => { void handleUndoRewind() }}
            />
            {!useModernComposerRail && <WorktreeReviewStatus sessionId={sessionId} legacySurface />}
            {/* classic 与 terminal/CRT 保留原有渠道配置提示。 */}
            {!useModernComposerRail && (!agentChannelId || !hasAvailableModel) && (
              <div className="flex items-center gap-2 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
                <Settings size={14} />
                <span>{!agentChannelId ? '请在设置中选择 Agent 供应商' : '暂无可用模型，请在设置中启用 Agent 渠道并配置模型'}</span>
                <button
                  type="button"
                  className="text-xs underline underline-offset-2 hover:text-foreground transition-colors"
                  onClick={() => setSettingsOpen(true)}
                >
                  前往设置
                </button>
              </div>
            )}

            {/* 附件 + 引用选中文本 Chip（同排并排） */}
            {(pendingFiles.length > 0 || currentQuotedSelection) && (
              <div className="flex flex-wrap gap-2 px-3 pt-2.5 pb-1.5">
                {pendingFiles.map((file) => (
                    <AttachmentPreviewItem
                      key={file.id}
                      filename={file.filename}
                      mediaType={file.mediaType}
                      previewUrl={file.previewUrl}
                      onRemove={() => handleRemoveFile(file.id)}
                      onClick={file.filename.startsWith('clipboard-') ? () => handleClipboardPreview(file) : undefined}
                      onEditComplete={(editedDataUrl) => handleAttachmentEditComplete(file.id, editedDataUrl)}
                      imageSiblings={imageSiblingsForPending}
                      siblingIndex={pendingImageFiles.findIndex((f) => f.id === file.id)}
                    />
                  ))}
                {currentQuotedSelection && (
                  <QuotedSelectionChip
                    text={currentQuotedSelection.text}
                    filePath={currentQuotedSelection.filePath}
                    sourceLabel={currentQuotedSelection.sourceLabel}
                    sourceType={currentQuotedSelection.sourceType}
                    onRemove={handleRemoveQuotedSelection}
                  />
                )}
              </div>
            )}

            <AgentMessageQueue
              items={visibleQueuedMessages}
              canAdjustDirection={canAdjustQueuedDirection}
              onAdjustDirection={handleAdjustQueuedDirection}
              onRecall={handleRecallQueuedMessage}
              onRemove={handleRemoveQueuedMessage}
              onMove={handleMoveQueuedMessage}
            />

            {/* Agent 建议提示 */}
            {suggestion && !streaming && (
              <div className="px-3 pt-2.5 pb-1.5">
                <button
                  type="button"
                  className="group flex items-start gap-2 w-full rounded-lg border border-dashed border-primary/30 bg-primary/[0.03] px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/50 hover:bg-primary/[0.06]"
                  onClick={() => handleSend(suggestion)}
                >
                  <Sparkles className="size-4 shrink-0 mt-0.5 text-primary/60 group-hover:text-primary/80" />
                  <span className="flex-1 min-w-0 text-foreground/80 group-hover:text-foreground line-clamp-3">{suggestion}</span>
                  <X
                    className="size-3.5 shrink-0 mt-0.5 text-muted-foreground/40 hover:text-foreground transition-colors"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPromptSuggestions((prev) => {
                        if (!prev.has(sessionId)) return prev
                        const map = new Map(prev)
                        map.delete(sessionId)
                        return map
                      })
                    }}
                  />
                </button>
              </div>
            )}

            <RichTextInput
              ref={richTextInputRef}
              value={inputContent}
              onChange={setInputContent}
              onSubmit={handleSend}
              onAltSubmit={() => { void handleSend(undefined, alternateQueueEnterKind) }}
              onAsideSubmit={handleQueueAside}
              onPasteFiles={handlePasteFiles}
              onPasteLongText={handlePasteLongText}
              longTextPasteThreshold={longTextPasteAsAttachmentEnabled ? LONG_TEXT_ATTACHMENT_THRESHOLD : undefined}
              placeholder={
                agentChannelId && hasAvailableModel
                  ? '输入消息...'
                  : !agentChannelId
                    ? '请先在设置中选择 Agent 供应商'
                    : '暂无可用模型，请先在设置中启用渠道'
              }
              disabled={!agentChannelId || !hasAvailableModel || workspaceSendDeferred}
              autoFocusTrigger={sessionId}
              collapsible
              enableMentions
              workspacePath={sessionPath}
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              usesSessionTarget
              sessionTargetBound={hasBoundSessionTarget}
              sessionTargetPreviewRoot={hasBoundSessionTarget ? null : workspaceFilesPath}
              attachedDirs={workspaceMentionPaths}
              sessionAttachedDirs={sessionMentionPaths}
              htmlValue={inputHtmlContent}
              onHtmlChange={setInputHtmlContent}
              sendWithCmdEnter={sendWithCmdEnter}
              onSlashCommand={handleSlashCommand}
            />


            {/* Footer 工具栏 — 容器变窄时尾部按钮自动折叠进「更多」Popover */}
            <InputToolbarOverflow items={inputToolbarItems} trailing={inputTrailingNode} />
          </div>
          </div>
        </div>
        )}
      </div>
    </AgentSessionProvider>

    {(<SessionTreeDialog
        sessionId={sessionId}
        open={sessionTreeOpen}
        onOpenChange={updateSessionTreeOpen}
      />)}

    <SlashStatusCard
      sessionId={sessionId}
      open={slashStatusOpen}
      onOpenChange={setSlashStatusOpen}
      workspaceSlug={workspaceSlug}
      sessionUsage={sessionUsage}
      restoreFocusOnClose={restoreComposerFocus}
    />

    <SlashPickerMenu
      title="切换工作方式"
      open={slashWorkflowOpen}
      onOpenChange={setSlashWorkflowOpen}
      activeValue={executionControls.workflow}
      options={WORKFLOW_PICKER_OPTIONS}
      onSelect={(value) => setSessionWorkflow(value as AgentWorkflow)}
      restoreFocusOnClose={restoreComposerFocus}
    />

    <SlashPickerMenu
      title="调整推理深度"
      open={slashReasoningOpen}
      onOpenChange={setSlashReasoningOpen}
      activeValue={openAIThinkingLevel}
      options={isSessionThinkingAvailable
        ? openAIThinkingLevels.map((level) => ({
            value: level,
            label: OPENAI_THINKING_LABELS_EN[level] ?? level,
          }))
        : []}
      onSelect={(value) => { void updateReasoningLevel(value as AgentThinkingLevel) }}
      restoreFocusOnClose={restoreComposerFocus}
    />

    <SlashPickerMenu
      title="Fork 当前会话"
      open={slashForkOpen}
      onOpenChange={setSlashForkOpen}
      options={FORK_PICKER_OPTIONS}
      onSelect={handleSlashFork}
      restoreFocusOnClose={restoreComposerFocus}
    />

    <Dialog open={todoDialogOpen} onOpenChange={setTodoDialogOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>标记为 Todo</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <label className="grid gap-2 text-sm font-medium">任务标题
            <textarea value={todoDraftTitle} onChange={(event) => setTodoDraftTitle(event.target.value)} rows={3} className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />
          </label>
          <label className="grid gap-2 text-sm font-medium">Todo 分组
            <Select value={todoGroupId} onValueChange={setTodoGroupId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none__">不分组</SelectItem>{planningGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select>
          </label>
        </div>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setTodoDialogOpen(false)}>取消</Button><Button type="button" onClick={() => void handleCreateReplyTodo()} disabled={creatingTodo || !todoDraftTitle.trim()}><ListTodo size={15} />添加 Todo</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog
      open={forkToWorktreeTargetUuid !== null}
      onOpenChange={(open) => { if (!open && !forkingSession) setForkToWorktreeTargetUuid(null) }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fork 到新 Worktree？</AlertDialogTitle>
          <AlertDialogDescription>
            Domi 会从当前提交的 HEAD 创建 managed Worktree，并把截至此消息的对话复制到新子会话。当前 Local 会话及其 Session Target 保持不变；Local 中的未提交修改不会复制到新 Worktree。
            {sessionTargetState.snapshot?.dirty ? ' 当前检测到 Local 存在未提交修改，请确认它们继续留在原工作区。' : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={forkingSession}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={forkingSession}
            onClick={(event) => {
              event.preventDefault()
              void handleForkToWorktreeConfirm()
            }}
          >
            {forkingSession ? '创建中…' : 'Fork 到 Worktree'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* 回退确认弹窗 */}
    <AlertDialog
      open={rewindTargetUuid !== null}
      onOpenChange={(open) => {
        if (open || rewindInProgress) return
        rewindPreviewRequestRef.current += 1
        setRewindTargetUuid(null)
        setRewindPreview(null)
        setRewindPreviewLoading(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认回退</AlertDialogTitle>
          <AlertDialogDescription>
            回退将截断该消息之后的所有对话。回退完成后可撤销一次；发送下一条消息、再次回退或切换会话分支后将失效。Domi 初版只恢复当前 Session Target 内由 Write/Edit 修改的文件，Bash 和附加目录不在保证范围内。
          </AlertDialogDescription>
          <div className="space-y-2 text-sm text-muted-foreground">
            {rewindPreviewLoading ? <p>正在检查文件影响…</p> : null}
            {!rewindPreviewLoading && rewindPreview ? (
              <>
                <p>
                  {rewindPreview.fileRewind.available
                    ? `将恢复 ${rewindPreview.fileRewind.changes.filter((item) => item.action === 'restore').length} 个文件，删除 ${rewindPreview.fileRewind.changes.filter((item) => item.action === 'delete').length} 个后来新建的文件。`
                    : `文件恢复不可用：${rewindPreview.fileRewind.error ?? '检查点覆盖不完整'}；确认后只回退对话。`}
                </p>
                {rewindPreview.fileRewind.changes.length > 0 ? (
                  <ul className="max-h-32 list-disc space-y-1 overflow-auto pl-5 font-mono text-xs">
                    {rewindPreview.fileRewind.changes.slice(0, 12).map((item) => (
                      <li key={`${item.action}:${item.path}`}>{item.action === 'delete' ? '删除' : '恢复'} {item.path}</li>
                    ))}
                    {rewindPreview.fileRewind.changes.length > 12 ? <li>另有 {rewindPreview.fileRewind.changes.length - 12} 个文件…</li> : null}
                  </ul>
                ) : null}
                {rewindPreview.fileRewind.conflicts.length > 0 ? (
                  <p className="text-destructive">检测到人工后续修改：{rewindPreview.fileRewind.conflicts.join('、')}。请先处理冲突。</p>
                ) : null}
              </>
            ) : null}
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={rewindInProgress}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRewindConfirm}
            disabled={rewindInProgress || rewindPreviewLoading || !rewindPreview || rewindPreview.fileRewind.conflicts.length > 0}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {rewindInProgress ? '回退中…' : rewindPreview?.fileRewind.available === false ? '仅回退对话' : '回退'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={restoreProjectRootDialogOpen} onOpenChange={setRestoreProjectRootDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>在原路径新建空文件夹？</AlertDialogTitle>
          <AlertDialogDescription>
            将在该本地项目原路径创建空文件夹。此操作不会恢复被删除的文件。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={restoringProjectRoot}>取消</AlertDialogCancel>
          <AlertDialogAction disabled={restoringProjectRoot} onClick={() => void handleRestoreProjectRoot()}>
            {restoringProjectRoot ? '创建中...' : '新建空文件夹'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
