/**
 * StickyUserMessage — 返回上一条提问快捷入口
 *
 * 当任意用户消息完全滚出 Conversation 视口顶部时，
 * 在顶部居中显示紧凑的“返回上一条提问”按钮；悬浮或聚焦时显示正文摘要，
 * 点击可回滚到原始消息位置。必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { ArrowUp, Paperclip } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { useAtomValue } from 'jotai'
import { stickyUserMessageEnabledAtom } from '@/atoms/ui-preferences'

const STICKY_PREVIEW_MAX_LENGTH = 240

export function buildStickyQuestionPreview(text: string): string {
  const normalized = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' [代码] ')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= STICKY_PREVIEW_MAX_LENGTH) return normalized
  return `${normalized.slice(0, STICKY_PREVIEW_MAX_LENGTH).trimEnd()}…`
}

interface StickyUserMessageData {
  id: string
  time?: string
  preview: string
  attachmentCount: number
}

interface StickyUserMessageProps {
  userMessages: StickyUserMessageData[]
  userName: string
  userAvatar: string
}

interface StickyReturnToQuestionShortcutProps {
  time?: string
  preview: string
  attachmentCount: number
  userName: string
  userAvatar: string
  onClick: () => void
}

function StickyUserAvatar({ avatar }: { avatar: string }): React.ReactElement {
  const isImage = avatar.startsWith('data:image') || avatar.startsWith('http')

  return (
    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-[20%] border border-foreground/10 bg-foreground/[0.06] text-xs">
      {isImage
        ? <img src={avatar} alt="" className="size-full object-cover" />
        : avatar}
    </span>
  )
}

export function StickyReturnToQuestionShortcut({
  time,
  preview,
  attachmentCount,
  userName,
  userAvatar,
  onClick,
}: StickyReturnToQuestionShortcutProps): React.ReactElement {
  const previewId = React.useId()
  const accessibleLabel = time ? `返回上一条提问，${time}` : '返回上一条提问'
  const hasPreview = preview.length > 0 || attachmentCount > 0

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2">
      <button
        type="button"
        aria-label={accessibleLabel}
        aria-describedby={hasPreview ? previewId : undefined}
        className="sticky-return-question-button group/shortcut pointer-events-auto relative grid w-fit max-w-[calc(100vw-3rem)] [interpolate-size:allow-keywords] overflow-hidden rounded-[18px] border border-white/40 bg-gradient-to-b from-white/35 via-background/45 to-background/25 text-xs font-medium text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-1px_0_rgba(255,255,255,0.12),0_8px_24px_rgba(0,0,0,0.16)] backdrop-blur-2xl backdrop-saturate-150 transition-[width,border-color,color,box-shadow,transform] duration-300 delay-150 hover:-translate-y-0.5 hover:w-[380px] hover:border-white/55 hover:text-foreground hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-1px_0_rgba(255,255,255,0.18),0_14px_34px_rgba(0,0,0,0.2)] hover:delay-0 active:translate-y-0 focus-visible:w-[380px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:delay-0 dark:border-white/15 dark:from-white/15 dark:via-white/[0.08] dark:to-white/[0.04]"
        onClick={onClick}
      >
        <span className="flex h-8 items-center justify-center gap-1.5 px-3 whitespace-nowrap">
          <ArrowUp className="size-3.5 transition-transform duration-200 group-hover/shortcut:-translate-y-0.5 group-focus-visible/shortcut:-translate-y-0.5" />
          <span>返回上一条提问</span>
          {time && <span className="text-[11px] font-normal text-muted-foreground/80">· {time}</span>}
        </span>

        {hasPreview && (
          <span
            id={previewId}
            className="grid w-0 max-w-[calc(100vw-3rem)] justify-self-center grid-rows-[0fr] opacity-0 transition-[width,grid-template-rows,opacity] duration-300 delay-150 group-hover/shortcut:w-[380px] group-hover/shortcut:grid-rows-[1fr] group-hover/shortcut:opacity-100 group-hover/shortcut:delay-0 group-focus-visible/shortcut:w-[380px] group-focus-visible/shortcut:grid-rows-[1fr] group-focus-visible/shortcut:opacity-100 group-focus-visible/shortcut:delay-0"
          >
            <span className="min-h-0 overflow-hidden">
              <span className="flex items-start gap-2 px-3 pb-2.5 pt-1 text-left">
                <StickyUserAvatar avatar={userAvatar} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground/70">{userName}</span>
                  {preview && (
                    <span className="mt-0.5 block line-clamp-3 text-sm font-normal leading-5 text-foreground/90">
                      {preview}
                    </span>
                  )}
                  {attachmentCount > 0 && (
                    <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                      <Paperclip className="size-3" />
                      <span>{attachmentCount} 个附件</span>
                    </span>
                  )}
                </span>
              </span>
            </span>
          </span>
        )}
      </button>
    </div>
  )
}

export function StickyUserMessage({ userMessages, userName, userAvatar }: StickyUserMessageProps): React.ReactElement {
  const { scrollRef, stopScroll, state: stickyState } = useStickToBottomContext()
  const stickyEnabled = useAtomValue(stickyUserMessageEnabledAtom)
  const [stickyMessage, setStickyMessage] = React.useState<StickyUserMessageData | null>(null)

  const userMessageMap = React.useMemo(
    () => new Map(userMessages.map((message) => [message.id, message])),
    [userMessages],
  )

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || userMessages.length === 0 || !stickyEnabled) {
      setStickyMessage(null)
      return
    }

    const check = (): void => {
      const containerRect = el.getBoundingClientRect()
      const nodes = el.querySelectorAll<HTMLElement>('[data-message-role="user"]')

      let foundMessage: StickyUserMessageData | null = null
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]!
        if (node.getBoundingClientRect().bottom >= containerRect.top) continue

        const messageId = node.getAttribute('data-message-id')
        if (messageId) foundMessage = userMessageMap.get(messageId) ?? null
        break
      }
      setStickyMessage(foundMessage)
    }

    el.addEventListener('scroll', check, { passive: true })

    const resizeObserver = new ResizeObserver(check)
    resizeObserver.observe(el)

    const contentEl = el.firstElementChild as HTMLElement | null
    if (contentEl) resizeObserver.observe(contentEl)

    const rafId = requestAnimationFrame(check)

    return () => {
      el.removeEventListener('scroll', check)
      resizeObserver.disconnect()
      cancelAnimationFrame(rafId)
    }
  }, [scrollRef, stickyEnabled, userMessageMap, userMessages.length])

  const scrollToOriginal = React.useCallback((): void => {
    const el = scrollRef.current
    if (!el || !stickyMessage) return

    const target = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === stickyMessage.id,
    )
    if (!target) return

    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0

    const containerRect = el.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const targetScrollTop = el.scrollTop + (targetRect.top - containerRect.top)
    el.scrollTo({ top: Math.max(0, targetScrollTop - 24), behavior: 'smooth' })
  }, [scrollRef, stickyMessage, stickyState, stopScroll])

  if (!stickyEnabled || !stickyMessage) return <></>

  return (
    <StickyReturnToQuestionShortcut
      time={stickyMessage.time}
      preview={stickyMessage.preview}
      attachmentCount={stickyMessage.attachmentCount}
      userName={userName}
      userAvatar={userAvatar}
      onClick={scrollToOriginal}
    />
  )
}
