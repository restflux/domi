/**
 * PlanPreviewBlock — ExitPlanMode 计划正文的紧凑预览。
 *
 * 计划不塞进审批横幅，而是作为消息正文中的独立块展示：默认只显示开头，
 * 用户可以展开全文；优先关联本轮 Write 的同内容文件，否则指向宿主持久化的
 * `.context/plan/current-plan.md` 固定入口，并复用现有预览面板查看完整计划。
 */

import * as React from 'react'
import { ChevronDown, ChevronUp, ExternalLink, FileText } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { cn } from '@/lib/utils'
import { MessageResponse } from '@/components/ai-elements/message'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { getToolPreviewBasePaths, isAbsoluteFilePath } from '@/components/diff/preview-open-path'
import { getFileParentPath } from '@/lib/file-utils'
import type { PreviewFile } from '@/atoms/preview-atoms'
import type { SDKAssistantMessage, SDKMessage, SDKToolUseBlock } from '@domi/shared'

const DEFAULT_PREVIEW_LINES = 12
const LONG_PLAN_CHAR_THRESHOLD = 1800

const PlanPreviewStopBottomFollowContext = React.createContext<() => void>(() => undefined)

export interface PlanExpansionToggleDecision {
  expanded: boolean
  shouldStopBottomFollow: boolean
}

/** 展开计划会显著增加消息高度，应先退出对话的底部跟随；收起无需额外干预。 */
export function resolvePlanExpansionToggle(expanded: boolean): PlanExpansionToggleDecision {
  return {
    expanded: !expanded,
    shouldStopBottomFollow: !expanded,
  }
}

/** 放在 Conversation 内，为计划展开动作提供可选的滚动控制。 */
export function PlanPreviewScrollControlProvider({ children }: React.PropsWithChildren): React.ReactElement {
  const { stopScroll } = useStickToBottomContext()
  return (
    <PlanPreviewStopBottomFollowContext.Provider value={stopScroll}>
      {children}
    </PlanPreviewStopBottomFollowContext.Provider>
  )
}

function normalizePlanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

/** 从 ExitPlanMode 的原始 toolInput 中安全提取计划正文。 */
export function extractPlanText(toolInput: Record<string, unknown> | undefined): string | null {
  const plan = toolInput?.plan
  if (typeof plan !== 'string') return null
  const normalized = normalizePlanText(plan)
  return normalized || null
}

/** 获取折叠状态下展示的计划开头。 */
export function getPlanPreviewText(plan: string, maxLines = DEFAULT_PREVIEW_LINES): string {
  const normalized = normalizePlanText(plan)
  if (!normalized) return ''

  const lines = normalized.split('\n')
  if (lines.length <= maxLines) return normalized
  return `${lines.slice(0, maxLines).join('\n').trimEnd()}\n\n…`
}

function getToolInputFilePath(input: Record<string, unknown>): string | null {
  const filePath = input.file_path ?? input.filePath ?? input.path
  return typeof filePath === 'string' && filePath.trim() ? filePath : null
}

/** 判断消息历史中是否已经持久化了同一份 ExitPlanMode 计划。 */
export function hasPersistedPlanToolUse(plan: string, allMessages: SDKMessage[]): boolean {
  const normalizedPlan = normalizePlanText(plan)
  if (!normalizedPlan) return false

  return allMessages.some((message) => {
    if (message.type !== 'assistant') return false
    const content = (message as SDKAssistantMessage).message?.content
    if (!Array.isArray(content)) return false
    return content.some((block) => {
      if (block.type !== 'tool_use') return false
      const toolBlock = block as SDKToolUseBlock
      return toolBlock.name === 'ExitPlanMode'
        && extractPlanText(toolBlock.input) === normalizedPlan
    })
  })
}

/**
 * 查找本轮 Write 工具写入的计划文件。
 * ExitPlanMode 本身通常只携带 plan 文本，因此仅在内容完全匹配时关联文件，
 * 避免把其它 Write 文件误当成计划。
 */
export function findPlanFilePath(plan: string, allMessages: SDKMessage[]): string | null {
  const normalizedPlan = normalizePlanText(plan)
  if (!normalizedPlan) return null

  for (let messageIndex = allMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = allMessages[messageIndex]
    if (message?.type !== 'assistant') continue

    const content = (message as SDKAssistantMessage).message?.content
    if (!Array.isArray(content)) continue

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (!block || block.type !== 'tool_use') continue

      const toolBlock = block as SDKToolUseBlock
      if (toolBlock.name !== 'Write' && toolBlock.name !== 'write') continue
      const input = (toolBlock.input ?? {}) as Record<string, unknown>
      if (typeof input.content !== 'string') continue
      if (normalizePlanText(input.content) !== normalizedPlan) continue

      const filePath = getToolInputFilePath(input)
      if (filePath) return filePath
    }
  }

  return null
}

/**
 * 新版宿主会把 ExitPlanMode.plan 固定写入会话工作台；历史消息仍优先使用当时的 Write 路径。
 * 即使旧消息对应文件尚不存在，预览也会使用计划正文快照，因此不会误读后续版本。
 */
