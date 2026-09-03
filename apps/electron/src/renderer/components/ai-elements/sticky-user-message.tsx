/**
 * StickyUserMessage — 返回上一条提问快捷入口
 *
 * 当任意用户消息完全滚出 Conversation 视口顶部时，
 * 在顶部居中显示紧凑的“返回上一条提问”按钮，点击可回滚到原始消息位置。
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { ArrowUp } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { useAtomValue } from 'jotai'
import { stickyUserMessageEnabledAtom } from '@/atoms/ui-preferences'

interface StickyUserMessageData {
  id: string
  time?: string
}

interface StickyUserMessageProps {
  userMessages: StickyUserMessageData[]
}

interface StickyReturnToQuestionShortcutProps {
  time?: string
  onClick: () => void
}

export function StickyReturnToQuestionShortcut({ time, onClick }: StickyReturnToQuestionShortcutProps): React.ReactElement {
  const accessibleLabel = time ? `返回上一条提问，${time}` : '返回上一条提问'

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-2">
      <button
        type="button"
        aria-label={accessibleLabel}
        title={accessibleLabel}
        className="sticky-return-question-button pointer-events-auto group relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-full border border-white/40 bg-gradient-to-b from-white/35 via-background/45 to-background/25 px-4 text-xs font-medium text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-1px_0_rgba(255,255,255,0.12),0_8px_24px_rgba(0,0,0,0.16)] backdrop-blur-2xl backdrop-saturate-150 transition-[border-color,color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-white/55 hover:text-foreground hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-1px_0_rgba(255,255,255,0.18),0_12px_30px_rgba(0,0,0,0.2)] active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:border-white/15 dark:from-white/15 dark:via-white/[0.08] dark:to-white/[0.04]"
        onClick={onClick}
      >
        <ArrowUp className="relative size-3.5 transition-transform duration-200 group-hover:-translate-y-0.5" />
        <span className="relative">返回上一条提问</span>
        {time && <span className="relative text-[11px] font-normal text-muted-foreground/80">· {time}</span>}
      </button>
    </div>
  )
}

export function StickyUserMessage({ userMessages }: StickyUserMessageProps): React.ReactElement {
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

  return <StickyReturnToQuestionShortcut time={stickyMessage.time} onClick={scrollToOriginal} />
}
