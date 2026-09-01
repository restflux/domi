/**
 * Skeleton - 骨架屏占位
 *
 * 内容加载完成前的形状预占位，替代 spinner。
 * 遵循 prefers-reduced-motion：减少动态时静止显示色块。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={cn('motion-safe:animate-pulse rounded-md bg-foreground/[0.06]', className)}
      {...props}
    />
  )
}

export { Skeleton }
