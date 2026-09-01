/**
 * 审批/问答横幅输入框的粘贴图片附件工具。
 *
 * 主输入框（rich-text-input）与消息编辑框都支持粘贴图片，但 AskUser / ExitPlanMode
 * 横幅的回答通道是纯文本答案；这里把粘贴的图片转成 base64 附件随响应提交，
 * 由主进程落盘后把绝对路径注入答案文本，Agent 通过 Read 即可查看图片。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { fileToBase64 } from '@/lib/file-utils'

/** 单张粘贴图片附件（渲染进程侧） */
export interface InputImageAttachment {
  id: string
  filename: string
  mimeType: string
  dataBase64: string
  previewUrl: string
}

/** 单次最多附带几张图片 */
const MAX_PASTE_IMAGES = 4
/** 单张图片大小上限（base64 会随 IPC 传输，控制在 15MB 原始数据以内） */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

/** 从粘贴/拖放事件中提取图片文件 */
export function extractImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files ?? []).filter((file) => file.type.startsWith('image/'))
}

/** 把图片文件转换为附件列表；超出数量/大小上限的部分提示并跳过 */
export async function createAttachmentsFromFiles(files: File[]): Promise<InputImageAttachment[]> {
  if (files.length === 0) return []

  const accepted: File[] = []
  for (const file of files) {
    if (accepted.length >= MAX_PASTE_IMAGES) {
      toast.warning(`一次最多附带 ${MAX_PASTE_IMAGES} 张图片，多余的已跳过`)
      break
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.warning(`图片 ${file.name} 超过 15MB，已跳过`)
      continue
    }
    accepted.push(file)
  }

  const attachments: InputImageAttachment[] = []
  for (const file of accepted) {
    try {
      const dataBase64 = await fileToBase64(file)
      attachments.push({
        id: `attach-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: file.name || 'pasted-image.png',
        mimeType: file.type || 'image/png',
        dataBase64,
        previewUrl: URL.createObjectURL(file),
      })
    } catch (error) {
      console.error('[banner-attachments] 图片转 base64 失败:', error)
      toast.error(`图片 ${file.name} 处理失败`)
    }
  }
  return attachments
}

/** 已附图片缩略图行：预览 + 文件名 + 删除按钮 */
export function AttachmentChipRow({
  attachments,
  onRemove,
}: {
  attachments: readonly InputImageAttachment[]
  onRemove: (id: string) => void
}): React.ReactElement | null {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((att) => (
        <span
          key={att.id}
          className="group inline-flex items-center gap-1.5 pl-1 pr-1 py-0.5 rounded-md bg-muted/60 border border-border/60 text-[11px] text-muted-foreground"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <img
            src={att.previewUrl}
            alt={att.filename}
            className="size-5 rounded-sm object-cover pointer-events-none"
          />
          <span className="max-w-28 truncate">{att.filename}</span>
          <button
            type="button"
            className="size-4 flex items-center justify-center rounded-full text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(att.id)
            }}
            title="移除图片"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}
