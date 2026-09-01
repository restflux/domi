import * as React from 'react'
import { ChevronDown, ChevronUp, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MessageResponse } from '@/components/ai-elements/message'
import type { AskUserRequest } from '@domi/shared'

const DEFAULT_PREVIEW_LINES = 12
const LONG_CONTENT_CHAR_THRESHOLD = 1800
const MAX_DETAILS_LENGTH = 12_000
const MAX_SUMMARY_LENGTH = 240

export interface DirectWorkflowPresentation {
  kind: 'direct-workflow'
  details: string
  summary?: string
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

function readMarkdown(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeMarkdown(value).slice(0, maxLength)
  return normalized || null
}

function extractPresentationSource(source: Record<string, unknown>): DirectWorkflowPresentation | null {
  const details = readMarkdown(source.details, MAX_DETAILS_LENGTH)
    ?? [source.intent, source.direction, source.reason]
      .map((value) => readMarkdown(value, 4_000))
      .filter((value): value is string => Boolean(value))
      .join('\n\n')
  if (!details) return null

  const summary = readMarkdown(source.summary, MAX_SUMMARY_LENGTH) ?? undefined
  return { kind: 'direct-workflow', details, ...(summary && { summary }) }
}

/**
 * 从宿主固定审批请求中提取 Direct Workflow 的 Markdown 快照。
 * 新契约直接使用自由 details；旧 intent/direction/reason 仍可作为会话恢复兼容输入，
 * 但只按自然段串联，不重新施加固定标题模板。
 */
export function extractDirectWorkflowPresentation(
  request: AskUserRequest | null | undefined,
): DirectWorkflowPresentation | null {
  const presentation = request?.toolInput.presentation
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return null
  const source = presentation as Record<string, unknown>
  if (source.kind !== 'direct-workflow') return null
  return extractPresentationSource(source)
}

/** 从持久化 RequestDirectWorkflow tool_use input 中恢复实施反馈。 */
export function extractDirectWorkflowToolPresentation(
  toolInput: Record<string, unknown> | null | undefined,
): DirectWorkflowPresentation | null {
  return toolInput ? extractPresentationSource(toolInput) : null
}

function getPreviewText(markdown: string, maxLines = DEFAULT_PREVIEW_LINES): string {
  const lines = markdown.split('\n')
  if (lines.length <= maxLines) return markdown
  return `${lines.slice(0, maxLines).join('\n').trimEnd()}\n\n…`
}

export interface DirectWorkflowPreviewBlockProps {
  presentation: DirectWorkflowPresentation
  basePath?: string
  basePaths?: string[]
  className?: string
}

export function DirectWorkflowPreviewBlock({
  presentation,
  basePath,
  basePaths,
  className,
}: DirectWorkflowPreviewBlockProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    setExpanded(false)
  }, [presentation.details, presentation.summary])

  const markdown = presentation.details
  const lineCount = markdown.split('\n').length
  const isLong = lineCount > DEFAULT_PREVIEW_LINES || markdown.length > LONG_CONTENT_CHAR_THRESHOLD
  const displayedMarkdown = expanded || !isLong ? markdown : getPreviewText(markdown)

  return (
    <div className={className} data-direct-workflow-feedback>
      <section className="rounded-xl border border-primary/15 bg-primary/[0.025] px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-primary/75" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground/85">
            {presentation.summary || '实施反馈'}
          </span>
        </div>

        <div className="relative mt-2 overflow-hidden rounded-lg border border-border/40 bg-background/55 px-3 py-2.5">
          <div className={cn(
            'overflow-hidden transition-[max-height] duration-200',
            !expanded && isLong && 'max-h-64',
          )}>
            <MessageResponse
              basePath={basePath}
              basePaths={basePaths}
              className="!bg-transparent !px-0 !py-0 text-[13px] leading-relaxed prose-p:my-1 prose-headings:my-1.5"
            >
              {displayedMarkdown}
            </MessageResponse>
          </div>
          {!expanded && isLong && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background/95 to-transparent" />
          )}
        </div>

        {isLong && (
          <button
            type="button"
            aria-expanded={expanded}
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary/75 hover:text-primary"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {expanded ? '收起反馈' : '展开完整反馈'}
          </button>
        )}
      </section>
    </div>
  )
}
