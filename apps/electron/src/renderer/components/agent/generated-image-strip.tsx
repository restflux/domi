/**
 * GeneratedImageStrip — 生成图片缩略图条
 *
 * Agent 工具结果中图片的内联渲染：
 * - inline 型（base64）：直接显示
 * - path 型（localPath）：通过 readAttachment IPC 异步加载
 *
 * 点击任意缩略图打开 ImageLightbox，可在同组图片间左右翻页。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { ImageLightbox, type LightboxImage } from '@/components/ui/image-lightbox'
import { imageIdentity, type GeneratedToolImage } from './tool-result-images'
import type { GeneratedImagesRequest } from '@domi/shared'

export type StripImage = GeneratedToolImage

/** 加载本地图片为 data URL；画廊路径使用会话范围授权，普通工具结果沿用附件读取。 */
export function useAttachmentDataUrl(
  localPath: string | undefined,
  mimeType = 'image/png',
  galleryRequest?: GeneratedImagesRequest,
): string | null {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    setDataUrl(null)
    if (!localPath) return
    let cancelled = false
    const readImage = galleryRequest
      ? window.electronAPI.readGeneratedImage(galleryRequest, localPath)
      : window.electronAPI.readAttachment(localPath)
    readImage.then((base64) => {
      if (!cancelled) setDataUrl(`data:${mimeType};base64,${base64}`)
    })
      .catch((err: unknown) => {
        console.warn('[GeneratedImageStrip] 读取图片失败:', localPath, err)
      })
    return () => { cancelled = true }
  }, [localPath, mimeType, galleryRequest])

  return dataUrl
}

function StripThumbnail({
  image,
  index,
  onOpen,
  onLoaded,
  compact,
  galleryRequest,
}: {
  image: StripImage
  index: number
  onOpen: (index: number) => void
  onLoaded: (id: string, dataUrl: string) => void
  compact: boolean
  galleryRequest?: GeneratedImagesRequest
}): React.ReactElement | null {
  const loaded = useAttachmentDataUrl(image.localPath, image.mimeType, galleryRequest)
  const src = image.data ? `data:${image.mimeType};base64,${image.data}` : loaded

  React.useEffect(() => {
    if (src) onLoaded(imageIdentity(image), src)
  }, [src, image, onLoaded])

  if (!src) {
    // path 型尚未加载完成 / 加载失败：占位骨架（失败时保持占位不阻塞其余图片）
    return (
      <div
        className={cn(
          'shrink-0 rounded-lg border border-border/40 bg-muted/30 animate-pulse',
          compact ? 'size-20' : 'h-40 w-28',
        )}
        aria-label={image.filename ?? '生成图片'}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-lg border border-border/50 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        compact ? 'size-20' : 'h-40',
      )}
      title={image.filename ?? '查看大图'}
    >
      <img
        src={src}
        alt={image.filename ?? '生成图片'}
        className={cn(
          'h-full object-cover transition-transform duration-150 group-hover:scale-[1.02]',
          compact ? 'w-full' : 'w-auto max-w-[240px]',
        )}
        loading="lazy"
      />
    </button>
  )
}

export function GeneratedImageStrip({
  images,
  compact = false,
  label,
  galleryRequest,
}: {
  images: StripImage[]
  compact?: boolean
  label?: string
  galleryRequest?: GeneratedImagesRequest
}): React.ReactElement | null {
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const [lightboxIndex, setLightboxIndex] = React.useState(0)
  /** 每张图已解析出的 src，key = 图片身份（localPath 或内联数据）。
   *  用身份而非数组下标，避免父级重渲染产生新的 images 引用时把已加载的 path 型 src 重置成 null，
   *  导致子组件因 localPath 未变不再上报、缩略图可点但大图预览为空（点击无反应）。 */
  const [resolvedSrcs, setResolvedSrcs] = React.useState<Record<string, string>>({})

  const handleLoaded = React.useCallback((id: string, dataUrl: string) => {
    setResolvedSrcs((current) => (current[id] === dataUrl ? current : { ...current, [id]: dataUrl }))
  }, [])

  // inline 型立即解析；path 型先记空，等子组件读取完成后按身份键上报
  React.useEffect(() => {
    setResolvedSrcs((current) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const img of images) {
        const id = imageIdentity(img)
        if (img.data) {
          next[id] = `data:${img.mimeType};base64,${img.data}`
        } else if (current[id]) {
          // path 型：保留已加载的 src，避免重渲染丢失
          next[id] = current[id]
        }
        if (next[id] !== current[id]) changed = true
      }
      return changed ? next : current
    })
  }, [images])

  if (images.length === 0) return null

  const viewable = images
    .map((img, originalIndex) => ({ img, originalIndex, src: resolvedSrcs[imageIdentity(img)] ?? '' }))
    .filter((entry): entry is { img: StripImage; originalIndex: number; src: string } => !!entry.src)
  const lightboxImages: LightboxImage[] = viewable.map(({ img, src }) => ({
    src,
    alt: img.filename ?? '生成图片',
    onSave: img.localPath
      ? () => { void window.electronAPI.saveImageAs(img.localPath!, img.filename ?? 'generated-image.png') }
      : undefined,
  }))

  return (
    <div className="space-y-1.5" data-generated-image-strip={compact ? 'compact' : 'regular'}>
      {label && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <span>{label}</span>
          {images.length > 1 && <span>· {images.length} 张</span>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {images.map((image, index) => (
          <StripThumbnail
            key={imageIdentity(image)}
            image={image}
            index={index}
            onOpen={(i) => {
              // 定位到该缩略图在可预览集合中的位置
              const position = viewable.findIndex((entry) => entry.originalIndex === i)
              const fallback = Math.min(i, Math.max(viewable.length - 1, 0))
              setLightboxIndex(position >= 0 ? Math.min(position, viewable.length - 1) : fallback)
              setLightboxOpen(true)
            }}
            onLoaded={handleLoaded}
            compact={compact}
            galleryRequest={galleryRequest}
          />
        ))}
      </div>
      <ImageLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        images={lightboxImages}
        index={Math.min(lightboxIndex, Math.max(lightboxImages.length - 1, 0))}
        onIndexChange={setLightboxIndex}
      />
    </div>
  )
}
