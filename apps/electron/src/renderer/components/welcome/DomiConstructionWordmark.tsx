import type * as React from 'react'
import domiMarkUrl from '@/assets/brand/domi-mark.png'
import domiWordmarkUrl from '@/assets/brand/domi-wordmark.png'

/** 复用 Domi 自有字标轮廓，让构字辅助线贯穿字形而不是悬在字标下方。 */
export function DomiConstructionWordmark(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="w-full max-w-[34rem] overflow-visible text-foreground/40"
      viewBox="0 0 640 210"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id="domi-construction-outline" x="-10%" y="-10%" width="120%" height="120%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="1.6" result="expanded" />
          <feComposite in="expanded" in2="SourceAlpha" operator="out" result="outline" />
          <feFlood floodColor="currentColor" floodOpacity="0.8" result="ink" />
          <feComposite in="ink" in2="outline" operator="in" />
        </filter>
      </defs>

      {/* 构字参考线比轮廓更浅，细节不承担任何状态或交互。 */}
      <g stroke="currentColor" strokeWidth="0.75" opacity="0.5">
        <path d="M30 45H601M30 90H601M30 150H601" />
        <path d="M137 20V177M467 20V177" strokeDasharray="4 5" />
        <circle cx="79" cy="97" r="53" strokeDasharray="4 5" />
        <circle cx="479" cy="77" r="22" strokeDasharray="4 5" />
        <path d="M30 39v12m0 33v12m0 48v12m571-117v12m0 33v12m0 48v12M131 20h12m-12 157h12m330-157h12m-12 157h12" />
      </g>
      <g fill="currentColor" fontFamily="ui-monospace, monospace" fontSize="10" letterSpacing="1" opacity="0.75">
        <text x="610" y="48">cap</text>
        <text x="610" y="93">x</text>
        <text x="610" y="153">base</text>
      </g>

      <image href={domiMarkUrl} x="30" y="48" width="99" height="99" filter="url(#domi-construction-outline)" />
      <image href={domiWordmarkUrl} x="153" y="45" width="409" height="104" filter="url(#domi-construction-outline)" />
    </svg>
  )
}
