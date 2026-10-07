import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { WorktreeLocalFileEntry, WorktreeLocalFileOverwrite, WorktreeLocalFilesView } from '@domi/shared'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx'
import {
  canPrepareWorktreeLocalFiles, closeWorktreeLocalFilesDialogAtom,
  confirmWorktreeLocalFilesAtom, hasWorktreeLocalFilesChanges,
  prepareWorktreeLocalFilesAtom, refreshWorktreeLocalFilesDialogAtom,
  removeWorktreeLocalFileAtom, saveWorktreeLocalFilesAtom,
  worktreeLocalFilesDialogAtom,
} from '@/atoms/worktree-local-files-atoms.ts'
import { WorktreeLocalFilesSelector } from './WorktreeLocalFilesSelector.tsx'

export function worktreeLocalFileStatusLabel(status: WorktreeLocalFileEntry['status'] | 'draft'): string {
  if (status === 'ready') return '已批准'
  if (status === 'missing') return '原项目文件缺失'
  if (status === 'unapproved') return '待批准'
  return '待保存'
}

interface WorktreeLocalFileRowProps {
  path: string
  status: WorktreeLocalFileEntry['status'] | 'draft'
  targetExists?: boolean
  disabled: boolean
  onRemove: () => void
}

/** 列表只呈现相对路径与状态，不请求文件内容。 */
export function WorktreeLocalFileRow({ path, status, targetExists, disabled, onRemove }: WorktreeLocalFileRowProps): React.ReactElement {
  return (
    <li className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="break-all font-mono text-xs">{path}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {worktreeLocalFileStatusLabel(status)}
          {targetExists !== undefined && ` · Worktree ${targetExists ? '已存在' : '尚未复制'}`}
        </div>
      </div>
      <Button variant="ghost" size="icon" className="size-7 shrink-0" disabled={disabled} aria-label={`移除 ${path}`} onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  )
}

interface OverwriteConfirmation {
  view: WorktreeLocalFilesView
  files: WorktreeLocalFileOverwrite[]
}

