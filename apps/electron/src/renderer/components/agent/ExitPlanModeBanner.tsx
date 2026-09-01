/**
 * ExitPlanModeBanner — Agent ExitPlanMode 计划审批横幅
 *
 * 仿照 Claude Code 的计划审批 UI，提供 3 个选项：
 * 1. 批准计划并开始执行
 * 2. 要求修改 — 自由输入修改意见
 * 3. 拒绝计划并停止 — deny
 *
 * 键盘：审批卡片获得焦点后，↑↓ 选择，Enter 确认，数字键快速选择。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  Check,
  ChevronDown,
  ChevronRight,
  X,
  MessageSquare,
  Send,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { allPendingExitPlanRequestsAtom, agentStreamingStatesAtom, finalizeStreamingActivities } from '@/atoms/agent-atoms'
import type { ExitPlanModeAction, ExitPlanAllowedPrompt, UserInputImageAttachment } from '@domi/shared'
import {
  AttachmentChipRow,
  createAttachmentsFromFiles,
  extractImageFiles,
  type InputImageAttachment,
} from './banner-attachments.tsx'

/** 选项定义 */
interface PlanOption {
  action: ExitPlanModeAction
  label: string
  description: string
  icon: React.ReactNode
  variant: 'default' | 'secondary' | 'destructive'
}

const PLAN_OPTIONS: PlanOption[] = [
  {
    action: 'approve_current',
    label: '仅执行本次',
    description: '执行当前计划；研究来源的任务结束后自动回到研究',
    icon: <Check className="size-3.5" />,
    variant: 'default',
  },
  {
    action: 'approve_and_switch',
    label: '切换到执行',
    description: '执行当前计划，并让后续消息继续保持执行模式',
    icon: <Send className="size-3.5" />,
    variant: 'secondary',
  },
  {
    action: 'feedback',
    label: '要求修改',
    description: '告诉 Agent 需要调整什么',
    icon: <MessageSquare className="size-3.5" />,
    variant: 'secondary',
  },
  {
    action: 'deny',
    label: '拒绝计划并停止',
    description: '停止当前执行并保持计划模式',
    icon: <X className="size-3.5" />,
    variant: 'destructive',
  },
]

interface ExitPlanModeBannerProps {
  sessionId: string
}

