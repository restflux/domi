import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertTriangle,
  Copy,
  FileCode2,
  FolderCode,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { PiExtensionTrustEntry } from '@domi/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  approvePiExtensionCandidateAtomFamily,
  piExtensionTrustConfirmedAtomFamily,
  piExtensionTrustStateAtomFamily,
  pickPiExtensionCandidateAtomFamily,
  refreshPiExtensionTrustAtomFamily,
  resetPiExtensionTrustAtomFamily,
  revokePiExtensionTrustAtomFamily,
} from '@/atoms/pi-extension-trust-atoms.ts'
import { formatPiExtensionTrustError } from '../../lib/pi-extension-trust-view-model.ts'
import { copyTextToClipboard } from '@/lib/clipboard'

interface ExtensionTrustDialogProps {
  open: boolean
  workspaceId: string
  onOpenChange: (open: boolean) => void
}

const statusLabels: Record<PiExtensionTrustEntry['status'], string> = {
  valid: '有效',
  stale: '内容已变化，不会加载',
  missing: '文件缺失，不会加载',
  invalid: '路径无效，不会加载',
}

interface RevocationTarget {
  workspaceId: string
  extension: PiExtensionTrustEntry
}

export function ExtensionTrustDialog({
  open,
  workspaceId,
  onOpenChange,
}: ExtensionTrustDialogProps): React.ReactElement {
  const state = useAtomValue(piExtensionTrustStateAtomFamily(workspaceId))
  const setConfirmed = useSetAtom(piExtensionTrustConfirmedAtomFamily(workspaceId))
  const refresh = useSetAtom(refreshPiExtensionTrustAtomFamily(workspaceId))
  const reset = useSetAtom(resetPiExtensionTrustAtomFamily(workspaceId))
  const pickCandidate = useSetAtom(pickPiExtensionCandidateAtomFamily(workspaceId))
  const approve = useSetAtom(approvePiExtensionCandidateAtomFamily(workspaceId))
  const revoke = useSetAtom(revokePiExtensionTrustAtomFamily(workspaceId))
  const [revocationTarget, setRevocationTarget] = React.useState<RevocationTarget | null>(null)

  React.useEffect(() => {
    reset()
    setRevocationTarget(null)
    if (open) void refresh()
    return () => reset()
  }, [open, refresh, reset, workspaceId])

  const copyDigest = async (digest: string): Promise<void> => {
    try {
      await copyTextToClipboard(digest)
      toast.success('完整摘要已复制')
    } catch (error) {
      toast.error('复制摘要失败', { description: formatPiExtensionTrustError(error) })
    }
  }

  const confirmRevoke = (): void => {
    const target = revocationTarget
    setRevocationTarget(null)
    if (target?.workspaceId === workspaceId) void revoke(target.extension.extensionId)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-amber-500" />
            Extension Trust
          </DialogTitle>
          <DialogDescription>
            仅显式批准且摘要未变化的 Pi Extension 会在当前项目加载。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto scrollbar-thin px-6 py-5">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">选择待批准扩展</h3>
                <p className="mt-1 text-xs text-muted-foreground">选择动作和路径检查均由主进程完成。</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void pickCandidate('file')}>
                  <FileCode2 className="mr-1.5 size-4" />选择文件
                </Button>
                <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void pickCandidate('directory')}>
                  <FolderCode className="mr-1.5 size-4" />选择目录
                </Button>
              </div>
            </div>

            {state.candidate ? (
              <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
                <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div className="text-xs leading-5">
                    <div className="font-medium">风险：扩展代码将以当前用户权限执行</div>
                    <div>{state.candidate.kind === 'directory' ? '目录中的多个源码文件都可能参与执行。' : '该源码文件可调用本机与项目资源。'}</div>
                  </div>
                </div>
                <dl className="grid gap-2 text-xs sm:grid-cols-[72px_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">路径</dt>
                  <dd className="break-all font-mono text-foreground/80">{state.candidate.path}</dd>
                  <dt className="text-muted-foreground">摘要</dt>
                  <dd className="flex items-start gap-1">
                    <span className="min-w-0 flex-1 break-all font-mono text-foreground/80">{state.candidate.digest}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6 shrink-0"
                      aria-label="复制完整摘要"
                      title="复制完整摘要"
                      onClick={() => void copyDigest(state.candidate!.digest)}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </dd>
                  <dt className="text-muted-foreground">类型</dt>
                  <dd>{state.candidate.kind === 'file' ? '单文件' : '目录'}</dd>
                </dl>
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-foreground/80">
                  <input
                    type="checkbox"
                    checked={state.confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    className="mt-1"
                  />
                  我确认信任此路径当前摘要对应的代码，并了解其会在本机执行。
                </label>
                <Button size="sm" disabled={state.busy || !state.confirmed} onClick={() => void approve()}>
                  {state.busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                  显式批准
                </Button>
              </div>
            ) : null}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-foreground">当前项目授权</h3>
                <p className="mt-1 text-xs text-muted-foreground">状态异常的授权会保留供检查，但不会传给 Extension Loader。</p>
              </div>
              <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void refresh()}>
                <RefreshCw className={`mr-1.5 size-4 ${state.busy ? 'animate-spin' : ''}`} />刷新
              </Button>
            </div>

            {state.extensions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 py-8 text-center text-sm text-muted-foreground">
                当前项目没有已批准的 Extension。
              </div>
            ) : (
              <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
                {state.extensions.map((extension) => (
                  <div key={extension.extensionId} className="flex items-start gap-3 p-4">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="break-all font-mono text-xs text-foreground/80">{extension.path}</div>
                      <div className="flex items-start gap-1">
                        <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">{extension.digest}</span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6 shrink-0"
                          aria-label="复制完整摘要"
                          title="复制完整摘要"
                          onClick={() => void copyDigest(extension.digest)}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={extension.status === 'valid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                          {statusLabels[extension.status]}
                        </span>
                        <span className="text-muted-foreground">批准于 {new Date(extension.approvedAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="撤销 Extension 授权"
                      disabled={state.busy}
                      onClick={() => setRevocationTarget({ workspaceId, extension })}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {state.error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">
              {state.error}
            </div>
          ) : null}
        </div>
      </DialogContent>

      <AlertDialog
        open={revocationTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRevocationTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销 Extension 授权？</AlertDialogTitle>
            <AlertDialogDescription>
              撤销后该 Extension 将不再为当前项目加载。此操作不会删除源文件。
              {revocationTarget ? (
                <span className="mt-2 block break-all font-mono text-xs text-foreground/80">
                  {revocationTarget.extension.path}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmRevoke}
            >
              确认撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
