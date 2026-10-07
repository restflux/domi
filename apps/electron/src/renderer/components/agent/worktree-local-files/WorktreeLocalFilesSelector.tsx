import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, ChevronRight, File, Folder, Loader2, RefreshCw, Search } from 'lucide-react'
import type { WorktreeLocalFilesNode } from '@domi/shared'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import {
  removeWorktreeLocalDirectoryAtom, removeWorktreeLocalFileAtom,
  selectWorktreeLocalFilesAtom, worktreeLocalFilesDialogAtom,
} from '@/atoms/worktree-local-files-atoms.ts'
import {
  loadWorktreeLocalDirectoryAtom, refreshWorktreeLocalFilesBrowserAtom,
  setWorktreeLocalFilesQueryAtom, toggleWorktreeLocalDirectoryAtom,
  worktreeLocalFilesBrowserAtom,
} from '@/atoms/worktree-local-files-browser-atoms.ts'

export function localFileFolderSelection(path: string, selected: readonly string[], snapshot?: readonly string[]): boolean | 'indeterminate' {
  if (snapshot?.length && snapshot.every(file => selected.includes(file))) return true
  return selected.some(file => file.startsWith(`${path}/`)) ? 'indeterminate' : false
}

interface LocalFileTreeRowProps {
  node: WorktreeLocalFilesNode
  checked: boolean | 'indeterminate'
  expanded: boolean
  disabled: boolean
  fullPath?: boolean
  selectedCount?: number
  onToggle: (checked: boolean) => void
  onExpand: () => void
  onClear: () => void
}

