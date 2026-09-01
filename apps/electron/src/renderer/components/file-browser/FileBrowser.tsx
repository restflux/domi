/**
 * FileBrowser — 通用文件浏览器面板
 *
 * 显示指定根路径下的文件树，支持：
 * - 文件夹懒加载展开（Chevron 旋转动画）
 * - 单击选中、Cmd/Ctrl+Click 多选
 * - 悬浮/选中后显示三点菜单（添加到聊天 / 在文件夹中显示 / 重命名 / 移动 / 删除）
 * - 文件/文件夹删除（带确认对话框）
 * - 原位重命名（含同名检查）
 * - 自动刷新
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import {
  ChevronRight,
  Trash2,
  RefreshCw,
  ExternalLink,
  FolderSearch,
  Terminal,
  MoreHorizontal,
  FolderInput,
  Pencil,
  MessageSquarePlus,
  Copy,
  Files,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { workspaceFilesVersionAtom, fileBrowserAutoRevealAtom, recentlyModifiedPathsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import type { FileAccessOptions, FileEntry } from '@domi/shared'
import { FileTypeIcon } from './FileTypeIcon'
import { DefaultAppMenuItem } from './DefaultAppMenuItem'
import {
  computeTreeRowLayout,
  AncestorGuides,
  STICKY_ROW_BASE_CLASS,
  canBeSticky,
} from './tree-row-layout'
import { setFilePanelDragData, dispatchInsertFileMention } from '@/lib/file-panel-drag'
import { createSessionTargetFileRequest } from '@/lib/session-target-file-routing.ts'
import { createFileBrowserRootSignature } from './file-browser-refresh'

/** 计算目标路径相对 rootPath 的祖先目录集合（不含 rootPath 自身、含目标的所有上级） */
export function computeRevealAncestors(rootPath: string, targetPath: string): Set<string> {
  const ancestors = new Set<string>()
  if (!rootPath || !targetPath) return ancestors
  // 归一化：移除尾部分隔符
  const root = rootPath.replace(/[/\\]+$/, '')
  if (targetPath === root) return ancestors
  const sep = targetPath.includes('\\') ? '\\' : '/'
  const relative = root === '.'
    ? targetPath
    : targetPath.startsWith(root + sep)
      ? targetPath.slice(root.length + sep.length)
      : ''
  if (!relative) return ancestors
  const parts = relative.split(/[/\\]/).filter(Boolean)
  // 文件本身不算祖先，只到父目录
  let current = root === '.' ? '' : root
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? current + sep + parts[i] : parts[i]!
    ancestors.add(current)
  }
  return ancestors
}

/** 判断目标路径是否落在 rootPath 内 */
export function isPathUnderRoot(rootPath: string, targetPath: string): boolean {
  if (!rootPath || !targetPath) return false
  const root = rootPath.replace(/[/\\]+$/, '')
  if (targetPath === root) return true
  if (root === '.') {
    return !targetPath.startsWith('/')
      && !targetPath.startsWith('\\\\')
      && !/^[A-Za-z]:[\\/]/.test(targetPath)
      && !targetPath.split(/[/\\]+/).includes('..')
  }
  return targetPath.startsWith(root + '/') || targetPath.startsWith(root + '\\')
}

export type FileScope = 'project' | 'session'

/** 把主进程 IPC 原始错误翻译为可读文案，避免内部术语直接暴露给用户。 */
export function toFriendlyFileError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  if (!raw) return '加载失败'
  // 剥掉 Electron IPC 包装前缀（"Error invoking remote method 'agent:list-directory': SessionCheckoutError: ..."）
  const bare = raw
    .replace(/^Error invoking remote method [^:]*:\s*(?:[A-Za-z_$][\w$]*Error:\s*)?/, '')
    .trim()
  if (!bare) return '加载失败'
  if (bare.includes('需要恢复后才能租用')) return '工作环境需要恢复后才能访问文件，请先在状态卡中完成恢复'
  if (bare.includes('目录不存在或超出授权范围')) return '目录不存在或超出授权范围'
  if (bare.includes('超出当前会话的授权范围')) return '路径超出当前会话授权范围'
  if (bare.includes('缺少 Session 上下文')) return '会话文件暂不可用'
  return bare
}

export interface FileBrowserRoot {
  path: string
  scope: FileScope
}

interface ScopedFileEntry extends FileEntry {
  scope: FileScope
  rootPath: string
}

