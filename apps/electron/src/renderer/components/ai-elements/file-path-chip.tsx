/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 支持绝对路径和相对路径（相对于 basePath 解析）。
 * 点击文件时按用户偏好打开预览；点击目录时用系统文件管理器打开。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { getFilePathDisplayPath } from './file-path-display.ts'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { IMAGE_FILE_EXTENSIONS } from './file-path-kind'
import { filePathStatusCache, type FilePathStatus } from './file-path-status-cache'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'

/** 路径解析缓存 key；授权结果必须按会话隔离。 */
type DisplayFilePathStatus = FilePathStatus | 'idle'
function pathStatusCacheKey(sessionId: string | undefined, filePath: string, bases: string[]): string {
  return `${sessionId ?? ''}\0${filePath}\0${bases.join('\0')}`
}

/** 图片扩展名 */
const IMAGE_EXTS = IMAGE_FILE_EXTENSIONS
/** 视频扩展名 */
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov'])
/**
 * 代码/结构化文本扩展名
 * 需与主进程 file-preview-service.ts 的 CODE_EXTENSIONS + MARKDOWN_EXTENSIONS 保持一致，
 * 否则消息中的相对路径无法被识别为可点击 chip。
 */
const CODE_EXTS = new Set([
  'md', 'markdown',
  'json', 'jsonc', 'json5',
  'xml', 'html', 'htm',
  'txt', 'log', 'csv',
  'yaml', 'yml', 'toml', 'ini', 'env', 'lock',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish',
  'css', 'scss', 'less',
  'sql', 'rb', 'php',
  'diff', 'patch',
])
/** 文档扩展名 */
const DOC_EXTS = new Set(['pdf', 'docx'])

/** 所有可预览的扩展名集合（用于相对路径检测） */
const ALL_PREVIEWABLE_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...CODE_EXTS, ...DOC_EXTS])

/** 路径分隔符正则（同时匹配 / 和 \） */
const PATH_SEP_RE = /[\\/]/

/** 末尾路径分隔符正则（用于剥除 base 末尾的斜杠） */
const TRAILING_SEP_RE = /[\\/]+$/

/** Windows 盘符绝对路径前缀（如 C:\ D:/ e:\） */
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/

export { isImageFilePath } from './file-path-kind'

/** 从路径提取文件或目录名（同时支持 / 和 \，忽略目录末尾分隔符） */
export function getFileName(filePath: string): string {
  const normalized = filePath.replace(TRAILING_SEP_RE, '')
  const parts = normalized.split(PATH_SEP_RE)
  return parts[parts.length - 1] || normalized || filePath
}

/** 从文件名提取扩展名（小写，不含点） */
function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * 从路径中剥离末尾的行号/列号后缀（如 :42 或 :42:15）
 * Agent 模式下模型常输出 file_path:line_number 格式
 */
function stripLineCol(filePath: string): { path: string; suffix: string } {
  const m = filePath.match(/^(.+?)(:\d+(?::\d+)?)$/)
  if (m && !m[1]!.endsWith(':')) {
    return { path: m[1]!, suffix: m[2]! }
  }
  return { path: filePath, suffix: '' }
}

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径（向后兼容，单值） */
  basePath?: string
  /** 多个候选基础目录（如主 cwd + 附加目录），点击时由主进程依次解析 */
  basePaths?: string[]
  className?: string
}

