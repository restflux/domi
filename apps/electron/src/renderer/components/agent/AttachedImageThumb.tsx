import * as React from 'react'
import { Download } from 'lucide-react'
import type { AttachedFileRef } from '@/lib/message-attachments'

/** 图片附件缩略图，点击可预览大图 */
export function AttachedImageThumb({ file, index, onOpen, onLoaded }: {
  file: AttachedFileRef
  /** 该图在同批图片中的索引 */
  index: number
  /** 点击缩略图打开大图预览（第 index 张） */
  onOpen: (index: number) => void
  /** 图片 src 加载完成上报父组件（供共享 lightbox 翻页使用） */
  onLoaded: (path: string, src: string) => void
}): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false
    setImageSrc(null)
    const ext = file.filename.split('.').pop()?.toLowerCase() ?? 'png'
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    }
    const mediaType = mimeMap[ext] ?? 'image/png'

    window.electronAPI
      .readAttachment(file.path)
      .then((base64) => {
        if (disposed) return
        const src = `data:${mediaType};base64,${base64}`
        setImageSrc(src)
        onLoaded(file.path, src)
      })
      .catch((err) => console.error('[AttachedImageThumb] 读取附件失败:', err))
    return () => { disposed = true }
  }, [file.path, file.filename, onLoaded])

  const handleSave = React.useCallback((): void => {
    window.electronAPI.saveImageAs(file.path, file.filename)
  }, [file.path, file.filename])

  if (!imageSrc) {
    return <div className="w-[200px] h-[140px] rounded-lg bg-muted/30 animate-pulse shrink-0" />
  }

  return (
    <div className="relative group inline-block">
      <img
        src={imageSrc}
        alt={file.filename}
        className="max-w-[min(300px,100%)] max-h-[200px] rounded-lg object-contain cursor-pointer"
        onClick={() => onOpen(index)}
      />
      <button
        type="button"
        onClick={handleSave}
        className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
        title="保存图片"
      >
        <Download className="size-4" />
      </button>
    </div>
  )
}