export function ExitPlanModeBanner({ sessionId }: ExitPlanModeBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingExitPlanRequestsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [focusedIdx, setFocusedIdx] = React.useState(0)
  const [showFeedback, setShowFeedback] = React.useState(false)
  const [feedbackText, setFeedbackText] = React.useState('')
  const [feedbackImages, setFeedbackImages] = React.useState<InputImageAttachment[]>([])
  const [promptsExpanded, setPromptsExpanded] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const bannerRef = React.useRef<HTMLDivElement>(null)
  const feedbackInputRef = React.useRef<HTMLTextAreaElement | null>(null)

  const request = requests[0] ?? null

  // ===== Refs：确保 keydown handler 始终读取最新值，消除闭包过期问题 =====
  const focusedIdxRef = React.useRef(focusedIdx)
  focusedIdxRef.current = focusedIdx
  const feedbackTextRef = React.useRef(feedbackText)
  feedbackTextRef.current = feedbackText
  const feedbackImagesRef = React.useRef(feedbackImages)
  feedbackImagesRef.current = feedbackImages
  const handleActionRef = React.useRef<((action: ExitPlanModeAction) => void) | null>(null)

  // 重置状态
  React.useEffect(() => {
    setFocusedIdx(0)
    setShowFeedback(false)
    setFeedbackText('')
    setFeedbackImages([])
    setPromptsExpanded(false)
  }, [request?.requestId])

  // 新请求到达时自动聚焦横幅，键盘快捷键即可用（与 AskUser 横幅一致）
  React.useEffect(() => {
    if (request) bannerRef.current?.focus({ preventScroll: true })
  }, [request?.requestId])

  // 反馈框随内容自动增高（上限后内部滚动）
  React.useEffect(() => {
    const el = feedbackInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [feedbackText, showFeedback])

  const handleAction = async (action: ExitPlanModeAction): Promise<void> => {
    if (submitting || !request) return
    setSubmitting(true)
    try {
      const attachments: UserInputImageAttachment[] = action === 'feedback'
        ? feedbackImages.map((img) => ({
            filename: img.filename,
            mimeType: img.mimeType,
            dataBase64: img.dataBase64,
          }))
        : []
      await window.electronAPI.respondExitPlanMode({
        requestId: request.requestId,
        action,
        feedback: action === 'feedback' ? feedbackText.trim() : undefined,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      // 从队列移除
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
    } catch (error) {
      console.error('[ExitPlanModeBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  handleActionRef.current = handleAction

  /** 关闭计划审批 & 终止 Agent */
  const handleDismiss = (): void => {
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
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    window.electronAPI.stopAgent(sessionId, 'renderer-plan-dismiss').catch(console.error)
  }

  // 键盘导航：只在 requestId 变化时重建 handler，内部通过 ref 读取最新值
  React.useEffect(() => {
    if (!request) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const curFocusIdx = focusedIdxRef.current

      // 反馈输入框内：仅 Enter 提交（输入法组合中跳过）；只附图不写字也允许提交
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (feedbackTextRef.current.trim() || feedbackImagesRef.current.length > 0) {
            handleActionRef.current?.('feedback')
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowFeedback(false)
          setFocusedIdx(1)
        }
        return
      }

      // 焦点在按钮上时：Enter 交给原生 click 激活，避免与横幅快捷键双触发；
      // 方向键等其他按键仍继续走横幅导航（否则点完 Tab/选项后无法再用 ↑↓ 选择）
      if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const count = PLAN_OPTIONS.length
        const next = e.key === 'ArrowDown'
          ? (curFocusIdx + 1) % count
          : (curFocusIdx - 1 + count) % count
        setFocusedIdx(next)
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        const option = PLAN_OPTIONS[curFocusIdx]
        if (option) {
          if (option.action === 'feedback') {
            setShowFeedback(true)
          } else {
            handleActionRef.current?.(option.action)
          }
        }
      } else if (e.key >= '1' && e.key <= '4') {
        const idx = parseInt(e.key) - 1
        const option = PLAN_OPTIONS[idx]
        if (option) {
          setFocusedIdx(idx)
          if (option.action === 'feedback') {
            setShowFeedback(true)
          } else {
            handleActionRef.current?.(option.action)
          }
        }
      }
    }

    const banner = bannerRef.current
    if (!banner) return

    // 只在审批横幅自身获得焦点（或其子控件获得焦点）时响应快捷键，
    // 避免用户在编辑器、消息区按 Enter/数字键时误触批准。
    banner.addEventListener('keydown', handleKeyDown)
    return () => banner.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  if (!request) return null

  return (
    <div
      ref={bannerRef}
      tabIndex={0}
      aria-label="Agent 计划审批"
      className="exit-plan-banner mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary/40 animate-in slide-in-from-bottom-2 duration-200"
    >
      {/* 头部 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 mb-1">
          <FileText className="size-4 text-primary" />
          <span className="text-sm font-medium text-foreground flex-1">Agent 计划待审批</span>
          <button
            type="button"
            className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
            onClick={handleDismiss}
            title="关闭并终止 Agent"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          默认只为当前任务开放执行；也可以明确切换为持续执行模式
        </div>
      </div>

      {/* allowedPrompts 展示 — 默认折叠，点击展开 */}
      {request.allowedPrompts.length > 0 && (
        <AllowedPromptsList
          prompts={request.allowedPrompts}
          expanded={promptsExpanded}
          onToggle={() => setPromptsExpanded((v) => !v)}
        />
      )}

      {/* 选项列表 */}
      <div className="px-4 pb-2">
        <div className="flex flex-col gap-1">
          {PLAN_OPTIONS.map((option, idx) => {
            const isFocused = focusedIdx === idx
            return (
              <React.Fragment key={option.action}>
                <button
                  type="button"
                  className={`
                  flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-all outline-none text-left
                  ${option.variant === 'destructive'
                    ? 'bg-muted/50 text-foreground/80 hover:bg-destructive/10 hover:text-destructive'
                    : 'bg-muted/50 text-foreground/80 hover:bg-muted'
                  }
                  ${isFocused ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
                `}
                  onClick={() => {
                    setFocusedIdx(idx)
                    if (option.action === 'feedback') {
                      setShowFeedback(true)
                    } else {
                      void handleAction(option.action)
                    }
                  }}
                  disabled={submitting}
                >
                  <span className="text-[10px] shrink-0 text-muted-foreground/50">
                    {idx + 1}
                  </span>
                  <span className="shrink-0 text-muted-foreground/70">{option.icon}</span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </button>

                {/* 修改意见输入框：内联在「要求修改」选项正下方，而不是掉到卡片底部 */}
                {option.action === 'feedback' && showFeedback && (
                  <div className="py-1">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-start gap-2">
                        <textarea
                          ref={feedbackInputRef}
                          rows={1}
                          className="flex-1 min-w-0 resize-none px-3 py-2 rounded-lg text-xs leading-relaxed bg-muted/40 focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 transition-colors overflow-hidden"
                          placeholder="输入修改意见（Shift+Enter 换行），可直接粘贴截图..."
                          value={feedbackText}
                          onChange={(e) => setFeedbackText(e.target.value)}
                          onPaste={(e) => {
                            const imageFiles = extractImageFiles(e.clipboardData)
                            if (imageFiles.length === 0) return
                            e.preventDefault()
                            void createAttachmentsFromFiles(imageFiles)
                              .then((items) => setFeedbackImages((prev) => [...prev, ...items]))
                              .catch((error) => console.error('[ExitPlanModeBanner] 粘贴图片失败:', error))
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault()
                              e.stopPropagation()
                              if (feedbackText.trim() || feedbackImages.length > 0) {
                                void handleAction('feedback')
                              }
                            }
                          }}
                          autoFocus
                          disabled={submitting}
                        />
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => void handleAction('feedback')}
                          disabled={submitting || (!feedbackText.trim() && feedbackImages.length === 0)}
                          className="h-8 px-3 text-xs shrink-0"
                        >
                          <Send className="size-3 mr-1" />
                          发送
                        </Button>
                      </div>
                      <AttachmentChipRow
                        attachments={feedbackImages}
                        onRemove={(id) => {
                          setFeedbackImages((prev) => {
                            const target = prev.find((img) => img.id === id)
                            if (target) URL.revokeObjectURL(target.previewUrl)
                            return prev.filter((img) => img.id !== id)
                          })
                        }}
                      />
                    </div>
                  </div>
                )}
              </React.Fragment>
            )
          })}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="flex items-center px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40">
          点击选择 · 先聚焦审批卡片后可用 ↑↓ Enter / 1-3 快捷操作
        </span>
      </div>
    </div>
  )
}

/** allowedPrompts 展示列表 — 默认折叠，展开后展示全部权限徽章 */
function AllowedPromptsList({
  prompts,
  expanded,
  onToggle,
}: {
  prompts: ExitPlanAllowedPrompt[]
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  return (
    <div className="px-4 pb-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors outline-none"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        计划需要的权限 · {prompts.length} 项
      </button>
      {expanded && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {prompts.map((p, idx) => (
            <span
              key={idx}
              title={p.prompt}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] leading-4 bg-primary/10 text-primary"
            >
              {p.prompt}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
