import * as React from 'react'
import { List, Pin, PinOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTocHeadings } from '@/hooks/useTocHeadings'
import { useScrollSpy } from '@/hooks/useScrollSpy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface MarkdownTocProps {
  /** 预览滚动容器，标题提取与跳转都基于它 */
  containerRef: React.RefObject<HTMLElement>
  /** 文件内容标识，变化时重建目录 */
  contentKey: string
  /** 仅 Markdown 只读预览时为 true */
  enabled: boolean
  /** 固定时占用正文左侧宽度；未固定时通过悬浮入口覆盖展示 */
  pinned?: boolean
  /** 用户切换目录固定状态 */
  onPinnedChange?: (pinned: boolean) => void
}

/** 计算标题相对滚动容器的 top（不依赖 offsetParent 链） */
function offsetTopWithin(node: HTMLElement, container: HTMLElement): number {
  return node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
}

export function MarkdownToc({
  containerRef,
  contentKey,
  enabled,
  pinned = false,
  onPinnedChange,
}: MarkdownTocProps): React.ReactElement | null {
  const headings = useTocHeadings(containerRef, contentKey, enabled)
  const activeId = useScrollSpy(containerRef, headings)
  const listRef = React.useRef<HTMLDivElement>(null)

  // active 项保持在侧栏可视区内
  React.useEffect(() => {
    if (!activeId || !listRef.current) return
    const item = listRef.current.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const minLevel = React.useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings],
  )

  if (!enabled) return null

  const jumpTo = (heading: (typeof headings)[number]): void => {
    const container = containerRef.current
    if (!container) return
    const top = offsetTopWithin(heading.el, container)
    container.scrollTo({ top: Math.max(top - 8, 0), behavior: 'smooth' })
  }

  const tocPanel = (
    <nav
      aria-label="文档目录"
      data-markdown-toc-mode={pinned ? 'pinned' : 'floating'}
      {...(pinned ? { 'data-markdown-toc-reserves-space': 'true' } : {})}
      className={cn(
        'flex w-52 flex-col overflow-hidden rounded-lg bg-background/95 shadow-lg ring-1 ring-border/40 backdrop-blur-md',
        pinned && 'h-full max-h-full shrink-0 self-start bg-muted/40 shadow-none ring-0',
        !pinned && [
          'pointer-events-none invisible absolute left-0 top-0 max-h-full opacity-0 -translate-x-1 transition-[opacity,transform] duration-150',
          'group-hover/markdown-toc:pointer-events-auto group-hover/markdown-toc:visible group-hover/markdown-toc:translate-x-0 group-hover/markdown-toc:opacity-100',
          'group-focus-within/markdown-toc:pointer-events-auto group-focus-within/markdown-toc:visible group-focus-within/markdown-toc:translate-x-0 group-focus-within/markdown-toc:opacity-100',
        ],
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <div className="min-w-0 flex-1 text-[11px] font-medium text-foreground/40 select-none">目录</div>
        {onPinnedChange && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onPinnedChange(!pinned)}
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-foreground/[0.06] hover:text-foreground/70',
                  pinned ? 'text-primary' : 'text-foreground/45',
                )}
                aria-label={pinned ? '取消固定目录' : '固定目录'}
              >
                {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{pinned ? '取消固定，改为悬浮目录' : '固定目录'}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div ref={listRef} className="min-h-0 overflow-auto scrollbar-thin px-1 pb-2">
        {headings.length > 0 ? headings.map((heading) => {
          const active = heading.id === activeId
          return (
            <button
              key={heading.id}
              type="button"
              data-toc-id={heading.id}
              onClick={() => jumpTo(heading)}
              title={heading.text}
              style={{ paddingLeft: `${(heading.level - minLevel) * 12 + 8}px` }}
              className={cn(
                'block w-full text-left truncate rounded py-1 pr-2 text-[12px] leading-snug transition-colors',
                'border-l-2 border-transparent',
                active
                  ? 'border-primary text-foreground font-medium bg-foreground/[0.04]'
                  : 'text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.03]',
              )}
            >
              {heading.text}
            </button>
          )
        }) : (
          <div className="px-2 py-3 text-center text-[11px] text-foreground/35">暂无标题</div>
        )}
      </div>
    </nav>
  )

  if (pinned) {
    return <div className="m-2 flex min-h-0 w-52 shrink-0">{tocPanel}</div>
  }

  return (
    <div
      className="group/markdown-toc pointer-events-none absolute left-2 top-2 z-30 h-[calc(100%-16px)] w-7"
      data-markdown-toc-floating-root="true"
      data-markdown-toc-trigger-scope="button"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-markdown-toc-trigger="true"
            className="pointer-events-auto flex size-7 items-center justify-center rounded-md bg-background/80 text-foreground/45 shadow-sm ring-1 ring-border/30 backdrop-blur-sm hover:bg-background hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label="悬浮目录"
          >
            <List className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">悬浮目录</TooltipContent>
      </Tooltip>
      {tocPanel}
    </div>
  )
}