interface FileBrowserProps {
  /** 单根兼容入口。新代码应优先使用 roots。 */
  rootPath?: string
  /** 同一项目会话中可见的所有物理根，会合并为一个连续文件树。 */
  roots?: FileBrowserRoot[]
  /** 隐藏内置顶部工具栏（面包屑 + 按钮），由外部自行渲染 */
  hideToolbar?: boolean
  /** 嵌入模式：不使用内部 ScrollArea 和 h-full，由外部容器控制布局和滚动 */
  embedded?: boolean
  /** 隐藏"目录为空"提示（当外部已有附加目录等内容时使用） */
  hideEmpty?: boolean
  /** Agent 文件树必须携带 Session 上下文，main 据此解析精确 lease。 */
  access: FileAccessOptions & { sessionId: string }
  /** Active Pi 文件树仅提交相对路径。 */
  usesSessionTarget?: boolean
  /** 当前项目共享文件根；存在时，会话文件可移入此目录。 */
  projectRootPath?: string | null
  /** 混合来源时用 badge 标记会话文件。 */
  showSessionBadge?: boolean
  /** 仅允许浏览/预览，不允许引用、拖拽或修改（用于尚未绑定 target 的 Local 基线）。 */
  browseOnly?: boolean
  /** 点击添加到聊天（在文件操作菜单中显示） */
  onAddToChat?: (entry: FileEntry) => void
  /** 单击文件时在内联预览面板中显示（替代外部窗口预览） */
  onFilePreview?: (filePath: string) => void
}

