/**
 * WelcomeWatermark — 新会话 Hero 布局的背景品牌水印
 *
 * 以主题前景色的低透明度渲染 Domi 品牌 mark（mask 方式，自动适配主题）。
 * hanging 用于 Chat Hero 的下垂构图，centered 用于 Work 固定底部 Composer 上方的
 * 中央启动面板。纯装饰：pointer-events-none + aria-hidden。
 */

import * as React from 'react'
import domiBrandMarkUrl from '@/assets/brand/domi-mark.png'
import { cn } from '@/lib/utils'

export interface WelcomeWatermarkProps {
  className?: string
  placement?: 'hanging' | 'centered'
}

export function WelcomeWatermark({ className, placement = 'hanging' }: WelcomeWatermarkProps): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute left-1/2 -translate-x-1/2 select-none',
        placement === 'hanging'
          ? 'bottom-0 size-[440px] translate-y-[46%]'
          : 'top-1/2 size-[340px] -translate-y-1/2',
        'bg-foreground/[0.05] dark:bg-foreground/[0.07]',
        className,
      )}
      style={{
        WebkitMaskImage: `url(${domiBrandMarkUrl})`,
        maskImage: `url(${domiBrandMarkUrl})`,
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
