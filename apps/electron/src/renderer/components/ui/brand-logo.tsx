import type { ComponentProps } from 'react'
import { MONOCHROME_LOGOS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'

/** 保留调用方的尺寸、布局和替代文本；单色品牌跟随主题前景色，彩色品牌保留原色。 */
export function BrandLogo({ src, alt = '', className, ...props }: ComponentProps<'img'>) {
  return <img
    {...props}
    src={src}
    alt={alt}
    className={cn(src && MONOCHROME_LOGOS.has(src) && 'dark:invert', className)}
  />
}