function sortEntries(entries: ScopedFileEntry[]): ScopedFileEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function FileBrowser({ rootPath, roots, hideToolbar, embedded, hideEmpty, access, usesSessionTarget = false, projectRootPath, showSessionBadge = true, browseOnly = false, onAddToChat, onFilePreview }: FileBrowserProps): React.ReactElement {
  const browserRoots = React.useMemo<FileBrowserRoot[]>(() => {
    if (roots && roots.length > 0) return roots.filter((root) => Boolean(root.path))
    return rootPath ? [{ path: rootPath, scope: 'project' }] : []
  }, [rootPath, roots])
  const browserRootsSignature = React.useMemo(
    () => createFileBrowserRootSignature(browserRoots),
    [browserRoots],
  )
  const [entries, setEntries] = React.useState<ScopedFileEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // 来源切换或连续刷新时，只允许最后一次目录请求更新文件树。
  const loadRequestIdRef = React.useRef(0)
  // 文件变化刷新时保留已有树，只有实际根目录切换才清空，避免上传区反复顶上来造成闪烁。
  const displayedRootsSignatureRef = React.useRef(browserRootsSignature)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)

  // ===== Agent 写入文件时的自动定位 =====
  const autoReveal = useAtomValue(fileBrowserAutoRevealAtom)
  const revealRoot = React.useMemo(() => {
    if (!autoReveal) return null
    return browserRoots
      .filter((root) => isPathUnderRoot(root.path, autoReveal.path))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  }, [autoReveal, browserRoots])
  const revealForThisRoot = revealRoot ? autoReveal : null
  const revealAncestors = React.useMemo(
    () => revealForThisRoot && revealRoot ? computeRevealAncestors(revealRoot.path, revealForThisRoot.path) : new Set<string>(),
    [revealForThisRoot, revealRoot],
  )
  const revealTarget = revealForThisRoot?.path ?? null
  const revealTs = revealForThisRoot?.ts ?? 0

  // ===== autoReveal 带 select 标记时，将目标文件加入选中态 =====
  const consumedSelectTsRef = React.useRef(0)
  React.useEffect(() => {
    if (!revealForThisRoot?.select || !revealTarget) return
    // 避免同一个 ts 被重复消费
    if (revealTs <= consumedSelectTsRef.current) return
    consumedSelectTsRef.current = revealTs
    setSelectedPaths(new Set([revealTarget]))
  }, [revealTs, revealForThisRoot?.select, revealTarget])

  // ===== 最近修改的文件路径（60s 内显示左侧竖条） =====
  const recentlyModifiedMap = useAtomValue(recentlyModifiedPathsAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const recentlyModifiedSet = React.useMemo<Set<string>>(() => {
    if (!currentSessionId) return new Set()
    const inner = recentlyModifiedMap.get(currentSessionId)
    if (!inner) return new Set()
    // 仅保留落在当前合并根之一的路径
    const set = new Set<string>()
    for (const p of inner.keys()) {
      if (browserRoots.some((root) => isPathUnderRoot(root.path, p))) set.add(p)
    }
    return set
  }, [recentlyModifiedMap, currentSessionId, browserRoots])

  // 选中状态
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set())
  // 删除确认状态
  const [deleteTarget, setDeleteTarget] = React.useState<FileEntry | null>(null)
  const [deleteCount, setDeleteCount] = React.useState(1)
  // 重命名状态
  const [renamingPath, setRenamingPath] = React.useState<string | null>(null)
  // 移动中状态
  const [moving, setMoving] = React.useState(false)

  const selectedCount = selectedPaths.size

  const listDirectory = React.useCallback(async (path: string): Promise<FileEntry[]> => {
    if (!usesSessionTarget) return window.electronAPI.listDirectory(path, access)
    const request = createSessionTargetFileRequest(access.sessionId, path)
    return request ? window.electronAPI.listSessionTargetDirectory(request) : []
  }, [access, usesSessionTarget])

  /** 加载并合并所有可见根目录。 */
  const loadRoot = React.useCallback(async () => {
    const requestId = ++loadRequestIdRef.current
    const rootsChanged = displayedRootsSignatureRef.current !== browserRootsSignature
    displayedRootsSignatureRef.current = browserRootsSignature
    if (browserRoots.length === 0) {
      setEntries([])
      setLoading(false)
      return
    }
    // 切换来源后不能继续展示上一来源；同一根的 watcher 刷新则保留文件树直到新结果返回。
    if (rootsChanged) setEntries([])
    setLoading(true)
    setError(null)
    try {
      const groups = await Promise.all(browserRoots.map(async (root) => {
        const items = await listDirectory(root.path)
        return items.map((entry): ScopedFileEntry => ({ ...entry, scope: root.scope, rootPath: root.path }))
      }))
      if (requestId !== loadRequestIdRef.current) return
      setEntries(sortEntries(groups.flat()))
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return
      setError(toFriendlyFileError(err))
      setEntries([])
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false)
    }
  }, [browserRoots, browserRootsSignature, listDirectory])

  React.useEffect(() => {
    loadRoot()
    return () => {
      // 使来源切换前尚未完成的请求失效，不能覆盖新来源的文件树。
      loadRequestIdRef.current += 1
    }
  }, [loadRoot, filesVersion])

  /** 选中项 */
  const handleSelect = React.useCallback((entry: FileEntry, event: React.MouseEvent) => {
    const isMulti = event.metaKey || event.ctrlKey
    if (isMulti) {
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(entry.path)) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
        }
        return next
      })
    } else {
      setSelectedPaths(new Set([entry.path]))
    }
  }, [])

  /** 点击空白区域清空选中 */
  const handleBackgroundClick = React.useCallback((e: React.MouseEvent) => {
    // 只处理直接点击容器的情况
    if (e.target === e.currentTarget) {
      setSelectedPaths(new Set())
    }
  }, [])

  /** 在文件夹中显示 */
  const handleShowInFolder = React.useCallback((entry: FileEntry) => {
    if (usesSessionTarget) {
      const request = createSessionTargetFileRequest(access.sessionId, entry.path)
      if (request) window.electronAPI.showSessionTargetInFolder(request).catch(console.error)
      return
    }
    window.electronAPI.showInFolder(entry.path, access).catch(console.error)
  }, [access, usesSessionTarget])

  /** 在当前 Work Session 的 Domi 内嵌终端中打开文件夹。 */
  const handleOpenInTerminal = React.useCallback((entry: FileEntry) => {
    window.electronAPI.terminal.create({
      ownerSessionId: access.sessionId,
      cwd: entry.path,
      title: entry.name,
      cols: 100,
      rows: 30,
    }).catch((error) => toast.error('无法打开内嵌终端', {
      description: error instanceof Error ? error.message : '终端创建失败',
    }))
  }, [access.sessionId])

  const getClipboardSelection = React.useCallback((entry: FileEntry): string[] => {
    return selectedPaths.has(entry.path) && selectedPaths.size > 1
      ? Array.from(selectedPaths)
      : [entry.path]
  }, [selectedPaths])

  /** 复制文件/文件夹本身，可粘贴到资源管理器、桌面等目标。 */
  const handleCopyFileSystemItem = React.useCallback(async (entry: FileEntry): Promise<void> => {
    const paths = getClipboardSelection(entry)
    try {
      await window.electronAPI.copyFileSystemItem(paths, access)
      toast.success(paths.length > 1 ? `已复制 ${paths.length} 个项目` : entry.isDirectory ? '已复制文件夹' : '已复制文件')
    } catch (error) {
      toast.error('复制文件失败', {
        description: error instanceof Error ? error.message : '无法写入系统文件剪贴板',
      })
    }
  }, [access, getClipboardSelection])

  /** 复制真实文件系统路径文本。 */
  const handleCopyFileSystemPath = React.useCallback(async (entry: FileEntry): Promise<void> => {
    const paths = getClipboardSelection(entry)
    try {
      await window.electronAPI.copyFileSystemPath(paths, access)
      toast.success(paths.length > 1 ? `已复制 ${paths.length} 个路径` : '已复制文件路径')
    } catch (error) {
      toast.error('复制路径失败', {
        description: error instanceof Error ? error.message : '无法写入剪贴板',
      })
    }
  }, [access, getClipboardSelection])

  /** 开始重命名 */
  const handleStartRename = React.useCallback((entry: FileEntry) => {
    setRenamingPath(entry.path)
  }, [])

  /** 取消重命名 */
  const handleCancelRename = React.useCallback(() => {
    setRenamingPath(null)
  }, [])

  /** 执行重命名 */
  const handleRename = React.useCallback(async (filePath: string, newName: string): Promise<string | null> => {
    // 同名检查
    const parentDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.'
    try {
      const siblings = await listDirectory(parentDir)
      const conflict = siblings.some((s) => s.name === newName && s.path !== filePath)
      if (conflict) {
        return '同名文件已存在'
      }
    } catch {
      // 无法列出目录，跳过检查
    }

    try {
      if (usesSessionTarget) {
        const request = createSessionTargetFileRequest(access.sessionId, filePath)
        if (!request) return '重命名失败'
        await window.electronAPI.renameSessionTargetFile(request, newName)
      } else {
        await window.electronAPI.renameFile(filePath, newName, access)
      }
      await loadRoot()
      setRenamingPath(null)
      setSelectedPaths(new Set())
      return null
    } catch (err) {
      return err instanceof Error ? err.message : '重命名失败'
    }
  }, [loadRoot, access, listDirectory, usesSessionTarget])

  /** 触发删除（支持多选） */
  const handleRequestDelete = React.useCallback((entry: FileEntry) => {
    setDeleteTarget(entry)
    setDeleteCount(selectedCount > 1 ? selectedCount : 1)
  }, [selectedCount])

  /** 执行删除 */
  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    try {
      if (selectedPaths.size > 1) {
        // 批量删除
        for (const path of selectedPaths) {
          if (usesSessionTarget) {
            const request = createSessionTargetFileRequest(access.sessionId, path)
            if (request) await window.electronAPI.deleteSessionTargetFile(request)
          } else {
            await window.electronAPI.deleteFile(path, access)
          }
        }
      } else {
        if (usesSessionTarget) {
          const request = createSessionTargetFileRequest(access.sessionId, deleteTarget.path)
          if (request) await window.electronAPI.deleteSessionTargetFile(request)
        } else {
          await window.electronAPI.deleteFile(deleteTarget.path, access)
        }
      }
      setSelectedPaths(new Set())
      await loadRoot()
    } catch (err) {
      console.error('[FileBrowser] 删除失败:', err)
    }
    setDeleteTarget(null)
  }, [deleteTarget, selectedPaths, loadRoot, access, usesSessionTarget])

  /** 移动文件 */
  const handleMove = React.useCallback(async (entry: FileEntry) => {
    setMoving(true)
    try {
      const result = await window.electronAPI.openFolderDialog()
      if (!result) return

      if (selectedPaths.size > 1) {
        for (const path of selectedPaths) {
          await window.electronAPI.moveFile(path, result.path, access)
        }
      } else {
        await window.electronAPI.moveFile(entry.path, result.path, access)
      }
      setSelectedPaths(new Set())
      await loadRoot()
    } catch (err) {
      console.error('[FileBrowser] 移动失败:', err)
    } finally {
      setMoving(false)
    }
  }, [selectedPaths, loadRoot, access])

  /** 将当前会话私有文件移入共享项目根。 */
  const handlePromoteToProject = React.useCallback(async (entry: ScopedFileEntry) => {
    if (!projectRootPath || entry.scope !== 'session') return
    setMoving(true)
    try {
      await window.electronAPI.moveFile(entry.path, projectRootPath, access)
      setSelectedPaths(new Set())
      await loadRoot()
    } catch (err) {
      console.error('[FileBrowser] 移入项目失败:', err)
      toast.error('移入项目失败', {
        description: err instanceof Error ? err.message : '无法移动文件',
      })
    } finally {
      setMoving(false)
    }
  }, [projectRootPath, loadRoot, access])

  // 显示首个根路径最后两段作为面包屑（嵌入模式由 SidePanel 自己提供文件 Tab 语义）。
  const breadcrumb = React.useMemo(() => {
    const primaryRoot = browserRoots[0]?.path ?? ''
    const parts = primaryRoot.split('/').filter(Boolean)
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : primaryRoot
  }, [browserRoots])

  const fileTree = (
    <div className={cn('file-tree-guide-scope', embedded ? 'py-0' : 'py-1')} onClick={handleBackgroundClick}>
      {error && (
        <div className="mx-2 my-2 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={(event) => {
              event.stopPropagation()
              void loadRoot()
            }}
          >
            <RefreshCw className="mr-1 size-3" />
            重试
          </Button>
        </div>
      )}
      {!error && entries.length === 0 && loading && (
        /* 树形骨架：目录行 + 缩进文件行，模拟真实行高与层级 */
        <div className="flex flex-col gap-2.5 px-3 py-3">
          <Skeleton className="ml-0.5 h-3.5 w-[62%]" />
          <Skeleton className="ml-5 h-3.5 w-[45%]" />
          <Skeleton className="ml-5 h-3.5 w-[55%]" />
          <Skeleton className="ml-0.5 h-3.5 w-[38%]" />
          <Skeleton className="ml-5 h-3.5 w-[50%]" />
        </div>
      )}
      {!error && entries.length === 0 && !loading && !hideEmpty && (
        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
          目录为空
        </div>
      )}
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.path}
          entry={entry}
          access={access}
          listDirectory={listDirectory}
          depth={0}
          selectedPaths={selectedPaths}
          selectedCount={selectedCount}
          renamingPath={renamingPath}
          moving={moving}
          refreshVersion={filesVersion}
          revealAncestors={revealAncestors}
          revealTarget={revealTarget}
          revealTs={revealTs}
          recentlyModifiedSet={recentlyModifiedSet}
          onSelect={handleSelect}
          onShowInFolder={handleShowInFolder}
          onOpenInTerminal={handleOpenInTerminal}
          onCopyFileSystemItem={handleCopyFileSystemItem}
          onCopyFileSystemPath={handleCopyFileSystemPath}
          onStartRename={handleStartRename}
          onCancelRename={handleCancelRename}
          onRename={handleRename}
          onDelete={handleRequestDelete}
          onMove={usesSessionTarget ? undefined : handleMove}
          onPromoteToProject={!browseOnly && !usesSessionTarget && projectRootPath ? handlePromoteToProject : undefined}
          showSessionBadge={showSessionBadge}
          browseOnly={browseOnly}
          onRefresh={loadRoot}
          onClearSelection={() => setSelectedPaths(new Set())}
          onAddToChat={onAddToChat}
          onFilePreview={onFilePreview}
        />
      ))}
    </div>
  )

  return (
    <div className={cn('flex flex-col', !embedded && 'h-full')}>
      {/* 顶部工具栏（可由外部接管） */}
      {!hideToolbar && (
        <div className="flex items-center gap-1 px-3 pr-10 h-[48px] border-b flex-shrink-0">
          <span className="text-xs text-muted-foreground truncate flex-1" title={browserRoots[0]?.path}>
            {breadcrumb}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={() => {
              const path = browserRoots[0]?.path
              if (!path) return
              if (usesSessionTarget) {
                const request = createSessionTargetFileRequest(access.sessionId, path)
                if (request) window.electronAPI.openSessionTargetFile(request).catch(console.error)
              } else {
                window.electronAPI.openFile(path, access).catch(console.error)
              }
            }}
            title="在 Finder 中打开"
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={loadRoot}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      )}

      {/* 文件树 */}
      {embedded ? fileTree : (
        <ScrollArea className="flex-1">
          {fileTree}
        </ScrollArea>
      )}

      {/* 删除确认对话框 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCount > 1 ? (
                <>确定要删除选中的 <strong>{deleteCount}</strong> 个项目吗？</>
              ) : (
                <>
                  确定要删除 <strong>{deleteTarget?.name}</strong> 吗？
                  {deleteTarget?.isDirectory && '（包含所有子文件）'}
                </>
              )}
              此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ===== FileTreeItem 子组件 =====

interface FileTreeItemProps {
  entry: ScopedFileEntry
  access: FileAccessOptions & { sessionId: string }
  listDirectory: (path: string) => Promise<FileEntry[]>
  depth: number
  selectedPaths: Set<string>
  selectedCount: number
  renamingPath: string | null
  moving: boolean
  /** 文件版本号，变化时已展开的文件夹自动重新加载子项 */
  refreshVersion: number
  /** 自动定位：祖先目录路径集合（命中则自动展开） */
  revealAncestors: Set<string>
  /** 自动定位：目标文件路径 */
  revealTarget: string | null
  /** 自动定位时间戳，变化时重新触发 */
  revealTs: number
  recentlyModifiedSet: Set<string>
  onSelect: (entry: FileEntry, event: React.MouseEvent) => void
  onShowInFolder: (entry: FileEntry) => void
  onOpenInTerminal: (entry: FileEntry) => void
  onCopyFileSystemItem: (entry: FileEntry) => Promise<void>
  onCopyFileSystemPath: (entry: FileEntry) => Promise<void>
  onStartRename: (entry: FileEntry) => void
  onCancelRename: () => void
  onRename: (filePath: string, newName: string) => Promise<string | null>
  onDelete: (entry: FileEntry) => void
  onMove?: (entry: FileEntry) => void
  onPromoteToProject?: (entry: ScopedFileEntry) => void
  showSessionBadge: boolean
  browseOnly: boolean
  onRefresh: () => Promise<void>
  onClearSelection: () => void
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
}

function FileTreeItem({
  entry,
  access,
  listDirectory,
  depth,
  selectedPaths,
  selectedCount,
  renamingPath,
  moving,
  refreshVersion,
  revealAncestors,
  revealTarget,
  revealTs,
  recentlyModifiedSet,
  onSelect,
  onShowInFolder,
  onOpenInTerminal,
  onCopyFileSystemItem,
  onCopyFileSystemPath,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
  onMove,
  onPromoteToProject,
  showSessionBadge,
  browseOnly,
  onRefresh,
  onClearSelection,
  onAddToChat,
  onFilePreview,
}: FileTreeItemProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [children, setChildren] = React.useState<ScopedFileEntry[]>([])
  const [childrenLoaded, setChildrenLoaded] = React.useState(false)
  const rowRef = React.useRef<HTMLDivElement>(null)

  // 当 refreshVersion 变化时，已展开的文件夹自动重新加载子项
  React.useEffect(() => {
    if (expanded && childrenLoaded && entry.isDirectory) {
      listDirectory(entry.path)
        .then((items) => setChildren(items.map((child) => ({ ...child, scope: entry.scope, rootPath: entry.rootPath }))))
        .catch((err) => console.error('[FileTreeItem] 刷新子目录失败:', err))
    }
  }, [refreshVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 文件搜索 reveal：祖先目录自动展开 + 目标行滚动到中心 =====
  React.useEffect(() => {
    if (revealTs === 0) return

    const cleanups: Array<() => void> = []
    const isAncestor = revealAncestors.has(entry.path)
    const isTarget = revealTarget !== null && entry.path === revealTarget

    const scrollToTarget = (): void => {
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }

    // 自身需要展开：祖先目录 OR 目标本身就是目录（搜到文件夹时让其展开露出内容）
    const willExpand = entry.isDirectory && (isAncestor || isTarget) && !expanded
    if (willExpand) {
      let cancelled = false
      const run = async (): Promise<void> => {
        if (!childrenLoaded) {
          try {
            const items = await listDirectory(entry.path)
            if (!cancelled) {
              setChildren(items.map((child) => ({ ...child, scope: entry.scope, rootPath: entry.rootPath })))
              setChildrenLoaded(true)
            }
          } catch (err) {
            console.error('[FileTreeItem] reveal 加载子目录失败:', err)
            return
          }
        }
        if (cancelled) return
        setExpanded(true)
        // 目标自身就是这个目录时，等展开后再滚动，避免子项渲染改变行高使
        // smooth scroll 的目标位置过时；加载失败路径不会到这里。
        if (isTarget) scrollToTarget()
      }
      void run()
      cleanups.push(() => { cancelled = true })
    }

    // 目标行：滚动到可视区中心
    if (isTarget) {
      // 仅在不会通过展开分支异步滚动时立即滚动（即：目标是文件，或已展开的目录）
      if (!willExpand) scrollToTarget()
    }

    if (cleanups.length > 0) return () => { for (const c of cleanups) c() }
  }, [revealTs]) // eslint-disable-line react-hooks/exhaustive-deps

  // 重命名编辑状态
  const [editName, setEditName] = React.useState('')
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const renameInputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)

  const isSelected = selectedPaths.has(entry.path)
  const isRenaming = renamingPath === entry.path

  /** 展开/收起文件夹 */
  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return

    if (!expanded && !childrenLoaded) {
      try {
        const items = await listDirectory(entry.path)
        setChildren(items.map((child) => ({ ...child, scope: entry.scope, rootPath: entry.rootPath })))
        setChildrenLoaded(true)

        // 首次展开空目录时，延迟重试一次（应对 Agent 正在写入文件的时序问题）
        if (items.length === 0) {
          setTimeout(async () => {
            try {
              const retryItems = await listDirectory(entry.path)
              if (retryItems.length > 0) setChildren(retryItems.map((child) => ({ ...child, scope: entry.scope, rootPath: entry.rootPath })))
            } catch { /* 静默忽略 */ }
          }, 800)
        }
      } catch (err) {
        console.error('[FileTreeItem] 加载子目录失败:', err)
      }
    }

    setExpanded(!expanded)
  }

  /** 点击行为：选中 + 文件夹展开/收起 / 文件预览 */
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const isMulti = e.metaKey || e.ctrlKey
    onSelect(entry, e)
    if (isMulti) return
    if (entry.isDirectory) {
      void toggleDir()
    } else {
      onFilePreview?.(entry.path)
    }
  }

  /** 拖拽到 Agent 输入框：写入面板文件引用载荷 */
  const handleRowDragStart = React.useCallback((e: React.DragEvent): void => {
    e.stopPropagation()
    setFilePanelDragData(e.dataTransfer, [{
      path: entry.path,
      name: entry.name,
      isDirectory: entry.isDirectory,
      scope: entry.scope,
    }])
  }, [entry.path, entry.name, entry.isDirectory, entry.scope])

  /** 删除后刷新子目录 */
  const handleRefreshAfterDelete = async (): Promise<void> => {
    if (childrenLoaded) {
      try {
        const items = await listDirectory(entry.path)
        setChildren(items.map((child) => ({ ...child, scope: entry.scope, rootPath: entry.rootPath })))
      } catch {
        await onRefresh()
      }
    }
  }

  // 进入重命名编辑模式
  React.useEffect(() => {
    if (isRenaming) {
      setEditName(entry.name)
      setRenameError(null)
      justStartedEditing.current = true
      const timer = setTimeout(() => {
        justStartedEditing.current = false
        const input = renameInputRef.current
        if (input) {
          input.focus()
          // 只选中文件名部分，不包括后缀
          const lastDotIndex = entry.name.lastIndexOf('.')
          if (lastDotIndex > 0 && !entry.isDirectory) {
            input.setSelectionRange(0, lastDotIndex)
          } else {
            input.select()
          }
        }
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [isRenaming, entry.name, entry.isDirectory])

  /** 保存重命名 */
  const saveRename = async (): Promise<void> => {
    if (justStartedEditing.current) return

    const trimmed = editName.trim()
    if (!trimmed || trimmed === entry.name) {
      onCancelRename()
      return
    }
    const error = await onRename(entry.path, trimmed)
    if (error) {
      setRenameError(error)
    }
  }

  /** 重命名键盘事件 */
  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancelRename()
    }
  }

  /** 重命名失焦 */
  const handleBlur = (): void => {
    if (renameError) {
      onCancelRename()
      setRenameError(null)
    } else {
      void saveRename()
    }
  }

  // 行使用 mx-2 形成左右各 8px 留白，留白处的点击 target 是本 wrapper 而非父级
  // py-1 容器，所以父级 handleBackgroundClick 的 target===currentTarget 判定不会命中。
  // 这里就近处理留白点击的清选语义，保持视觉上"点空白即清选"的一致体验。
  const handleWrapperClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClearSelection()
    }
  }

  const { paddingLeft, guideLeft, stickyTop, stickyZIndex } = computeTreeRowLayout(depth)
  const isSticky = entry.isDirectory && expanded && canBeSticky(depth)
  const showMenu = !isRenaming
  const menuSelectedCount = isSelected ? selectedCount : 1

  return (
    <div className="relative" onClick={handleWrapperClick}>
      <div
        ref={rowRef}
        data-sticky-row={isSticky ? 'true' : undefined}
        className={cn(
          'file-tree-row relative flex h-8 items-center gap-1 pr-2 text-sm cursor-pointer group',
          isSticky && STICKY_ROW_BASE_CLASS,
        )}
        style={{
          paddingLeft,
          top: isSticky ? stickyTop : undefined,
          zIndex: isSticky ? stickyZIndex : undefined,
        }}
        onClick={handleClick}
        draggable={!browseOnly && !isRenaming}
        onDragStart={browseOnly ? undefined : handleRowDragStart}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-2 right-2 z-0 rounded-[17px] transition-colors',
            // sticky 行 hover 用不透明色，避免下方滚动内容透出；普通行保持半透明柔和感
            isSelected
              ? 'bg-accent'
              : isSticky
                ? 'group-hover:bg-accent'
                : 'group-hover:bg-accent/50',
          )}
        />
        {/* sticky 行祖先链竖线，逻辑见 tree-row-layout.tsx 的 AncestorGuides */}
        {isSticky && <AncestorGuides depth={depth} isSelected={isSelected} />}
        {recentlyModifiedSet.has(entry.path) && (
          <span
            aria-label="最近被 Agent 修改"
            className="absolute top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary/80"
            style={{ left: paddingLeft - 6 }}
          />
        )}
        {/* 展开/收起图标 */}
        {entry.isDirectory ? (
          <ChevronRight
            className={cn(
              'relative z-10 size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="relative z-10 w-3.5 flex-shrink-0" />
        )}

        {/* 文件/文件夹图标 */}
        <FileTypeIcon
          name={entry.name}
          isDirectory={entry.isDirectory}
          isOpen={expanded}
          className="relative z-10"
        />

        {/* 文件名 / 重命名输入框 */}
        {isRenaming ? (
          <div className="relative z-10 flex-1 min-w-0">
            <input
              ref={renameInputRef}
              value={editName}
              onChange={(e) => { setEditName(e.target.value); setRenameError(null) }}
              onKeyDown={handleRenameKeyDown}
              onBlur={handleBlur}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'w-full bg-transparent text-xs border-b outline-none py-0.5',
                renameError ? 'border-destructive' : 'border-primary/50',
              )}
              maxLength={255}
            />
            {renameError && (
              <div className="absolute left-0 top-full mt-0.5 text-[10px] leading-4 text-destructive whitespace-nowrap pointer-events-none">
                {renameError}
              </div>
            )}
          </div>
        ) : (
          <>
            <span className="relative z-10 truncate text-xs flex-1">{entry.name}</span>
            {showSessionBadge && entry.scope === 'session' && (
              <span className="relative z-10 flex-shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                会话文件
              </span>
            )}
          </>
        )}

        {/* 右侧操作按钮占位（始终占位，避免行宽跳动） */}
        <div
          className="relative z-10 flex-shrink-0 mr-1"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 悬浮/选中状态：三点菜单 */}
          {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70 text-muted-foreground hover:text-foreground',
                  !isSelected && 'invisible group-hover:visible focus-visible:visible data-[state=open]:visible',
                )}
                title="更多操作"
                aria-label="更多操作"
                onClick={(e) => {
                  if (!isSelected) onSelect(entry, e)
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                {!browseOnly && menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => dispatchInsertFileMention([{
                      path: entry.path,
                      name: entry.name,
                      isDirectory: entry.isDirectory,
                      scope: entry.scope,
                    }])}
                  >
                    <MessageSquarePlus />
                    引用到 Agent
                  </DropdownMenuItem>
                )}
                {!browseOnly && onAddToChat && !entry.isDirectory && menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onAddToChat(entry)}
                  >
                    <MessageSquarePlus />
                    添加到聊天
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={() => { void onCopyFileSystemItem(entry) }}
                >
                  <Files />
                  {menuSelectedCount > 1
                    ? `复制选中项 (${menuSelectedCount})`
                    : entry.isDirectory ? '复制文件夹' : '复制文件'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={() => { void onCopyFileSystemPath(entry) }}
                >
                  <Copy />
                  {menuSelectedCount > 1 ? `复制选中路径 (${menuSelectedCount})` : '复制路径'}
                </DropdownMenuItem>
                {menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onShowInFolder(entry)}
                  >
                    <FolderSearch />
                    在文件夹中显示
                  </DropdownMenuItem>
                )}
                {menuSelectedCount === 1 && entry.isDirectory && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onOpenInTerminal(entry)}
                  >
                    <Terminal />
                    在 Domi 终端打开
                  </DropdownMenuItem>
                )}
                {menuSelectedCount === 1 && !entry.isDirectory && (
                  <DefaultAppMenuItem
                    filePath={entry.path}
                    access={access}
                    className="text-xs py-1 [&>svg]:size-3.5"
                  />
                )}
                {onPromoteToProject && entry.scope === 'session' && menuSelectedCount === 1 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        className="text-xs py-1 [&>svg]:size-3.5"
                        disabled={moving}
                        onSelect={() => { void onPromoteToProject(entry) }}
                      >
                        <FolderInput />
                        移入项目
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>移动到项目根目录，其他会话也可访问</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                {!browseOnly && onMove && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    disabled={moving}
                    onSelect={() => { void onMove(entry) }}
                  >
                    <FolderInput />
                    {menuSelectedCount > 1 ? `移动选中 (${menuSelectedCount})` : '移动到...'}
                  </DropdownMenuItem>
                )}
                {!browseOnly && menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onStartRename(entry)}
                  >
                    <Pencil />
                    重命名
                  </DropdownMenuItem>
                )}
                {!browseOnly && <DropdownMenuSeparator className="my-0.5" />}
                {!browseOnly && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5 text-destructive"
                    onSelect={() => onDelete(entry)}
                  >
                    <Trash2 />
                    {menuSelectedCount > 1 ? `删除选中 (${menuSelectedCount})` : '删除'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      </div>

      {/* 子项 */}
      {expanded && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="file-tree-guide pointer-events-none absolute bottom-1 top-0 w-px bg-border/70"
            style={{ left: guideLeft }}
          />
          {children.length === 0 && childrenLoaded && (
            <div
              className="text-[11px] text-muted-foreground/50 py-1"
              style={{ paddingLeft: paddingLeft + 24 }}
            >
              空文件夹
            </div>
          )}
          {children.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              access={access}
              listDirectory={listDirectory}
              depth={depth + 1}
              selectedPaths={selectedPaths}
              selectedCount={selectedCount}
              renamingPath={renamingPath}
              moving={moving}
              refreshVersion={refreshVersion}
              revealAncestors={revealAncestors}
              revealTarget={revealTarget}
              revealTs={revealTs}
              recentlyModifiedSet={recentlyModifiedSet}
              onSelect={onSelect}
              onShowInFolder={onShowInFolder}
              onOpenInTerminal={onOpenInTerminal}
              onCopyFileSystemItem={onCopyFileSystemItem}
              onCopyFileSystemPath={onCopyFileSystemPath}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onPromoteToProject={onPromoteToProject}
              showSessionBadge={showSessionBadge}
              browseOnly={browseOnly}
              onRefresh={handleRefreshAfterDelete}
              onClearSelection={onClearSelection}
              onAddToChat={onAddToChat}
              onFilePreview={onFilePreview}
            />
          ))}
        </div>
      )}
    </div>
  )
}