/** 文件路径芯片 — 可点击，触发文件预览 */
export function FilePathChip({ filePath, basePath, basePaths, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)

  const filename = getFileName(cleanPath)

  const isAbsolute = cleanPath.startsWith('/') || WIN_DRIVE_RE.test(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const store = useStore()
  const openPreview = useOpenPreview()

  // 候选基础目录列表：优先使用 basePaths；否则退化到 basePath 单值
  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])
  const sessionId = store.get(currentAgentSessionIdAtom) ?? undefined
  const statusCacheKey = React.useMemo(
    () => pathStatusCacheKey(sessionId, cleanPath, candidateBases),
    [sessionId, cleanPath, candidateBases],
  )
  // 流式 Markdown 重新挂载时同步读取最终缓存，避免先显示正常样式、随后又变灰造成闪烁。
  const [fileStatus, setFileStatus] = React.useState<DisplayFilePathStatus>(
    () => filePathStatusCache.peek(statusCacheKey) ?? 'idle',
  )

  // Agent 会话中的相对路径默认属于 Session Target；候选工作台只用于历史回退，不能用于伪造悬浮路径。
  const displayPath = React.useMemo(
    () => getFilePathDisplayPath(trimmedPath, candidateBases, Boolean(sessionId) && !isAbsolute),
    [trimmedPath, candidateBases, sessionId, isAbsolute],
  )

  // IntersectionObserver 懒检查路径是否存在及其类型。
  // 同一路径的流式重挂载共享一条最多 3 次的检查流程；最终不存在结果会被稳定缓存。
  React.useEffect(() => {
    const el = chipRef.current
    if (!el) return

    const cachedStatus = filePathStatusCache.peek(statusCacheKey)
    setFileStatus(cachedStatus ?? 'idle')
    if (cachedStatus) return

    let active = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        const bases = candidateBases.length > 0 ? candidateBases : undefined
        void filePathStatusCache.resolve(
          statusCacheKey,
          () => window.electronAPI.resolveFilePath(cleanPath, { sessionId, candidateBasePaths: bases }),
        ).then((status) => {
          if (active) setFileStatus(status)
        })
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [cleanPath, candidateBases, sessionId, statusCacheKey])

  const handleClick = React.useCallback(async () => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    if (!sessionId) return

    const bases = candidateBases.length > 0 ? candidateBases : undefined
    const key = pathStatusCacheKey(sessionId, cleanPath, candidateBases)
    try {
      // 点击时重新校验，避免初始懒检查尚未完成、路径已移动，或跨会话缓存污染。
      const resolved = await window.electronAPI.resolveFilePath(cleanPath, {
        sessionId,
        candidateBasePaths: bases,
      })
      const status = resolved?.kind ?? 'broken'
      filePathStatusCache.set(key, status)
      setFileStatus(status)
      if (!resolved) {
        toast.error(`无法解析文件路径：${displayPath}`)
        return
      }

      if (resolved.kind === 'directory') {
        await window.electronAPI.systemOpenFile(cleanPath, undefined, {
          sessionId,
          candidateBasePaths: bases,
        })
        return
      }

      openPreview(sessionId, {
        filePath: cleanPath,
        previewOnly: true,
        basePaths: bases,
      })
    } catch {
      toast.error(`无法打开文件：${displayPath}`)
    }
  }, [store, openPreview, cleanPath, candidateBases, displayPath])

  const handleShowInFolder = React.useCallback(() => {
    if (sessionId && !isAbsolute) {
      window.electronAPI.showSessionTargetInFolder({ sessionId, relativePath: cleanPath })
        .catch(() => toast.error(`未找到路径：${filename}`))
      return
    }
    const bases = candidateBases.length > 0 ? candidateBases : undefined
    window.electronAPI.showItemInFolder(cleanPath, bases)
      .then((ok) => { if (!ok) toast.error(`未找到路径：${filename}`) })
      .catch(() => toast.error(`未找到路径：${filename}`))
  }, [sessionId, isAbsolute, cleanPath, candidateBases, filename])

  const isDirectory = fileStatus === 'directory'
    || (fileStatus === 'idle' && TRAILING_SEP_RE.test(cleanPath))

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={chipRef}
          type="button"
          onClick={handleClick}
          title={fileStatus === 'broken' ? `路径不存在: ${displayPath}` : displayPath}
          className={cn(
            'inline-flex items-center gap-[0.25em] rounded px-[0.35em] py-[0.15em] text-[0.875em] font-medium leading-none',
            'cursor-pointer transition-colors duration-150',
            'align-baseline not-prose',
            fileStatus === 'broken'
              ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground hover:opacity-70 hover:bg-muted/20'
              : 'bg-primary/10 text-primary hover:bg-primary/20',
            className
          )}
        >
          <FileTypeIcon name={filename} isDirectory={isDirectory} size={12} />
          <span className="truncate max-w-[240px] leading-none">{filename}{lineColSuffix}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48 z-[9999]">
        <ContextMenuItem onClick={handleClick}>
          {isDirectory ? '打开文件夹' : '打开预览'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleShowInFolder}>
          在文件管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 检测文本是否为绝对文件路径
 *
 * 匹配规则：
 * - macOS/Linux: 以 / 开头，至少两级路径
 * - Windows: 以 C:\ 或 C:/ 等盘符开头（大小写盘符均支持，反斜杠和正斜杠均支持）
 */
export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false

  // 剥离末尾行号后缀再检测
  const { path: clean } = stripLineCol(trimmed)

  // macOS/Linux 绝对路径：以 / 开头，至少两级
  if (clean.startsWith('/') && /^\/[^\n]+\/[^\n]+$/.test(clean)) {
    // 排除常见的非路径模式（如 /regex/ 模式）
    if (clean.endsWith('/') && !clean.includes('.')) return false
    return true
  }

  // Windows 绝对路径（支持反斜杠和正斜杠、大小写盘符）
  if (WIN_DRIVE_RE.test(clean)) return true

  return false
}

/**
 * 检测文本是否为相对文件路径（需要 basePath 才有意义）
 *
 * 匹配规则：
 * - 含有可预览的文件扩展名
 * - 看起来像文件名或相对路径（不含空格、不含特殊字符）
 * - 排除常见的非路径 inline code（如命令、变量名等）
 * - 同时支持 / 和 \ 路径分隔符
 */
export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false

  // 剥离末尾行号后缀再检测
  const { path: clean } = stripLineCol(trimmed)

  // 提取扩展名
  const ext = getExtension(clean)
  if (!ext || !ALL_PREVIEWABLE_EXTS.has(ext)) return false

  // 必须看起来像文件路径：允许 字母数字、点、横线、下划线、斜杠（含反斜杠）
  // 排除含空格或特殊字符的（太可能是其他内容）
  if (!/^[\w./@\\-]+$/.test(clean)) return false

  // 排除以点开头的隐藏文件（如 .gitignore），但保留含子路径的相对路径（如 .context/file.md）
  if (clean.startsWith('.') && !PATH_SEP_RE.test(clean)) return false

  return true
}
