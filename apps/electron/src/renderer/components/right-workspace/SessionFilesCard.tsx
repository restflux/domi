/** 会话文件浮窗：只按确定的来源区分生成内容与用户附加输入。 */
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { FileImage, Folder, Link2, Paperclip, Plus } from 'lucide-react'
import type { GeneratedImageItem, SDKMessage } from '@domi/shared'
import {
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  agentLiveMessagesAtomFamily,
  agentPendingFilesAtomFamily,
  agentSessionsAtom,
  agentWorkspacesAtom,
  workspaceFilesVersionAtom,
} from '@/atoms/agent-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { getMediaTypeFromFilename, setFilePanelDragData } from '@/lib/file-panel-drag'
import { getSessionSourceCapabilities, getSessionSourceOpenMode } from './session-source-actions'
import { SessionSourceMenu } from './SessionSourceMenu'
import { selectConfirmedSessionOutputs, selectSessionFileSources } from './session-files-popover-model'

interface SessionFilesCardProps {
  sessionId: string
  sessionPath: string | null
  onViewAll: () => void
}

const rowClass = 'group flex h-[30px] min-w-0 items-center gap-3 px-5 text-[12px] text-muted-foreground/75 hover:text-foreground'

export function SessionFilesCard({ sessionId, sessionPath, onViewAll }: SessionFilesCardProps): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceId = sessions.find((session) => session.id === sessionId)?.workspaceId
  const workspaceSlug = workspaces.find((workspace) => workspace.id === workspaceId)?.slug
  const attachedFiles = useAtomValue(agentAttachedFilesMapAtom).get(sessionId) ?? []
  const attachedDirs = useAtomValue(agentAttachedDirectoriesMapAtom).get(sessionId) ?? []
  const liveMessages = useAtomValue(agentLiveMessagesAtomFamily(sessionId))
  const setAttachedFilesMap = useSetAtom(agentAttachedFilesMapAtom)
  const setAttachedDirsMap = useSetAtom(agentAttachedDirectoriesMapAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const setFilesVersion = useSetAtom(workspaceFilesVersionAtom)
  const pendingFiles = useAtomValue(agentPendingFilesAtomFamily(sessionId))
  const setPendingFiles = useSetAtom(agentPendingFilesAtomFamily(sessionId))
  const [generatedImages, setGeneratedImages] = React.useState<GeneratedImageItem[]>([])
  const [sessionMessages, setSessionMessages] = React.useState<SDKMessage[]>([])
  const [lightbox, setLightbox] = React.useState<{ src: string; alt: string } | null>(null)
  const [hiddenPaths, setHiddenPaths] = React.useState<Set<string>>(new Set())
  const imageRequestRef = React.useRef(0)
  const openPreview = useOpenPreview()

  React.useEffect(() => {
    let disposed = false
    window.electronAPI.listGeneratedImages({ kind: 'agent', sessionId })
      .then((images) => { if (!disposed) setGeneratedImages(images) })
      .catch((error: unknown) => {
        if (!disposed) console.error('[SessionFilesCard] 读取生成图片失败:', error)
      })
    return () => { disposed = true }
  }, [sessionId, filesVersion])

  React.useEffect(() => {
    let disposed = false
    window.electronAPI.getAgentSessionSDKMessages(sessionId)
      .then((messages) => { if (!disposed) setSessionMessages(messages) })
      .catch((error: unknown) => {
        if (!disposed) console.error('[SessionFilesCard] 读取会话输入附件失败:', error)
      })
    return () => { disposed = true }
  }, [sessionId])

  const outputs = React.useMemo(() => selectConfirmedSessionOutputs(generatedImages), [generatedImages])
  const sources = React.useMemo(
    () => selectSessionFileSources([...sessionMessages, ...liveMessages], attachedFiles, attachedDirs),
    [sessionMessages, liveMessages, attachedFiles, attachedDirs],
  )

  React.useEffect(() => {
    setLightbox(null)
    setHiddenPaths(new Set())
    return () => { imageRequestRef.current += 1 }
  }, [sessionId])

  const addSourceFile = React.useCallback(async (): Promise<void> => {
    if (!workspaceSlug) {
      toast.error('等待项目初始化')
      return
    }
    try {
      const selected = await window.electronAPI.openFileDialog()
      if (selected.skippedFiles?.length) toast.warning('部分文件无法读取，已跳过')
      if (selected.files.length === 0 && !selected.largeFiles?.length) return
      const saved = selected.files.length > 0
        ? await window.electronAPI.saveFilesToAgentSession({
            workspaceSlug, sessionId,
            files: selected.files.map((file) => ({ filename: file.filename, data: file.data })),
          })
        : []
      for (const filePath of [...saved.map((file) => file.targetPath), ...(selected.largeFiles ?? []).map((file) => file.path)]) {
        const updated = await window.electronAPI.attachFile({ sessionId, filePath })
        setAttachedFilesMap((previous) => new Map(previous).set(sessionId, updated))
      }
    } catch (error) {
      console.error('[SessionFilesCard] 附加来源文件失败:', error)
      toast.error('附加文件失败')
    }
  }, [sessionId, workspaceSlug, setAttachedFilesMap])

  const addSourceFolder = React.useCallback(async (): Promise<void> => {
    try {
      const selected = await window.electronAPI.openFolderDialog()
      if (!selected) return
      const updated = await window.electronAPI.attachDirectory({ sessionId, directoryPath: selected.path })
      setAttachedDirsMap((previous) => new Map(previous).set(sessionId, updated))
    } catch (error) {
      console.error('[SessionFilesCard] 附加来源文件夹失败:', error)
      toast.error('附加文件夹失败')
    }
  }, [sessionId, setAttachedDirsMap])

  const preview = React.useCallback((source: { path: string; filename: string; isImage: boolean; isDirectory: boolean }): void => {
    const requestId = ++imageRequestRef.current
    const capabilities = getSessionSourceCapabilities(source.path, { sessionId, sessionPath, attachedFiles, attachedDirectories: attachedDirs })
    const mode = getSessionSourceOpenMode(source, capabilities)
    if (mode === 'browse') { onViewAll(); return }
    const access = capabilities.readAccess
    if (!access) { toast.error('无法打开文件预览'); return }
    if (mode === 'lightbox') {
      void window.electronAPI.resolveFilePath(source.path, access).then((resolved) => {
        if (imageRequestRef.current !== requestId) return
        if (resolved?.kind !== 'file') { toast.error('无法打开图片预览'); return }
        setLightbox({ src: resolved.url, alt: source.filename })
      }).catch((error: unknown) => {
        if (imageRequestRef.current !== requestId) return
        toast.error('无法打开图片预览', { description: error instanceof Error ? error.message : '文件不可用' })
      })
      return
    }
    openPreview(sessionId, {
      filePath: source.path,
      previewOnly: true,
      readOnly: !capabilities.canMutate,
      ...(access.pathSpace ? { pathSpace: access.pathSpace } : {}),
      basePaths: [sessionPath, ...attachedFiles, ...attachedDirs].filter((path): path is string => Boolean(path)),
    })
  }, [sessionId, sessionPath, attachedFiles, attachedDirs, onViewAll, openPreview])

  const addToChat = (source: { path: string; filename: string }): void => {
    if (pendingFiles.some((file) => file.sourcePath === source.path)) return
    setPendingFiles((previous) => [...previous, {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: source.filename,
      mediaType: getMediaTypeFromFilename(source.filename),
      size: 0,
      sourcePath: source.path,
    }])
  }

  const markChanged = (path: string): void => {
    setHiddenPaths((current) => new Set(current).add(path))
    setFilesVersion((current) => current + 1)
  }

  return (
    <>
      <ImageLightbox src={lightbox?.src} alt={lightbox?.alt} open={lightbox !== null} onOpenChange={(open) => { if (!open) setLightbox(null) }} />
      <div className="flex h-9 shrink-0 items-center justify-between pl-5 pr-4 pt-1">
        <span className="text-[12px] font-medium text-popover-foreground/80">输出内容</span>
        <button type="button" onClick={onViewAll} title="查看会话文件" aria-label="查看会话文件" className="flex size-6 items-center justify-center text-muted-foreground/55 hover:text-foreground">
          <Plus className="size-4" />
        </button>
      </div>
      {outputs.length === 0 ? (
        <p className="px-5 pb-3 text-[12px] text-muted-foreground/55">暂无可确认的输出</p>
      ) : (
        <div className="shrink-0">
          {outputs.filter((image) => !hiddenPaths.has(image.localPath)).map((image) => (
            <button
              key={image.localPath}
              type="button"
              className={`${rowClass} w-full text-left`}
              onClick={() => preview({ path: image.localPath, filename: image.filename, isImage: true, isDirectory: false })}
              title={image.filename}
            >
              <FileImage className="size-[15px] shrink-0" />
              <span className="min-w-0 truncate">{image.filename}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex h-11 shrink-0 items-end justify-between pb-1 pl-5 pr-4">
        <span className="text-[12px] font-medium text-popover-foreground/80">来源</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title="添加来源" aria-label="添加来源" className="flex size-6 items-center justify-center text-muted-foreground/55 hover:text-foreground">
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { void addSourceFile() }}>附加文件</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { void addSourceFolder() }}>附加文件夹</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 scrollbar-thin">
        {sources.filter((source) => !hiddenPaths.has(source.path)).map((source) => {
          const capabilities = getSessionSourceCapabilities(source.path, { sessionId, sessionPath, attachedFiles, attachedDirectories: attachedDirs })
          return (
            <div key={source.path} className={rowClass}>
              <button
                type="button"
                draggable={capabilities.readAccess !== null}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                title={source.filename}
                onDragStart={(event) => {
                  if (!capabilities.readAccess) { event.preventDefault(); return }
                  setFilePanelDragData(event.dataTransfer, [{
                    path: source.path, name: source.filename, isDirectory: source.isDirectory, scope: 'session',
                  }])
                }}
                onClick={() => preview(source)}
              >
                {source.isDirectory ? <Folder className="size-[15px] shrink-0" /> : source.isImage ? <FileImage className="size-[15px] shrink-0" /> : <Paperclip className="size-[15px] shrink-0" />}
                <span className="min-w-0 truncate">{source.filename}</span>
              </button>
              <SessionSourceMenu source={source} capabilities={capabilities} onAddToChat={() => addToChat(source)} onPreview={() => preview(source)} onChanged={markChanged} onViewAll={onViewAll} />
            </div>
          )
        })}
        <button type="button" className={`${rowClass} w-full text-left text-muted-foreground/60`} onClick={onViewAll}>
          <Link2 className="size-[15px] shrink-0" />
          <span>查看全部</span>
        </button>
      </div>
    </>
  )
}
