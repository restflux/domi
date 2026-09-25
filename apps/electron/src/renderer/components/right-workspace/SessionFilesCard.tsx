/** 会话文件浮窗：只按确定的来源区分生成内容与用户附加输入。 */
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { FileImage, Folder, Link2, MoreHorizontal, Paperclip, Plus } from 'lucide-react'
import type { GeneratedImageItem, SDKMessage } from '@domi/shared'
import {
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  agentLiveMessagesAtomFamily,
  agentSessionsAtom,
  agentWorkspacesAtom,
  workspaceFilesVersionAtom,
} from '@/atoms/agent-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { setFilePanelDragData } from '@/lib/file-panel-drag'
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
  const [generatedImages, setGeneratedImages] = React.useState<GeneratedImageItem[]>([])
  const [sessionMessages, setSessionMessages] = React.useState<SDKMessage[]>([])
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

  const preview = React.useCallback((filePath: string, basePaths: string[]): void => {
    openPreview(sessionId, {
      filePath,
      previewOnly: true,
      pathSpace: 'session-workbench',
      basePaths,
    })
  }, [openPreview, sessionId])

  return (
    <>
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
          {outputs.map((image) => (
            <button
              key={image.localPath}
              type="button"
              className={`${rowClass} w-full text-left`}
              onClick={() => preview(image.localPath, sessionPath ? [sessionPath] : [])}
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
        {sources.map(({ path, filename, isDirectory, isImage }) => (
          <div key={path} className={rowClass}>
            <button
              type="button"
              draggable
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              title={filename}
              onDragStart={(event) => setFilePanelDragData(event.dataTransfer, [{
                path, name: filename, isDirectory, scope: 'session',
              }])}
              onClick={isDirectory ? onViewAll : () => preview(path, [path, sessionPath ?? ''].filter(Boolean))}
            >
              {isDirectory ? <Folder className="size-[15px] shrink-0" /> : isImage ? <FileImage className="size-[15px] shrink-0" /> : <Paperclip className="size-[15px] shrink-0" />}
              <span className="min-w-0 truncate">{filename}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" title={`操作 ${filename}`} aria-label={`操作 ${filename}`} className="flex size-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100">
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onViewAll}>查看全部文件</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        <button type="button" className={`${rowClass} w-full text-left text-muted-foreground/60`} onClick={onViewAll}>
          <Link2 className="size-[15px] shrink-0" />
          <span>查看全部</span>
        </button>
      </div>
    </>
  )
}
