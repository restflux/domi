import * as React from 'react'
import { Copy, FileText, Files, FolderInput, FolderSearch, MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { DefaultAppMenuItem } from '@/components/file-browser/DefaultAppMenuItem'
import { Input } from '@/components/ui/input'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { dispatchInsertFileMention } from '@/lib/file-panel-drag'
import type { SessionFileSource } from './session-files-popover-model'
import type { SessionSourceCapabilities } from './session-source-actions'

interface SessionSourceMenuProps {
  source: SessionFileSource
  capabilities: SessionSourceCapabilities
  onAddToChat: () => void
  onPreview: () => void
  onChanged: (oldPath: string) => void
  onViewAll: () => void
}

/** 来源是混合输入；菜单显隐不授予路径权限，每个文件 IPC 仍由 Main 校验。 */
export function SessionSourceMenu({ source, capabilities, onAddToChat, onPreview, onChanged, onViewAll }: SessionSourceMenuProps): React.ReactElement {
  const { path, filename, isDirectory } = source
  const access = capabilities.readAccess
  const [renaming, setRenaming] = React.useState(false)
  const [newName, setNewName] = React.useState(filename)
  const [deleting, setDeleting] = React.useState(false)

  const run = async (label: string, action: () => Promise<void>, changed = false): Promise<void> => {
    try {
      await action()
      if (changed) onChanged(path)
      else toast.success(label)
    } catch (error) {
      toast.error(`${label}失败`, { description: error instanceof Error ? error.message : '请检查文件是否仍在授权范围内' })
    }
  }

  const rename = (): void => {
    const target = newName.trim()
    if (!target || target === '.' || target === '..' || /[/\\]/.test(target)) {
      toast.error('请输入有效的文件名')
      return
    }
    if (!access || !capabilities.canMutate || target === filename) return
    void run('重命名', async () => {
      const parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) || '.'
      const siblings = await window.electronAPI.listDirectory(parent, access)
      if (siblings.some((sibling) => sibling.name === target && sibling.path !== path)) throw new Error('同名文件已存在')
      await window.electronAPI.renameFile(path, target, access)
    }, true)
    setRenaming(false)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" title={`操作 ${filename}`} aria-label={`操作 ${filename}`} className="flex size-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100">
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[9999] min-w-44">
          {access && <>
            <DropdownMenuItem onSelect={() => dispatchInsertFileMention([{ path, name: filename, isDirectory, scope: 'session' }])}><MessageSquarePlus />引用到 Agent</DropdownMenuItem>
            {!isDirectory && <DropdownMenuItem onSelect={onAddToChat}><MessageSquarePlus />添加到聊天</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => { void run('复制文件', () => window.electronAPI.copyFileSystemItem([path], access)) }}><Files />{isDirectory ? '复制文件夹' : '复制文件'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void run('复制路径', () => window.electronAPI.copyFileSystemPath([path], access)) }}><Copy />复制路径</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void run('在文件夹中显示', () => window.electronAPI.showAttachedInFolder(path, access)) }}><FolderSearch />在文件夹中显示</DropdownMenuItem>
            {!isDirectory && <><DefaultAppMenuItem filePath={path} access={access} /><DropdownMenuItem onSelect={onPreview}><FileText />{source.isImage ? '大屏预览' : '在预览中打开'}</DropdownMenuItem></>}
            {capabilities.canMutate && <>
              <DropdownMenuItem onSelect={() => {
                void window.electronAPI.openFolderDialog()
                  .then((folder) => { if (folder) return run('移动文件', () => window.electronAPI.moveFile(path, folder.path, access), true) })
                  .catch((error: unknown) => toast.error('选择目标文件夹失败', { description: error instanceof Error ? error.message : '无法访问文件夹' }))
              }}><FolderInput />移动到...</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setNewName(filename); setRenaming(true) }}><Pencil />重命名</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(true)}><Trash2 />删除</DropdownMenuItem>
            </>}
          </>}
          <DropdownMenuItem onSelect={onViewAll}>查看全部文件</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {capabilities.canMutate && access && <>
        <AlertDialog open={renaming} onOpenChange={setRenaming}>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>重命名</AlertDialogTitle><AlertDialogDescription>输入新的文件名，原文件内容不会改变。</AlertDialogDescription></AlertDialogHeader>
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} aria-label="新文件名" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); rename() } }} />
            <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={(event) => { event.preventDefault(); rename() }}>确定</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={deleting} onOpenChange={setDeleting}>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>删除{isDirectory ? '文件夹' : '文件'}？</AlertDialogTitle><AlertDialogDescription>确定要删除 {filename} 吗？{isDirectory && '其中的文件也会被删除。'}此操作不可撤销。</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { setDeleting(false); void run('删除', () => window.electronAPI.deleteFile(path, access), true) }}>删除</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>}
    </>
  )
}
