/**
 * GeneratedGalleryDrawer — 会话级「生成图片」画廊抽屉
 *
 * 聚合当前会话中由生图工具（GPT Image / Nano Banana）产出的图片：
 * - Chat 会话：消息附件
 * - Agent 会话：工作目录 generated-images/ + 会话附件目录
 *
 * 缩略图网格按时间倒序；点击进 ImageLightbox 连续翻页；
 * 单图支持另存为 / 打开所在文件夹 / 复制路径。
 */

import * as React from 'react'
import { Copy, FolderOpen, ImageIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { GeneratedImageItem, GeneratedImagesRequest } from '@domi/shared'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { ImageLightbox, type LightboxImage } from '@/components/ui/image-lightbox'

function formatTime(mtime: number): string {
  if (!mtime) return ''
  const date = new Date(mtime)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function GalleryThumbnail({
  item,
  src,
  onOpen,
}: {
  item: GeneratedImageItem
  /** undefined=加载中；null=加载失败；string=可预览 */
  src: string | null | undefined
  onOpen: () => void
}): React.ReactElement {
  const handleShowInFolder = (): void => {
    window.electronAPI.showItemInFolder(item.localPath)
      .then((opened) => {
        if (!opened) toast.error('无法定位文件')
      })
      .catch((error) => {
        toast.error('无法定位文件', {
          description: error instanceof Error ? error.message : undefined,
        })
      })
  }

  const handleCopyPath = (): void => {
    navigator.clipboard.writeText(item.localPath)
      .then(() => toast.success('已复制路径'))
      .catch(() => toast.error('复制失败'))
  }

  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-border/50 bg-muted/20">
      {typeof src === 'string' ? (
        <button
          type="button"
          onClick={onOpen}
          className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          title={`${item.filename}（点击预览）`}
        >
          <img
            src={src}
            alt={item.filename}
            className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
            loading="lazy"
          />
        </button>
      ) : src === undefined ? (
        <div className="flex h-full w-full items-center justify-center bg-muted/30 animate-pulse">
          <Loader2 className="size-4 animate-spin text-muted-foreground/50" />
        </div>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted/30 text-muted-foreground/50">
          <ImageIcon className="size-5" />
          <span className="text-[10px]">无法读取</span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <span className="min-w-0 truncate text-[10px] text-white/90">{item.filename}</span>
        <span className="shrink-0 text-[10px] text-white/60">{formatTime(item.mtime)}</span>
      </div>
      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={handleShowInFolder}
          title="打开所在文件夹"
          className="flex size-6 items-center justify-center rounded-md bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/75"
        >
          <FolderOpen className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCopyPath}
          title="复制路径"
          className="flex size-6 items-center justify-center rounded-md bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/75"
        >
          <Copy className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

export function GeneratedGalleryDrawer({
  open,
  onOpenChange,
  request,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: GeneratedImagesRequest
}): React.ReactElement {
  const requestKind = request.kind
  const requestId = request.kind === 'chat' ? request.conversationId : request.sessionId
  const stableRequest = React.useMemo<GeneratedImagesRequest>(
    () => requestKind === 'chat'
      ? { kind: 'chat', conversationId: requestId }
      : { kind: 'agent', sessionId: requestId },
    [requestKind, requestId],
  )

  const [items, setItems] = React.useState<GeneratedImageItem[]>([])
  const [srcMap, setSrcMap] = React.useState<Record<string, string | null>>({})
  const [loading, setLoading] = React.useState(false)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)

  // 打开时拉取；不做后台轮询
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    window.electronAPI.listGeneratedImages(stableRequest)
      .then((list) => {
        if (cancelled) return
        setItems(list)
        setSrcMap({})
        setSelectedPath(null)
      })
      .catch((err: unknown) => {
        console.error('[GeneratedGallery] 加载失败:', err)
        if (!cancelled) {
          setItems([])
          setSrcMap({})
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, stableRequest])

  // 列表加载后并行读取缩略图；每张完成即显示，并与 Lightbox 复用 data URL
  React.useEffect(() => {
    if (!open || items.length === 0) return
    let cancelled = false
    for (const item of items) {
      window.electronAPI.readGeneratedImage(stableRequest, item.localPath)
        .then((base64) => {
          if (cancelled) return
          setSrcMap((current) => ({
            ...current,
            [item.localPath]: `data:${item.mediaType};base64,${base64}`,
          }))
        })
        .catch((err: unknown) => {
          console.warn('[GeneratedGallery] 图片读取失败:', item.localPath, err)
          if (!cancelled) setSrcMap((current) => ({ ...current, [item.localPath]: null }))
        })
    }
    return () => { cancelled = true }
  }, [open, items, stableRequest])

  React.useEffect(() => {
    if (!open) setLightboxOpen(false)
  }, [open])

  const viewableItems = items.filter((item) => typeof srcMap[item.localPath] === 'string')
  const lightboxImages: LightboxImage[] = viewableItems.map((item) => ({
    src: srcMap[item.localPath]!,
    alt: item.filename,
    onSave: () => {
      void window.electronAPI.saveGeneratedImageAs(stableRequest, item.localPath, item.filename)
    },
  }))
  const lightboxIndex = Math.max(
    viewableItems.findIndex((item) => item.localPath === selectedPath),
    0,
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[520px] flex-col gap-0 p-0 sm:max-w-[520px]" aria-describedby={undefined}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 px-4">
          <ImageIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">生成图片</span>
          {!loading && <span className="text-xs text-muted-foreground">（{items.length} 张）</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-1.5 text-muted-foreground">
              <ImageIcon className="size-6 opacity-40" />
              <p className="text-sm">暂无生成图片</p>
              <p className="text-xs opacity-70">使用生图工具后，图片会集中展示在这里</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {items.map((item) => (
                <GalleryThumbnail
                  key={item.localPath}
                  item={item}
                  src={srcMap[item.localPath]}
                  onOpen={() => {
                    setSelectedPath(item.localPath)
                    setLightboxOpen(true)
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <ImageLightbox
          open={lightboxOpen && lightboxImages.length > 0}
          onOpenChange={setLightboxOpen}
          images={lightboxImages}
          index={lightboxIndex}
          onIndexChange={(nextIndex) => {
            setSelectedPath(viewableItems[nextIndex]?.localPath ?? null)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
