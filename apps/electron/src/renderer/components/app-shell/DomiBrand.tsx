import type * as React from 'react'
import domiBrandMarkUrl from '@/assets/brand/domi-mark.png'
import domiWordmarkUrl from '@/assets/brand/domi-wordmark.png'
import { cn } from '@/lib/utils'

interface DomiBrandMarkProps {
  className?: string
}

export function DomiBrandMark({ className }: DomiBrandMarkProps): React.ReactElement {
  return (
    <img
      aria-hidden="true"
      alt=""
      draggable={false}
      src={domiBrandMarkUrl}
      className={cn(
        'domi-brand-mark block flex-shrink-0 select-none object-contain',
        className,
      )}
    />
  )
}

interface DomiWordmarkProps {
  className?: string
}

export function DomiWordmark({ className }: DomiWordmarkProps): React.ReactElement {
  return (
    <span
      aria-label="domi"
      role="img"
      className={cn(
        'domi-wordmark block h-[17px] w-[54px] flex-shrink-0 bg-current text-foreground/90',
        className,
      )}
      style={{
        WebkitMaskImage: `url(${domiWordmarkUrl})`,
        maskImage: `url(${domiWordmarkUrl})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  )
}

interface DomiBrandLockupProps {
  className?: string
  markClassName?: string
  wordmarkClassName?: string
}

export function DomiBrandLockup({
  className,
  markClassName,
  wordmarkClassName,
}: DomiBrandLockupProps): React.ReactElement {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2 select-none', className)}>
      <DomiBrandMark className={cn('size-7', markClassName)} />
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <DomiWordmark className={wordmarkClassName} />
        <span className="domi-ai-badge inline-flex h-[17px] flex-shrink-0 items-center rounded-full px-1.5 text-[9px] font-semibold leading-none tracking-[0.08em] text-foreground/75">
          AI
        </span>
      </span>
    </span>
  )
}