/** 不可选条目保持禁用；原因只在延迟悬停或键盘聚焦时提示。 */
export function LocalFileTreeRow({ node, checked, expanded, disabled, fullPath, selectedCount = 0, onToggle, onExpand, onClear }: LocalFileTreeRowProps): React.ReactElement {
  const directory = node.kind === 'directory'
  const checkboxId = React.useId()
  const row = (
    <div
      className={cn('flex items-start gap-2 rounded-md px-2 py-1.5', node.selectable ? 'hover:bg-muted/60' : 'text-muted-foreground opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
      data-local-file-path={node.path}
      tabIndex={node.selectable ? undefined : 0}
      role={node.selectable ? undefined : 'group'}
      aria-label={node.selectable ? undefined : `${node.path}，不可选择`}
    >
      {directory ? (
        <button type="button" disabled={disabled || !node.selectable} aria-label={`${expanded ? '收起' : '展开'} ${node.path}`} aria-expanded={expanded} onClick={onExpand} className="mt-0.5 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : <span className="w-3.5 shrink-0" />}
      <input id={checkboxId} type="checkbox" className="mt-0.5 shrink-0 accent-primary disabled:pointer-events-none" checked={checked === true}
        ref={element => { if (element) element.indeterminate = checked === 'indeterminate' }}
        aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
        aria-label={`选择 ${node.path}`} disabled={disabled || !node.selectable}
        onChange={event => onToggle(event.target.checked)} />
      {directory ? <Folder className={cn('mt-0.5 size-3.5 shrink-0', node.selectable ? 'text-primary' : 'text-muted-foreground')} /> : <File className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <label htmlFor={checkboxId} className={cn('break-all font-mono text-xs', node.selectable ? 'cursor-pointer' : 'cursor-default')}>{fullPath ? node.path : node.name}</label>
        {directory && selectedCount > 0 && <p className="mt-0.5 text-[11px] text-muted-foreground">已选 {selectedCount} 个文件</p>}
      </div>
      {directory && selectedCount > 0 && <button type="button" className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={disabled} aria-label={`清除 ${node.path} 中的选择`} onClick={onClear}>清除</button>}
    </div>
  )
  if (node.selectable || !node.reason) return row
  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs break-words">{node.reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function FileTreeNode({ node, disabled, fullPath = false }: { node: WorktreeLocalFilesNode; disabled: boolean; fullPath?: boolean }): React.ReactElement {
  const state = useAtomValue(worktreeLocalFilesDialogAtom)
  const browser = useAtomValue(worktreeLocalFilesBrowserAtom)
  const select = useSetAtom(selectWorktreeLocalFilesAtom)
  const remove = useSetAtom(removeWorktreeLocalFileAtom)
  const removeDirectory = useSetAtom(removeWorktreeLocalDirectoryAtom)
  const toggle = useSetAtom(toggleWorktreeLocalDirectoryAtom)
  const directory = node.kind === 'directory'
  const expanded = browser.expanded.includes(node.path)
  const count = directory ? state.paths.filter(path => path.startsWith(`${node.path}/`)).length : 0
  const checked = directory ? localFileFolderSelection(node.path, state.paths, state.folderSelections[node.path]) : state.paths.includes(node.path)
  return (
    <li>
      <LocalFileTreeRow node={node} checked={checked} expanded={expanded} disabled={disabled} fullPath={fullPath} selectedCount={count}
        onToggle={checked => {
          if (checked) void select({ path: node.path, directory })
          else if (directory) removeDirectory(node.path)
          else remove(node.path)
        }}
        onExpand={() => void toggle(node.path)}
        onClear={() => removeDirectory(node.path)} />
      {expanded && node.selectable && <div className="ml-4"><FileTreeDirectory directory={node.path} disabled={disabled} /></div>}
    </li>
  )
}

function FileTreeDirectory({ directory, disabled }: { directory: string; disabled: boolean }): React.ReactElement {
  const dialog = useAtomValue(worktreeLocalFilesDialogAtom)
  const browser = useAtomValue(worktreeLocalFilesBrowserAtom)
  const load = useSetAtom(loadWorktreeLocalDirectoryAtom)
  const data = browser.directories[directory]
  const missing = data === undefined
  React.useEffect(() => { if (missing) void load({ directory }) }, [directory, dialog.request, dialog.view, missing, load])
  if (!data || data.loading) return <p role="status" className="flex items-center gap-2 p-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />正在读取文件…</p>
  if (data.error) return <p role="alert" className="p-2 text-xs text-destructive">{data.error.message}</p>
  if (!data.entries?.length) return <p className="p-2 text-xs text-muted-foreground">此文件夹为空。</p>
  return <ul>{data.entries.map(node => <FileTreeNode key={node.path} node={node} disabled={disabled} />)}</ul>
}

export function WorktreeLocalFilesSelector({ disabled }: { disabled: boolean }): React.ReactElement {
  const dialog = useAtomValue(worktreeLocalFilesDialogAtom)
  const browser = useAtomValue(worktreeLocalFilesBrowserAtom)
  const setQuery = useSetAtom(setWorktreeLocalFilesQueryAtom)
  const load = useSetAtom(loadWorktreeLocalDirectoryAtom)
  const refresh = useSetAtom(refreshWorktreeLocalFilesBrowserAtom)
  const searching = !!browser.query.trim()
  React.useEffect(() => {
    if (!searching) return
    const timer = setTimeout(() => void load({ directory: '', query: browser.query }), 250)
    return () => clearTimeout(timer)
  }, [browser.query, dialog.request, dialog.view, searching, load])
  return (
    <section aria-label="选择项目本地配置文件" className="min-w-0 rounded-lg bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">项目文件</h3>
        <Button type="button" variant="ghost" size="icon" className="size-7" disabled={disabled} aria-label="刷新项目文件树" onClick={() => void refresh()}><RefreshCw className="size-3.5" /></Button>
      </div>
      <label className="mb-2 flex items-center gap-2 rounded-md bg-background px-2.5 py-2 shadow-sm">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input data-local-files-search aria-label="搜索项目文件" placeholder="搜索文件名或相对路径" maxLength={128} value={browser.query} disabled={disabled} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
      </label>
      <p className="mb-2 text-[11px] leading-4 text-muted-foreground">仅浏览当前项目；勾选文件夹会选择其中可用文件。</p>
      <div className="max-h-64 overflow-y-auto">
        {searching ? (
          browser.search.error ? <p role="alert" className="p-2 text-xs text-destructive">{browser.search.error.message}</p>
            : browser.search.loading || browser.search.entries === null ? <p role="status" className="flex items-center gap-2 p-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />正在搜索…</p>
              : browser.search.entries.length ? <ul>{browser.search.entries.map(node => <FileTreeNode key={node.path} node={node} disabled={disabled} fullPath />)}</ul>
                : <p className="p-2 text-xs text-muted-foreground">没有匹配的项目文件。</p>
        ) : <FileTreeDirectory directory="" disabled={disabled} />}
      </div>
    </section>
  )
}