/** 全局只挂载一个实例；菜单和准备失败入口都通过 openWorktreeLocalFilesDialogAtom 打开。 */
export function WorktreeLocalFilesDialog(): React.ReactElement {
  const state = useAtomValue(worktreeLocalFilesDialogAtom)
  const close = useSetAtom(closeWorktreeLocalFilesDialogAtom)
  const refresh = useSetAtom(refreshWorktreeLocalFilesDialogAtom)
  const remove = useSetAtom(removeWorktreeLocalFileAtom)
  const save = useSetAtom(saveWorktreeLocalFilesAtom)
  const confirm = useSetAtom(confirmWorktreeLocalFilesAtom)
  const prepare = useSetAtom(prepareWorktreeLocalFilesAtom)
  const [overwritePaths, setOverwritePaths] = React.useState<string[]>([])
  const [overwriteConfirmation, setOverwriteConfirmation] = React.useState<OverwriteConfirmation | null>(null)

  React.useEffect(() => {
    setOverwritePaths([])
    setOverwriteConfirmation(null)
  }, [state.request, state.view])

  const disabled = state.loading || !!state.busy
  const dirty = hasWorktreeLocalFilesChanges(state)
  const unapproved = state.view?.entries.some((entry) => entry.status === 'unapproved') ?? false
  const canPrepare = canPrepareWorktreeLocalFiles(state)
  const existingFiles = state.view?.target?.files.filter((file) => file.exists && state.paths.includes(file.path)) ?? []
  const showOverwriteConfirmation = overwriteConfirmation !== null && overwriteConfirmation.view === state.view

  const requestOverwrite = (): void => {
    if (!canPrepare || !state.view) return
    const files = existingFiles.filter((file) => overwritePaths.includes(file.path))
      .map((file) => ({ path: file.path, expectedFingerprint: file.fingerprint }))
    if (files.length) setOverwriteConfirmation({ view: state.view, files })
  }

  return (
    <>
      <Dialog open={state.request !== null} onOpenChange={(open) => { if (!open) close() }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Worktree 本地配置</DialogTitle>
            <DialogDescription>
              配置清单固定保存在原项目的 <code>.worktreeinclude</code> 中，不随当前会话切换保存位置。这里只展示相对路径与状态，不展示文件内容。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs leading-5 text-muted-foreground">
              勾选本地配置文件或文件夹，确认已选文件后保存并批准，用于新建 Worktree。文件夹会展开为具体文件清单，新增文件不会自动加入；现有 Worktree 需要手动补复制。
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void refresh()}>
                <RefreshCw className="mr-1.5 size-3.5" />刷新清单
              </Button>
            </div>
            {state.loading && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在检查配置文件…</div>}
            {state.view && <div className="grid gap-4 md:grid-cols-2">
              <WorktreeLocalFilesSelector disabled={disabled} />
              <section aria-label="已选本地配置文件" className="min-w-0 space-y-2">
                <h3 className="text-sm font-medium">已选文件 · {state.paths.length} / 100</h3>
                <p className="text-[11px] text-muted-foreground">移除条目不会删除已复制到 Worktree 的文件。</p>
                {state.paths.length ? (
                  <ul className="max-h-64 space-y-2 overflow-y-auto">
                    {state.paths.map((path) => (
                      <WorktreeLocalFileRow
                        key={path}
                        path={path}
                        status={state.view?.entries.find((entry) => entry.path === path)?.status ?? 'draft'}
                        targetExists={state.view?.target?.files.find((file) => file.path === path)?.exists}
                        disabled={disabled}
                        onRemove={() => remove(path)}
                      />
                    ))}
                  </ul>
                ) : <p className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">勾选需要的本地配置文件。</p>}
              </section>
            </div>}
            {dirty && <p className="text-xs text-muted-foreground">修改尚未保存；刷新清单会丢弃这些修改。</p>}
            {unapproved && <p className="text-xs text-amber-700 dark:text-amber-300">当前清单尚未在本机批准，批准前不会复制配置文件。</p>}
            {state.view?.target && (
              <div className="space-y-2 rounded-lg bg-muted/50 p-3">
                <div className="text-sm font-medium">当前会话 Worktree</div>
                <p className="text-xs text-muted-foreground">
                  {state.view.target.canPrepare ? '补复制默认只添加缺失文件，保留 Worktree 中已存在的文件。' : '当前会话暂不可补复制，请在 Worktree 空闲且可准备时重试。'}
                </p>
                {existingFiles.length > 0 && (
                  <fieldset disabled={!canPrepare} className="space-y-2">
                    <legend className="mb-2 text-xs text-muted-foreground">可选：覆盖已存在文件（需要再次确认）</legend>
                    {existingFiles.map((file) => (
                      <label key={file.path} className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-primary"
                          checked={overwritePaths.includes(file.path)}
                          onChange={(event) => setOverwritePaths((paths) => event.target.checked ? [...paths, file.path] : paths.filter((path) => path !== file.path))}
                        />
                        <span className="break-all font-mono">{file.path}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!canPrepare} onClick={() => void prepare()}>补复制缺失文件</Button>
                  {existingFiles.length > 0 && <Button size="sm" variant="outline" disabled={!canPrepare || !overwritePaths.length} onClick={requestOverwrite}>补复制并覆盖所选</Button>}
                </div>
              </div>
            )}
            {state.busy === 'select' && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在整理所选文件…</p>}
            {(state.busy === 'prepare' || state.busy === 'confirm') && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {state.busy === 'prepare' ? '正在补复制配置文件…' : '正在批准清单…'}
              </p>
            )}
            {state.error && <p role="alert" className="text-sm text-destructive">{state.error.message}</p>}
            {state.notice && <p role="status" className="text-sm text-muted-foreground">{state.notice}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close()}>关闭</Button>
            {unapproved && !dirty && <Button variant="outline" disabled={disabled} onClick={() => void confirm()}>批准当前清单</Button>}
            <Button disabled={disabled || !state.view || !dirty} onClick={() => void save()}>
              {state.busy === 'save' && <Loader2 className="mr-1.5 size-4 animate-spin" />}保存并批准
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={showOverwriteConfirmation} onOpenChange={(open) => { if (!open) setOverwriteConfirmation(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>覆盖所选 Worktree 配置文件？</AlertDialogTitle>
            <AlertDialogDescription>以下文件将替换为原项目中的本地文件，Worktree 中的现有内容会被覆盖。其他已存在文件保持不变。</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
            {overwriteConfirmation?.files.map((file) => <li key={file.path} className="break-all font-mono">{file.path}</li>)}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!canPrepare || !showOverwriteConfirmation} onClick={() => {
              if (overwriteConfirmation?.view === state.view) void prepare(overwriteConfirmation.files)
              setOverwriteConfirmation(null)
            }}>确认覆盖并补复制</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
