/**
 * AskUserBanner — Agent AskUserQuestion 交互式问答横幅
 *
 * 多问题用顶部 Tab 切换，选项竖向排列。
 * 键盘：单选 ↑↓ 即选；多选 ↑↓ 移动高亮、空格切换选中；Enter 确认当前问题（最后一题提交，否则翻页）。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Send, X } from 'lucide-react'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { cn } from '@/lib/utils'
import {
  AttachmentChipRow,
  createAttachmentsFromFiles,
  extractImageFiles,
  type InputImageAttachment,
} from './banner-attachments.tsx'
import {
  VOICE_DICTATION_CLEAR_PREVIEW_EVENT,
  VOICE_DICTATION_INSERT_EVENT,
  VOICE_DICTATION_PREVIEW_EVENT,
  getLastFocusedVoiceInputId,
  setLastFocusedVoiceInputId,
} from '@/lib/voice-input-focus'
import {
  allPendingAskUserRequestsAtom,
  agentStreamingStatesAtom,
  askUserDraftsAtom,
  finalizeStreamingActivities,
  type AskUserQuestionDraft,
  type AskUserRequestDraft,
} from '@/atoms/agent-atoms'
import { DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY } from '@domi/shared'
import type { AskUserQuestion, UserInputImageAttachment } from '@domi/shared'

const EMPTY_ANSWER: AskUserQuestionDraft = { selected: [], customText: '', showCustom: false, attachments: [] }

export function hasValidAskUserAnswers(
  questions: readonly AskUserQuestion[],
  answers: ReadonlyMap<number, AskUserQuestionDraft>,
): boolean {
  return questions.some((_, index) => {
    const answer = answers.get(index) ?? EMPTY_ANSWER
    return answer.selected.length > 0
      || (answer.showCustom && answer.customText.trim().length > 0)
      || (answer.attachments?.length ?? 0) > 0
  })
}

export function buildAskUserAnswersRecord(
  questions: readonly AskUserQuestion[],
  answers: ReadonlyMap<number, AskUserQuestionDraft>,
  isDirectWorkflowApproval: boolean,
): Record<string, string> {
  const record: Record<string, string> = {}
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]
    if (!question) continue
    const answer = answers.get(index) ?? EMPTY_ANSWER
    const questionKey = question.question || String(index)
    if (answer.showCustom && answer.customText.trim()) {
      const answerKey = isDirectWorkflowApproval ? DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY : questionKey
      record[answerKey] = answer.customText.trim()
    } else if (answer.selected.length > 0) {
      record[questionKey] = answer.selected.join(', ')
    }
  }
  return record
}

/** 收集各题粘贴的图片附件，映射到对应的答案 key（与 buildAskUserAnswersRecord 的 key 约定一致） */
function collectAskUserAttachments(
  questions: readonly AskUserQuestion[],
  answers: ReadonlyMap<number, AskUserQuestionDraft>,
  isDirectWorkflowApproval: boolean,
): UserInputImageAttachment[] {
  const result: UserInputImageAttachment[] = []
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]
    if (!question) continue
    const imgs = answers.get(index)?.attachments ?? []
    if (imgs.length === 0) continue
    const questionKey = question.question || String(index)
    const key = isDirectWorkflowApproval ? DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY : questionKey
    for (const img of imgs) {
      result.push({ filename: img.filename, mimeType: img.mimeType, dataBase64: img.dataBase64, questionKey: key })
    }
  }
  return result
}

const ASK_USER_REMARK_PLUGINS = [remarkGfm]

function safeUrlTransform(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return defaultUrlTransform(url)
}

const ASK_USER_MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (href?.startsWith('http://') || href?.startsWith('https://')) {
          window.electronAPI.openExternal(href)
        }
      }}
    >
      {children}
    </a>
  ),
}

