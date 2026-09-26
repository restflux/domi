/**
 * ContentBlock — 单个 SDKAssistantMessage 内容块渲染
 *
 * 支持三种内容块类型：
 * - text: 通过 MessageResponse 渲染 Markdown
 * - tool_use: 语义化短语行（如 "读取 foo.ts 第 10-60 行"），展开显示结构化结果
 * - thinking: 运行时展开，完成后可手动查看的思考内容
 */

import * as React from 'react'
import { ZCodeReasoningHeading, ZCodeToolSummaryRow } from './ZCodeWorkPresentation'
import {
  ChevronUp,
  ChevronRight,
  XCircle,
  MessageSquareText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { skillTriggersByToolCallAtom } from '@/atoms/agent-atoms'
import { useAtomValue } from 'jotai'
import { MessageResponse } from '@/components/ai-elements/message'
import { getToolIcon, extractFilePath } from './tool-utils'
import { getToolPhrase } from './tool-phrase'
import { ToolResultRenderer } from './tool-result-renderers'
import { PreviewOpenButton } from './tool-result-renderers/preview-open-button'
import { GeneratedImageStrip } from './generated-image-strip'
import { buildToolPresentationIndex, type ToolPresentationIndex } from './tool-presentation-index'
import { DirectWorkflowPreviewBlock, extractDirectWorkflowToolPresentation } from './DirectWorkflowPreviewBlock'
import { PlanPreviewBlock, extractPlanText } from './PlanPreviewBlock'
import { getTaskGetStatusLabel, parseTaskGetResult, type ParsedTaskGetResult } from './tool-result-renderers/task-get-result'
import { parseTaskListResult, type ParsedTaskListItem } from './tool-result-renderers/task-list-result'
import { useSmoothStream } from '@domi/ui'
import type {
  SDKContentBlock,
  SDKMessage,
  SDKTextBlock,
  SDKToolUseBlock,
  SDKThinkingBlock,
} from '@domi/shared'

// ===== SubAgent 结果文本解析 =====

/** 从 Agent tool_result 文本中剔除元数据，保留子代理的可读输出。 */
function parseAgentResultText(raw: string): string {
  return raw
    .replace(/<usage>[\s\S]*?<\/usage>/, '')
    .replace(/agentId:.*\n?/g, '')
    .replace(/<\/?output>/g, '')
    .trim()
}

function SubAgentFooter({ resultText }: { resultText?: string }): React.ReactElement | null {
  const cleanText = React.useMemo(() => resultText ? parseAgentResultText(resultText) : '', [resultText])
  if (!cleanText) return null

  return (
    <div className="mt-2 space-y-1.5 border-t border-border/20 pt-2">
      <div className="text-muted-foreground/70">
        <MessageResponse>{cleanText}</MessageResponse>
      </div>
    </div>
  )
}

// ===== ContentBlock Props =====

export interface ContentBlockProps {
  /** 内容块数据 */
  block: SDKContentBlock
  /** 所有消息（用于查找工具结果） */
  allMessages: SDKMessage[]
  /** 相对路径解析基准（文件链接用） */
  basePath?: string
  /** 多个可解析相对路径的基准目录 */
  basePaths?: string[]
  /** 是否启用入场动画 */
  animate?: boolean
  /** 在父级中的索引（用于动画延迟） */
  index?: number
  /** 当 turn 中已有主要内容（text）时，非主要块（tool/thinking）颜色变淡 */
  dimmed?: boolean
  /** 子代理的内容块（Agent/Task 工具调用的嵌套子块） */
  childBlocks?: SDKContentBlock[]
  /** 是否正在流式输出中。 */
  isStreaming?: boolean
  /** 是否为当前流式过程最后一个可见活动块；用于让流光在新行出现前保持连续。 */
  isActivityTail?: boolean
  /** 当前权威 Domi session ID，用于计划文件预览入口。 */
  sessionId?: string
  /** 由消息列表一次构建的工具展示索引。独立渲染入口可省略并回退本地构建。 */
  toolPresentationIndex?: ToolPresentationIndex
}

// ===== 提示词折叠行 =====

function PromptRow({ prompt, dimmed = false }: { prompt: string; dimmed?: boolean }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const preview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-2 py-0.5 text-left hover:opacity-70 transition-opacity group"
        onClick={() => setExpanded(!expanded)}
      >
        <MessageSquareText className={cn('size-3.5 shrink-0', dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground')} />

        <span className={cn(
          'shrink-0 text-[14px]',
          dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground',
        )}>提示词</span>

        <span className={cn(
          'truncate text-[14px]',
          dimmed ? 'text-muted-foreground/50' : 'text-muted-foreground/60',
        )}>
          {preview}
        </span>

        <ChevronRight
          className={cn(
            'shrink-0 size-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-all duration-150',
            expanded && 'rotate-90 opacity-100',
          )}
        />
      </button>

      {expanded && (
        <div className="ml-5.5 mt-1 mb-2 pl-3 border-l-2 border-border/30 animate-in fade-in slide-in-from-top-1 duration-150">
          <p className="text-[13px] text-foreground/70 leading-relaxed whitespace-pre-wrap break-words">
            {prompt}
          </p>
        </div>
      )}
    </div>
  )
}

// ===== 工具短语 diff 着色 =====

function TaskGetCollapsedSummary({ task }: { task: ParsedTaskGetResult }): React.ReactElement {
  const blockPreview = task.blocks.length > 0
    ? `${task.blocks[0]}${task.blocks.length > 1 ? ` +${task.blocks.length - 1}` : ''}`
    : undefined

  return (
    <>
      {task.subject && (
        <>
          <span className="shrink-0 text-muted-foreground/35">·</span>
          <span className="min-w-0 truncate text-[14px] font-medium text-foreground/75">
            {task.subject}
          </span>
        </>
      )}
      {task.description && (
        <span className="hidden min-w-0 truncate text-[13px] text-muted-foreground/60 sm:inline">
          {task.description}
        </span>
      )}
      {task.status && (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          {getTaskGetStatusLabel(task.status)}
        </span>
      )}
      {blockPreview && (
        <span className="shrink-0 rounded-sm bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground/70">
          关联 {blockPreview}
        </span>
      )}
    </>
  )
}

function TaskListCollapsedSummary({ tasks }: { tasks: ParsedTaskListItem[] }): React.ReactElement {
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const activeCount = tasks.filter((task) => task.status === 'in_progress').length
  const pendingCount = tasks.filter((task) => task.status === 'pending').length

  return (
    <>
      <span className="shrink-0 text-muted-foreground/35">·</span>
      <span className="shrink-0 rounded-full bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/75">
        {completedCount}/{tasks.length} 已完成
      </span>
      {activeCount > 0 && (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          {activeCount} 进行中
        </span>
      )}
      {pendingCount > 0 && (
        <span className="hidden shrink-0 rounded-full bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground/65 sm:inline">
          {pendingCount} 待处理
        </span>
      )}
    </>
  )
}

// ===== 工具调用块 =====

const USER_WAITING_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'RequestDirectWorkflow',
])