export function resolvePlanFilePath(
  plan: string,
  allMessages: SDKMessage[],
  sessionPath?: string,
): string | null {
  const writtenPath = findPlanFilePath(plan, allMessages)
  if (writtenPath) return writtenPath
  if (!sessionPath?.trim()) return null

  const separator = sessionPath.includes('\\') ? '\\' : '/'
  const root = sessionPath.replace(/[\\/]+$/, '')
  return [root, '.context', 'plan', 'current-plan.md'].join(separator)
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

/**
 * 计划正文里的裸文件名通常指向计划文件同目录中的配套文档。
 * 只有 Write 记录提供绝对路径时才加入父目录，避免把相对 `.context/plan` 当成进程 cwd。
 */
export function getPlanContentBasePaths(
  planFilePath: string | null,
  basePath?: string,
  basePaths?: string[],
): string[] {
  const planDirectory = planFilePath && isAbsoluteFilePath(planFilePath)
    ? getFileParentPath(planFilePath)
    : null
  return getToolPreviewBasePaths(planDirectory ?? basePath, [
    ...(planDirectory && basePath ? [basePath] : []),
    ...(basePaths ?? []),
  ])
}

/**
 * 计划正文已经随 ExitPlanMode 请求进入 renderer；把它作为待审批计划的权威只读快照，
 * 避免路径空间歧义导致空白预览或误展示 Session Target 中的同名旧文件。
 */
export function buildPlanPreviewFile(
  filePath: string,
  plan: string,
  basePath?: string,
  basePaths?: string[],
): PreviewFile {
  const candidates = getToolPreviewBasePaths(basePath, basePaths)
  return {
    filePath,
    previewOnly: true,
    readOnly: true,
    basePaths: candidates.length > 0 ? candidates : undefined,
    snapshotContent: normalizePlanText(plan),
  }
}

export interface PlanPreviewBlockProps {
  sessionId?: string
  plan: string
  allMessages: SDKMessage[]
  basePath?: string
  basePaths?: string[]
  /** 已位于 assistant 消息正文内时不再额外添加头像缩进。 */
  embedded?: boolean
}

export function PlanPreviewBlock({
  sessionId,
  plan,
  allMessages,
  basePath,
  basePaths,
  embedded = false,
}: PlanPreviewBlockProps): React.ReactElement | null {
  const normalizedPlan = React.useMemo(() => normalizePlanText(plan), [plan])
  const openPreview = useOpenPreview()
  const planFilePath = React.useMemo(
    () => resolvePlanFilePath(normalizedPlan, allMessages, basePath),
    [allMessages, normalizedPlan, basePath],
  )
  const planContentBasePaths = React.useMemo(
    () => getPlanContentBasePaths(planFilePath, basePath, basePaths),
    [planFilePath, basePath, basePaths],
  )
  const [expanded, setExpanded] = React.useState(false)
  const stopBottomFollow = React.useContext(PlanPreviewStopBottomFollowContext)

  React.useEffect(() => {
    setExpanded(false)
  }, [normalizedPlan])

  if (!normalizedPlan) return null

  const lines = normalizedPlan.split('\n')
  const isLong = lines.length > DEFAULT_PREVIEW_LINES || normalizedPlan.length > LONG_PLAN_CHAR_THRESHOLD
  const displayedPlan = expanded || !isLong
    ? normalizedPlan
    : getPlanPreviewText(normalizedPlan)

  const handleOpenPreview = (): void => {
    if (!sessionId || !planFilePath) return
    openPreview(sessionId, buildPlanPreviewFile(
      planFilePath,
      normalizedPlan,
      basePath,
      basePaths,
    ))
  }

  const handleToggleExpanded = (): void => {
    const decision = resolvePlanExpansionToggle(expanded)
    if (decision.shouldStopBottomFollow) stopBottomFollow()
    setExpanded(decision.expanded)
  }

  return (
    <div className={cn(!embedded && 'pl-[56px] pb-2')} data-plan-preview>
      <section className="rounded-xl border border-primary/15 bg-primary/[0.025] px-3.5 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="size-4 shrink-0 text-primary/75" />
          <span className="text-sm font-medium text-foreground/85">实施计划</span>
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary/75">
            {lines.length} 行
          </span>
          {planFilePath && (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/55" title={planFilePath}>
              {getFileName(planFilePath)}
            </span>
          )}
        </div>

        <div className="relative mt-2 overflow-hidden rounded-lg border border-border/40 bg-background/55 px-3 py-2.5">
          <div className={cn(
            'overflow-hidden transition-[max-height] duration-200',
            !expanded && isLong && 'max-h-64',
          )}>
            <MessageResponse
              basePaths={planContentBasePaths}
              className="!bg-transparent !px-0 !py-0 text-[13px] leading-relaxed prose-p:my-1 prose-headings:my-1.5"
            >
              {displayedPlan}
            </MessageResponse>
          </div>
          {!expanded && isLong && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background/95 to-transparent" />
          )}
        </div>

        {(isLong || (sessionId && planFilePath)) && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {isLong && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={handleToggleExpanded}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/65 transition-colors hover:text-foreground/80"
              >
                {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                {expanded ? '收起计划' : '展开完整计划'}
              </button>
            )}
            {sessionId && planFilePath && (
              <button
                type="button"
                onClick={handleOpenPreview}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/65 transition-colors hover:text-foreground/80"
              >
                <ExternalLink className="size-3" />
                在预览面板查看
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