/** AskUser 文本使用受限 Markdown 渲染；react-markdown 默认不会执行原始 HTML。 */
function AskUserMarkdown({ children, className }: { children: string; className?: string }): React.ReactElement {
  return (
    <div className={cn(
      'prose prose-sm dark:prose-invert max-w-none text-foreground',
      'prose-p:my-1 prose-p:leading-relaxed prose-headings:my-1.5 prose-li:my-0.5',
      'prose-pre:my-2 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:whitespace-pre',
      'prose-pre:rounded-lg prose-pre:bg-muted/70 prose-pre:p-3',
      'prose-code:before:content-none prose-code:after:content-none',
      '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
      className,
    )}>
      <Markdown
        remarkPlugins={ASK_USER_REMARK_PLUGINS}
        urlTransform={safeUrlTransform}
        components={ASK_USER_MARKDOWN_COMPONENTS}
      >
        {children}
      </Markdown>
    </div>
  )
}

/** AskUserBanner 属性接口 */
interface AskUserBannerProps {
  sessionId: string
}

export function AskUserBanner({ sessionId }: AskUserBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingAskUserRequestsAtom)
  const [drafts, setDrafts] = useAtom(askUserDraftsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [submitting, setSubmitting] = React.useState(false)
  const bannerRef = React.useRef<HTMLDivElement>(null)

  const request = requests[0] ?? null
  const presentation = request?.toolInput.presentation
  const isDirectWorkflowApproval = presentation !== null
    && typeof presentation === 'object'
    && !Array.isArray(presentation)
    && (presentation as Record<string, unknown>).kind === 'direct-workflow'
  const questions = request?.questions ?? []
  const requestDraft = request ? drafts.get(request.requestId) : undefined
  const activeTab = questions.length > 0
    ? Math.min(Math.max(requestDraft?.activeTab ?? 0, 0), questions.length - 1)
    : 0
  const focusedOptIdx = requestDraft?.focusedOptIdx ?? -1
  const answers = requestDraft?.answers ?? createInitialDraft(questions).answers
  const isLastTab = activeTab >= questions.length - 1

  // ===== Refs：确保 keydown handler 始终读取最新值，消除闭包过期问题 =====
  const activeTabRef = React.useRef(activeTab)
  activeTabRef.current = activeTab
  const questionsRef = React.useRef(questions)
  questionsRef.current = questions
  const focusedOptIdxRef = React.useRef(focusedOptIdx)
  focusedOptIdxRef.current = focusedOptIdx
  const submitRef = React.useRef<(() => void) | null>(null)
  const autoAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAutoAdvanceTimer = React.useCallback((): void => {
    if (autoAdvanceTimerRef.current != null) {
      clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
  }, [])

  // 组件卸载时清理未触发的跳转定时器
  React.useEffect(() => clearAutoAdvanceTimer, [clearAutoAdvanceTimer])

  React.useEffect(() => {
    clearAutoAdvanceTimer()
    if (!request || questions.length === 0) return
    setDrafts((prev) => {
      const current = prev.get(request.requestId)
      if (current && current.activeTab >= 0 && current.activeTab < questions.length) return prev
      const map = new Map(prev)
      map.set(request.requestId, createInitialDraft(questions))
      return map
    })
  }, [request?.requestId, questions, clearAutoAdvanceTimer, setDrafts])

  // 新请求到达时自动聚焦横幅，键盘快捷键即可用（与计划审批横幅一致）
  React.useEffect(() => {
    if (request && questions.length > 0) bannerRef.current?.focus({ preventScroll: true })
  }, [request?.requestId, questions.length])

  // 键盘导航：只在 requestId 变化时重建 handler，内部通过 ref 读取最新值
  React.useEffect(() => {
    if (!request || questions.length === 0) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const curTab = activeTabRef.current
      const qs = questionsRef.current
      const curFocusIdx = focusedOptIdxRef.current
      const q = qs[curTab]
      if (!q) return
      const allowCustom = q.allowCustom !== false
      const itemCount = q.options.length + (allowCustom ? 1 : 0)
      const lastTab = curTab >= qs.length - 1
      if (itemCount === 0) return

      // 输入框内：Enter 提交/翻题，Shift+Enter 换行（textarea），与主输入框约定一致；
      // 方向键不被吞——从输入框里也能继续用 ↑↓ 移动选项焦点。
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (lastTab) submitRef.current?.()
          else setActiveTabByState((prev) => prev + 1)
          return
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        // 从输入框接管方向键：焦点交还横幅容器后落入下方通用导航逻辑
        e.preventDefault()
        ;(e.target as HTMLElement).blur()
        bannerRef.current?.focus({ preventScroll: true })
      }

      // 焦点在按钮上时：Enter/空格交给原生 click 激活，避免与横幅快捷键双触发；
      // 方向键等其他按键仍继续走横幅导航（否则点完 Tab 后无法再用 ↑↓ 选择）
      if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const nextIdx = curFocusIdx === -1
          ? (e.key === 'ArrowDown' ? 0 : itemCount - 1)
          : e.key === 'ArrowDown'
            ? (curFocusIdx + 1) % itemCount
            : (curFocusIdx - 1 + itemCount) % itemCount
        setFocusedOptIdxByState(nextIdx)
        // 单选：移动焦点即选中（保留快捷流）；多选：只移动高亮，由空格切换选中
        if (!q.multiSelect) {
          if (nextIdx < q.options.length) {
            const opt = q.options[nextIdx]
            if (opt) toggleOptionByState(curTab, q, opt.label)
          } else if (allowCustom) {
            toggleCustomByState(curTab)
          }
        }
      } else if (q.multiSelect && (e.key === ' ' || e.code === 'Space')) {
        // 多选：空格切换当前高亮项的选中态（未高亮时不动作）
        e.preventDefault()
        if (curFocusIdx < 0) return
        if (curFocusIdx < q.options.length) {
          const opt = q.options[curFocusIdx]
          if (opt) toggleOptionByState(curTab, q, opt.label)
        } else if (allowCustom) {
          toggleCustomByState(curTab)
        }
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        if (lastTab) submitRef.current?.()
        else setActiveTabByState((prev) => prev + 1)
      }
    }

    const banner = bannerRef.current
    if (!banner) return

    // 只在问答横幅自身（或其子控件）获得焦点时响应快捷键，
    // 避免横幅打开期间用户在其他输入框打字按 Enter/↑↓ 被误触切题/提交。
    banner.addEventListener('keydown', handleKeyDown)
    return () => banner.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  /** 关闭问题 & 终止 Agent */
  const handleDismiss = (): void => {
    // 立即标记 streaming 停止，避免 UI 残留
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
    // 清除当前 session 所有待处理的 AskUser 请求
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    clearDrafts(requests.map((r) => r.requestId))
    // 终止 Agent
    window.electronAPI.stopAgent(sessionId, 'renderer-ask-user-dismiss').catch(console.error)
  }

  if (!request) return null

  const getAnswer = (idx: number): AskUserQuestionDraft => answers.get(idx) ?? EMPTY_ANSWER

  function updateCurrentDraft(updater: (draft: AskUserRequestDraft) => AskUserRequestDraft): void {
    if (!request) return
    setDrafts((prev) => {
      const current = prev.get(request.requestId) ?? createInitialDraft(questions)
      const map = new Map(prev)
      map.set(request.requestId, updater(current))
      return map
    })
  }

  function updateAnswers(updater: (prev: Map<number, AskUserQuestionDraft>) => Map<number, AskUserQuestionDraft>): void {
    updateCurrentDraft((draft) => ({ ...draft, answers: updater(draft.answers) }))
  }

  function setActiveTabByState(update: number | ((prev: number) => number)): void {
    updateCurrentDraft((draft) => {
      const rawNext = typeof update === 'function' ? update(draft.activeTab) : update
      const maxTab = Math.max(questions.length - 1, 0)
      const nextTab = Math.min(Math.max(rawNext, 0), maxTab)
      return {
        ...draft,
        activeTab: nextTab,
        focusedOptIdx: -1,
        answers: ensureAnswerForTab(draft.answers, questions, nextTab),
      }
    })
  }

  function setFocusedOptIdxByState(nextIdx: number): void {
    updateCurrentDraft((draft) => ({ ...draft, focusedOptIdx: nextIdx }))
  }

  function clearDrafts(requestIds: string[]): void {
    setDrafts((prev) => {
      const map = new Map(prev)
      requestIds.forEach((requestId) => map.delete(requestId))
      return map
    })
  }

  function toggleOptionByState(qIdx: number, q: AskUserQuestion, label: string): void {
    updateAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      const selected = q.multiSelect
        ? (cur.selected.includes(label) ? cur.selected.filter((s) => s !== label) : [...cur.selected, label])
        : [label]
      map.set(qIdx, { ...cur, selected, showCustom: false, customText: '', attachments: releaseAttachments(cur) })
      return map
    })
  }

  function toggleCustomByState(qIdx: number): void {
    updateAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      map.set(qIdx, {
        ...cur,
        showCustom: !cur.showCustom,
        selected: cur.showCustom ? cur.selected : [],
        attachments: releaseAttachments(cur),
      })
      return map
    })
  }

  const hasValidAnswers = hasValidAskUserAnswers(questions, answers)

  const handleSubmit = async (): Promise<void> => {
    if (submitting || !hasValidAnswers) return
    setSubmitting(true)
    try {
      const answersRecord = buildAskUserAnswersRecord(questions, answers, isDirectWorkflowApproval)
      const attachments = collectAskUserAttachments(questions, answers, isDirectWorkflowApproval)
      await window.electronAPI.respondAskUser({
        requestId: request.requestId,
        answers: answersRecord,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
      clearDrafts([request.requestId])
    } catch (error) {
      console.error('[AskUserBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  submitRef.current = handleSubmit

  const currentQuestion = questions[activeTab]
  if (!currentQuestion) return null

  const goNextTab = (): void => {
    if (!isLastTab) setActiveTabByState((prev) => prev + 1)
  }

  return (
    <div
      ref={bannerRef}
      tabIndex={0}
      aria-label={isDirectWorkflowApproval ? '实施方向待确认' : 'Domi Agent 等待输入'}
      className="ask-user-banner mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary/40 animate-in slide-in-from-bottom-2 duration-200"
    >
      {/* 头部 + Tab 栏 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">
            {isDirectWorkflowApproval ? '实施方向待确认' : 'Domi Agent 需要你的输入'}
          </span>
          <div className="flex items-center gap-1.5">
            {requests.length > 1 && (
              <span className="text-xs text-muted-foreground">(+{requests.length - 1})</span>
            )}
            <button
              type="button"
              className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={handleDismiss}
              title="关闭并终止 Agent"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Tab 栏（多问题时显示） */}
        {questions.length > 1 && (
          <div className="flex gap-1">
            {questions.map((q, idx) => {
              const isActive = idx === activeTab
              const hasAnswer = getAnswer(idx).selected.length > 0
                || (getAnswer(idx).showCustom && getAnswer(idx).customText.trim().length > 0)
              return (
                <button
                  key={idx}
                  type="button"
                  className={`
                    px-2.5 py-1 rounded-lg text-xs font-medium transition-all outline-none
                    ${isActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : hasAnswer
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }
                  `}
                  onClick={() => setActiveTabByState(idx)}
                >
                  {`${idx + 1}-${q.multiSelect ? '多选' : '单选'}：${q.header || `问题 ${idx + 1}`}`}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 当前问题内容 */}
      <div className="px-4 pb-2">
        <QuestionCard
          question={currentQuestion}
          questionIndex={activeTab}
          answer={getAnswer(activeTab)}
          focusedIndex={focusedOptIdx}
          showBadge={questions.length === 1}
          customOptionLabel={isDirectWorkflowApproval ? '调整后再确认' : '其他...'}
          customInputPlaceholder={isDirectWorkflowApproval ? '写下希望调整的内容；提交后 Agent 会修订方向并重新请求确认' : '输入自定义答案...'}
          customInputMultiline={isDirectWorkflowApproval}
          onToggleOption={(label) => {
            toggleOptionByState(activeTab, currentQuestion, label)
            if (!currentQuestion.multiSelect && !isLastTab) {
              clearAutoAdvanceTimer()
              autoAdvanceTimerRef.current = setTimeout(() => {
                autoAdvanceTimerRef.current = null
                setActiveTabByState((prev) => prev + 1)
              }, 150)
            }
          }}
          onToggleCustom={() => toggleCustomByState(activeTab)}
          onCustomTextChange={(text) => updateAnswers((prev) => {
            const map = new Map(prev)
            const cur = map.get(activeTab) ?? EMPTY_ANSWER
            map.set(activeTab, { ...cur, customText: text })
            return map
          })}
          onAttachImages={(items) => updateAnswers((prev) => {
            const map = new Map(prev)
            const cur = map.get(activeTab) ?? EMPTY_ANSWER
            map.set(activeTab, { ...cur, attachments: [...(cur.attachments ?? []), ...items] })
            return map
          })}
          onRemoveImage={(id) => updateAnswers((prev) => {
            const map = new Map(prev)
            const cur = map.get(activeTab) ?? EMPTY_ANSWER
            const target = cur.attachments?.find((img) => img.id === id)
            if (target) URL.revokeObjectURL(target.previewUrl)
            map.set(activeTab, { ...cur, attachments: (cur.attachments ?? []).filter((img) => img.id !== id) })
            return map
          })}
          onSubmit={isLastTab ? handleSubmit : goNextTab}
        />
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-end gap-1.5 px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40 mr-auto">
          {isDirectWorkflowApproval && getAnswer(activeTab).showCustom
            ? 'Shift+Enter 换行 · Enter 提交调整'
            : `${currentQuestion.multiSelect ? '↑↓ 移动 · 空格 选择 · Enter ' : '↑↓ 选择 · Enter '}${isLastTab ? '确认' : '下一个'}`}
        </span>
        {!isLastTab && (
          <Button
            variant="secondary"
            size="sm"
            onClick={goNextTab}
            className="h-7 px-3 text-xs"
          >
            下一个
          </Button>
        )}
        {isLastTab && (
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || !hasValidAnswers}
            className="h-7 px-3 text-xs"
          >
            <Send className="size-3 mr-1" />
            {isDirectWorkflowApproval && getAnswer(activeTab).showCustom ? '提交调整' : '确认'}
          </Button>
        )}
      </div>
    </div>
  )
}

function createInitialDraft(questions: readonly AskUserQuestion[]): AskUserRequestDraft {
  return {
    activeTab: 0,
    focusedOptIdx: -1,
    answers: ensureAnswerForTab(new Map(), questions, 0),
  }
}

function ensureAnswerForTab(
  answers: Map<number, AskUserQuestionDraft>,
  questions: readonly AskUserQuestion[],
  tabIndex: number,
): Map<number, AskUserQuestionDraft> {
  if (answers.has(tabIndex)) return answers
  const firstOpt = questions[tabIndex]?.options[0]
  if (!firstOpt) return answers
  const map = new Map(answers)
  map.set(tabIndex, { ...EMPTY_ANSWER, selected: [firstOpt.label] })
  return map
}

/** 释放草稿中已贴图片的预览 URL，并返回空附件列表（用于隐藏输入框时保持所见即所发） */
function releaseAttachments(draft: AskUserQuestionDraft): InputImageAttachment[] {
  draft.attachments?.forEach((img) => URL.revokeObjectURL(img.previewUrl))
  return []
}

/** 单个问题卡片（竖向选项） */
function QuestionCard({
  question,
  questionIndex,
  answer,
  focusedIndex,
  showBadge,
  customOptionLabel,
  customInputPlaceholder,
  customInputMultiline,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onAttachImages,
  onRemoveImage,
  onSubmit,
}: {
  question: AskUserQuestion
  questionIndex: number
  answer: AskUserQuestionDraft
  focusedIndex: number
  showBadge: boolean
  customOptionLabel: string
  customInputPlaceholder: string
  customInputMultiline: boolean
  onToggleOption: (label: string) => void
  onToggleCustom: () => void
  onCustomTextChange: (text: string) => void
  onAttachImages: (items: InputImageAttachment[]) => void
  onRemoveImage: (id: string) => void
  onSubmit: () => void
}): React.ReactElement {
  const customInputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const voiceInputIdRef = React.useRef(`ask-user-custom-${Math.random().toString(36).slice(2)}`)
  const customTextRef = React.useRef(answer.customText)
  const previewRef = React.useRef<{ sessionId: string; start: number; text: string } | null>(null)
  const onCustomTextChangeRef = React.useRef(onCustomTextChange)
  const optionCount = question.options.length
  const previewOption = focusedIndex >= 0 && focusedIndex < optionCount
    ? question.options[focusedIndex]
    : question.options.find((o) => answer.selected.includes(o.label))
  const previewContent = previewOption?.preview

  customTextRef.current = answer.customText
  onCustomTextChangeRef.current = onCustomTextChange

  // 单行模式随内容自动增高（上限后内部滚动）；多行模式保持固定起始高度、可手动拉伸
  React.useEffect(() => {
    const el = customInputRef.current
    if (!el || customInputMultiline) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [answer.customText, answer.showCustom, customInputMultiline])

  React.useEffect(() => {
    if (!answer.showCustom) {
      previewRef.current = null
      return
    }

    const restoreSelection = (input: HTMLInputElement | HTMLTextAreaElement | null, cursor: number): void => {
      requestAnimationFrame(() => {
        input?.focus()
        input?.setSelectionRange(cursor, cursor)
      })
    }

    const replacePreview = (sessionId: string, text: string): boolean => {
      if (getLastFocusedVoiceInputId() !== voiceInputIdRef.current) return false
      const input = customInputRef.current
      const currentText = customTextRef.current
      const previous = previewRef.current
      const canReplacePrevious = previous?.sessionId === sessionId &&
        currentText.slice(previous.start, previous.start + previous.text.length) === previous.text
      const start = canReplacePrevious ? previous.start : (input?.selectionStart ?? currentText.length)
      const end = canReplacePrevious ? start + (previous?.text.length ?? 0) : (input?.selectionEnd ?? start)
      const nextText = `${currentText.slice(0, start)}${text}${currentText.slice(end)}`

      previewRef.current = { sessionId, start, text }
      onCustomTextChangeRef.current(nextText)
      restoreSelection(input, start + text.length)
      return true
    }

    const previewHandler = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string; text?: string }>).detail
      if (!detail?.sessionId) return
      if (replacePreview(detail.sessionId, detail.text ?? '')) {
        event.preventDefault()
      }
    }

    const clearPreviewHandler = (event: Event): void => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      const preview = previewRef.current
      if (!sessionId || preview?.sessionId !== sessionId) return
      if (replacePreview(sessionId, '')) {
        previewRef.current = null
        event.preventDefault()
      }
    }

    const insertHandler = (event: Event): void => {
      if (getLastFocusedVoiceInputId() !== voiceInputIdRef.current) return
      const detail = (event as CustomEvent<{ sessionId?: string; text?: string }>).detail
      const text = detail?.text?.trim()
      if (!text) return

      const input = customInputRef.current
      const currentText = customTextRef.current
      const preview = previewRef.current
      const canReplacePreview = !!detail?.sessionId && preview?.sessionId === detail.sessionId &&
        currentText.slice(preview.start, preview.start + preview.text.length) === preview.text
      const start = canReplacePreview ? preview.start : (input?.selectionStart ?? currentText.length)
      const end = canReplacePreview ? start + (preview?.text.length ?? 0) : (input?.selectionEnd ?? start)
      const nextText = `${currentText.slice(0, start)}${text}${currentText.slice(end)}`
      const nextCursor = start + text.length

      previewRef.current = null
      onCustomTextChangeRef.current(nextText)
      event.preventDefault()
      restoreSelection(input, nextCursor)
    }

    window.addEventListener(VOICE_DICTATION_PREVIEW_EVENT, previewHandler)
    window.addEventListener(VOICE_DICTATION_CLEAR_PREVIEW_EVENT, clearPreviewHandler)
    window.addEventListener(VOICE_DICTATION_INSERT_EVENT, insertHandler)
    return () => {
      window.removeEventListener(VOICE_DICTATION_PREVIEW_EVENT, previewHandler)
      window.removeEventListener(VOICE_DICTATION_CLEAR_PREVIEW_EVENT, clearPreviewHandler)
      window.removeEventListener(VOICE_DICTATION_INSERT_EVENT, insertHandler)
    }
  }, [answer.showCustom])

  return (
    <div className="space-y-2">
      {/* 问题标签 + 文本（分行显示） */}
      <div className="space-y-1">
        {showBadge && (
          <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground shadow-sm">
            {`${questionIndex + 1}-${question.multiSelect ? '多选' : '单选'}${question.header ? `：${question.header}` : ''}`}
          </span>
        )}
        <AskUserMarkdown className="max-h-60 overflow-y-auto pr-1 text-sm">
          {question.question}
        </AskUserMarkdown>
      </div>

      {/* 竖向选项 */}
      <div className="flex flex-col gap-1">
        {question.options.map((option, idx) => {
          const isSelected = answer.selected.includes(option.label)
          const isFocused = focusedIndex === idx
          return (
            <button
              key={option.label}
              type="button"
              className={`
                flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-all outline-none text-left
                ${isSelected
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted/50 text-foreground/80 hover:bg-muted'
                }
                ${isFocused ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
              `}
              onClick={() => onToggleOption(option.label)}
            >
              <span className={`text-[10px] shrink-0 ${isSelected ? 'text-primary-foreground/60' : 'text-muted-foreground/50'}`}>
                {idx + 1}
              </span>
              <div className="flex flex-col min-w-0">
                <span className="font-medium">{option.label}</span>
                {option.description && (
                  <span className={`text-[11px] ${isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {option.description}
                  </span>
                )}
              </div>
            </button>
          )
        })}

        {/* 普通问答显示“其他”；Direct 审批使用专用的“调整后再确认”路径。 */}
        {question.allowCustom !== false && (
          <button
            type="button"
            className={`
              flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all outline-none text-left
              ${answer.showCustom
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted/50 text-foreground/80 hover:bg-muted'
              }
              ${focusedIndex === optionCount ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
            `}
            onClick={onToggleCustom}
          >
            <span className={`text-[10px] shrink-0 ${answer.showCustom ? 'text-primary-foreground/60' : 'text-muted-foreground/50'}`}>
              {optionCount + 1}
            </span>
            <span className="font-medium">{customOptionLabel}</span>
          </button>
        )}
      </div>

      {/* 自由文本输入 — 统一为自动增高多行文本域：Enter 提交、Shift+Enter 换行。 */}
      {answer.showCustom && question.allowCustom !== false && (
        <div className="relative flex flex-col gap-1.5">
          <textarea
            ref={(node) => { customInputRef.current = node }}
            rows={customInputMultiline ? 4 : 1}
            className={`w-full px-3 py-2 pr-9 rounded-lg text-xs leading-relaxed bg-muted/40 focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 transition-colors ${customInputMultiline ? 'resize-y' : 'resize-none overflow-hidden'}`}
            placeholder={customInputMultiline
              ? `${customInputPlaceholder}（可直接粘贴截图）`
              : `${customInputPlaceholder}；Shift+Enter 换行`}
            value={answer.customText}
            onChange={(e) => onCustomTextChange(e.target.value)}
            onPaste={(e) => {
              const imageFiles = extractImageFiles(e.clipboardData)
              if (imageFiles.length === 0) return
              e.preventDefault()
              void createAttachmentsFromFiles(imageFiles)
                .then(onAttachImages)
                .catch((error) => console.error('[AskUserBanner] 粘贴图片失败:', error))
            }}
            onFocus={() => setLastFocusedVoiceInputId(voiceInputIdRef.current)}
            onKeyDown={(e) => {
              // 与全 App 约定一致：Enter 提交、Shift+Enter 换行
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                e.stopPropagation() // 阻止冒泡到横幅 handler，避免重复触发 setActiveTab
                onSubmit()
              }
            }}
            autoFocus
          />
          <SpeechButton className="absolute right-1 top-1 size-6 rounded-full" />
          <AttachmentChipRow attachments={answer.attachments ?? []} onRemove={onRemoveImage} />
        </div>
      )}

      {/* 选项 Preview（聚焦或选中时展示） */}
      {previewContent && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded-lg bg-muted/40 p-3">
          <AskUserMarkdown className="text-xs prose-p:my-0 prose-headings:my-0.5 prose-li:my-0">
            {previewContent}
          </AskUserMarkdown>
        </div>
      )}
    </div>
  )
}