interface ToolUseBlockProps {
  block: SDKToolUseBlock
  allMessages: SDKMessage[]
  animate?: boolean
  index?: number
  dimmed?: boolean
  childBlocks?: SDKContentBlock[]
  basePath?: string
  basePaths?: string[]
  /** 是否正在流式输出中。 */
  isStreaming?: boolean
  /** 是否为当前流式过程最后一个可见活动块。 */
  isActivityTail?: boolean
  /** 当前权威 Domi session ID，用于嵌套计划预览入口。 */
  sessionId?: string
  toolPresentationIndex: ToolPresentationIndex
}

function ToolUseBlock({ block, allMessages, animate = false, index = 0, dimmed = false, childBlocks, basePath, basePaths, isStreaming, isActivityTail = false, sessionId, toolPresentationIndex }: ToolUseBlockProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const skillTriggers = useAtomValue(skillTriggersByToolCallAtom)
  const skillTrigger = skillTriggers[block.id]
  const toolResult = toolPresentationIndex.get(block.id)
  const resultText = toolResult?.result
  const resultImages = toolResult?.images ?? []
  const isError = toolResult?.isError === true
  const taskGetSummary = React.useMemo(() => {
    if (block.name !== 'TaskGet' || !resultText || isError) return null
    return parseTaskGetResult(resultText)
  }, [block.name, resultText, isError])
  const taskListSummary = React.useMemo(() => {
    if (block.name !== 'TaskList' || !resultText || isError) return null
    return parseTaskListResult(resultText)
  }, [block.name, resultText, isError])
  const isAgentTool = block.name === 'Agent' || block.name === 'Task'
  const hasChildren = isAgentTool && childBlocks && childBlocks.length > 0

  // Agent/Task 子代理内容默认折叠
  const [childrenExpanded, setChildrenExpanded] = React.useState(false)

  const phrase = getToolPhrase(block.name, block.input)
  const ToolIcon = getToolIcon(block.name)

  const isCompleted = toolResult?.completed === true
  const isUserWaitingTool = USER_WAITING_TOOL_NAMES.has(block.name)
  const isRunning = !!isStreaming && !isCompleted && !isError && !isUserWaitingTool
  // 工具结果返回后 Agent 仍需消费结果并决定下一步；在新的可见活动块出现前，
  // 由当前尾行继续承接流光，避免消息区短暂无活动焦点。
  const showActivityShimmer = isRunning || (
    !!isStreaming
    && isActivityTail
    && isCompleted
    && !isError
    && !isUserWaitingTool
  )

  // 工具真正未完成时显示进行时；已完成但仍承接活动游标时保留完成态文案。
  const displayLabel = isRunning ? phrase.loadingLabel : phrase.label
  const labelSeparator = displayLabel.indexOf(' ')
  const filePath = extractFilePath(block.input)
  const isPreviewable = (
    (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') &&
    isCompleted &&
    filePath
  )

  const delay = animate && index < 10 ? `${index * 30}ms` : '0ms'

  // Agent/Task: 提取 prompt 用于气泡展示
  const agentPrompt = isAgentTool
    ? (typeof block.input.prompt === 'string' ? block.input.prompt : undefined)
    : undefined

  // ===== Agent/Task 工具：特殊渲染 =====
  if (isAgentTool) {
    return (
      <div
        className={cn(
          animate && 'animate-in fade-in duration-150 fill-mode-both',
        )}
        style={animate ? { animationDelay: delay } : undefined}
      >
        {/* ZCode ToolSummaryRow 保持视觉结构，子代理详情仍由 Domi 管理。 */}
        <ZCodeToolSummaryRow
            icon={<ToolIcon className="size-4" />}
            kindLabel={block.name === 'Agent' ? 'Agent' : '任务'}
            primaryText={displayLabel}
            running={showActivityShimmer}
            expanded={childrenExpanded}
            onToggle={() => setChildrenExpanded((current) => !current)}
            statusNode={isError ? <XCircle className="size-4 text-destructive" aria-label="工具执行失败" /> : undefined}
            title={displayLabel}
        />

        {/* 展开内容 */}
        {childrenExpanded && (
          <div className={cn(
            'ml-2 mt-2 space-y-2 border-l border-border pl-3.5',
            animate && 'animate-in fade-in slide-in-from-top-1 duration-150',
          )}>
            {/* 提示词：可折叠行 */}
            {agentPrompt && <PromptRow prompt={agentPrompt} dimmed={dimmed} />}

            {/* 子代理工具调用 */}
            {hasChildren && childBlocks.map((childBlock, ci) => (
              <ContentBlock
                key={ci}
                block={childBlock}
                allMessages={allMessages}
                basePath={basePath}
                basePaths={basePaths}
                animate={animate}
                index={ci}
                dimmed
                isStreaming={isStreaming}
                sessionId={sessionId}
                toolPresentationIndex={toolPresentationIndex}
              />
            ))}

            {/* SubAgent 完成信息 */}
            {isCompleted && (
              <SubAgentFooter resultText={toolResult?.result} />
            )}

            {/* 底部收起按钮 */}
            <button
              type="button"
              onClick={() => setChildrenExpanded(false)}
              className="flex items-center gap-1 text-xs text-foreground/40 hover:text-foreground/70 transition-colors"
            >
              <ChevronUp className="size-3" />
              <span>收起</span>
            </button>
          </div>
        )}
      </div>
    )
  }

  // ===== 普通工具：语义化短语 + 结构化结果 =====
  return (
    <div
      className={cn(
        animate && 'animate-in fade-in duration-150 fill-mode-both',
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
        <div className="flex min-w-0 items-center gap-2">
          <ZCodeToolSummaryRow
            icon={<ToolIcon className="size-4" />}
            kindLabel={labelSeparator < 0 ? displayLabel : displayLabel.slice(0, labelSeparator)}
            primaryText={labelSeparator < 0 ? '' : displayLabel.slice(labelSeparator + 1)}
            running={showActivityShimmer}
            expanded={expanded}
            title={filePath ?? displayLabel}
            onToggle={() => setExpanded((current) => !current)}
            statusNode={(
              <>
                {isError && <XCircle className="size-3.5 shrink-0 text-destructive" aria-label="工具执行失败" />}
                {skillTrigger && <span className="shrink-0 text-xs text-primary" title={`触发技能：${skillTrigger.skillName}`}>⚡ {skillTrigger.skillSlug}</span>}
                {taskGetSummary && <TaskGetCollapsedSummary task={taskGetSummary} />}
                {taskListSummary && <TaskListCollapsedSummary tasks={taskListSummary} />}
              </>
            )}
          />
          {isPreviewable && <PreviewOpenButton filePath={filePath} basePath={basePath} basePaths={basePaths} />}
        </div>

      {(resultImages.length > 0 || (expanded && resultText)) && (
        <div className={cn(
          'mt-2 ml-6 space-y-2 text-muted-foreground',
          animate && 'animate-in fade-in slide-in-from-top-1 duration-150',
        )}>
          {/* 图片工具完成后直接展示；文本结果仍遵循工具展开状态 */}
          {resultImages.length > 0 && <GeneratedImageStrip images={resultImages} />}
          {expanded && resultText && (
            <ToolResultRenderer
              toolName={block.name}
              input={block.input}
              result={resultText}
              isError={isError}
              basePath={basePath}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ===== 思考块 =====

interface ThinkingBlockProps {
  block: SDKThinkingBlock
  dimmed?: boolean
  isStreaming?: boolean
}

function ThinkingBlock({ block, dimmed = false, isStreaming = false }: ThinkingBlockProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = React.useState(!!isStreaming)
  const manuallyToggledRef = React.useRef(false)
  React.useEffect(() => {
    if (isStreaming && !manuallyToggledRef.current) setIsExpanded(true)
  }, [isStreaming])
  const { displayedContent } = useSmoothStream({
    content: block.thinking,
    isStreaming,
  })

  const toggleExpand = React.useCallback(() => {
    setIsExpanded((prev) => !prev)
  }, [])

  return (
    <div className="relative mb-1" data-work-thinking-view="v2">
      <ZCodeReasoningHeading
        label={isStreaming ? '思考中' : '思考'}
        isStreaming={isStreaming}
        isOpen={isExpanded}
        onToggle={() => {
          manuallyToggledRef.current = true
          toggleExpand()
        }}
      />
      {isExpanded && (
        <div className="relative ml-6 pt-2 text-muted-foreground">
          <div className={cn(
            'prose prose-sm dark:prose-invert max-w-none prose-p:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-[14px] leading-relaxed',
            dimmed ? 'text-muted-foreground' : 'text-foreground/90',
          )}>
            <MessageResponse className="font-normal prose-strong:font-normal [&_strong]:font-normal [&_b]:font-normal">
              {displayedContent}
            </MessageResponse>
          </div>
        </div>
      )}
    </div>
  )
}

function StreamingTextBlock({
  text,
  isStreaming,
  basePath,
  basePaths,
}: {
  text: string
  isStreaming?: boolean
  basePath?: string
  basePaths?: string[]
}): React.ReactElement {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming: isStreaming ?? false,
  })
  return <MessageResponse className="text-[14px] prose-p:my-2 prose-p:leading-[1.8] prose-li:leading-[1.8] prose-headings:mt-5" basePath={basePath} basePaths={basePaths}>{displayedContent}</MessageResponse>
}

// ===== ContentBlock 主组件 =====

export function ContentBlock({ block, allMessages, basePath, basePaths, animate = false, index = 0, dimmed = false, childBlocks, isStreaming, isActivityTail = false, sessionId, toolPresentationIndex }: ContentBlockProps): React.ReactElement | null {
  const effectiveToolPresentationIndex = React.useMemo(
    () => toolPresentationIndex ?? buildToolPresentationIndex(allMessages),
    [allMessages, toolPresentationIndex],
  )
  // text 块 — 主要内容，不受 dimmed 影响
  if (block.type === 'text') {
    const textBlock = block as SDKTextBlock
    if (!textBlock.text) return null
    return (
      <StreamingTextBlock
        text={textBlock.text}
        isStreaming={isStreaming}
        basePath={basePath}
        basePaths={basePaths}
      />
    )
  }

  // tool_use 块
  if (block.type === 'tool_use') {
    const toolBlock = block as SDKToolUseBlock
    if (toolBlock.name === 'RequestDirectWorkflow') {
      const presentation = extractDirectWorkflowToolPresentation(toolBlock.input)
      if (presentation) {
        return (
          <DirectWorkflowPreviewBlock
            presentation={presentation}
            basePath={basePath}
            basePaths={basePaths}
          />
        )
      }
    }
    if (toolBlock.name === 'ExitPlanMode') {
      const plan = extractPlanText(toolBlock.input)
      if (plan) {
        return (
          <PlanPreviewBlock
            sessionId={sessionId}
            plan={plan}
            allMessages={allMessages}
            basePath={basePath}
            basePaths={basePaths}
            embedded
          />
        )
      }
    }
    return (
      <ToolUseBlock
        block={toolBlock}
        allMessages={allMessages}
        animate={animate}
        index={index}
        dimmed={dimmed}
        childBlocks={childBlocks}
        basePath={basePath}
        basePaths={basePaths}
        isStreaming={isStreaming}
        isActivityTail={isActivityTail}
        sessionId={sessionId}
        toolPresentationIndex={effectiveToolPresentationIndex}
      />
    )
  }

  // thinking 块
  if (block.type === 'thinking') {
    const thinkingBlock = block as SDKThinkingBlock
    if (!thinkingBlock.thinking) return null
    return <ThinkingBlock block={thinkingBlock} dimmed={dimmed} isStreaming={isStreaming} />
  }

  return null
}
