/** 草稿迁移与已执行会话“交接到新会话”的统一对话框。 */

import * as React from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { LocalProjectBadge } from './LocalProjectBadge'
import type { AgentWorkspace, AgentSessionMeta, SessionTargetRef } from '@domi/shared'

export function getInitialHandoffWorkspaceId(isDraft: boolean, sourceWorkspaceId?: string): string {
  return isDraft ? '' : sourceWorkspaceId ?? ''
}

export async function copyGeneratedHandoffContent(
  content: string,
  copy: (value: string) => Promise<void> = copyTextToClipboard,
): Promise<void> {
  await copy(content)
}

interface HandoffLocationChoiceProps {
  selected: boolean
  disabled?: boolean
  title: string
  description: string
  onSelect: () => void
}

export function HandoffLocationChoice({
  selected,
  disabled = false,
  title,
  description,
  onSelect,
}: HandoffLocationChoiceProps): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected
          ? 'border-primary bg-primary/10 shadow-sm'
          : 'border-border bg-background hover:border-primary/50 hover:bg-muted/50',
        disabled && 'cursor-not-allowed opacity-50 hover:border-border hover:bg-background',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2 font-medium">
          <span>{title}</span>
          {selected ? <span className="text-xs text-primary">已选择</span> : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

interface MoveSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  sourceWorkspaceId: string | undefined
  sourceTarget: SessionTargetRef | undefined
  isDraft: boolean
  workspaces: AgentWorkspace[]
  onMoved: (updatedSession: AgentSessionMeta, targetWorkspaceName: string) => void | Promise<void>
  onHandedOff: (newSession: AgentSessionMeta, targetWorkspaceName: string) => void | Promise<void>
}

export function MoveSessionDialog({
  open,
  onOpenChange,
  sessionId,
  sourceWorkspaceId,
  sourceTarget,
  isDraft,
  workspaces,
  onMoved,
  onHandedOff,
}: MoveSessionDialogProps): React.ReactElement {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState('')
  const [targetKind, setTargetKind] = React.useState<'local' | 'isolated'>('local')
  const [worktreeAvailable, setWorktreeAvailable] = React.useState<boolean | null>(null)
  const [pendingAction, setPendingAction] = React.useState<'handoff' | 'copy' | 'move' | null>(null)

  const availableWorkspaces = React.useMemo(
    () => isDraft
      ? workspaces.filter((workspace) => workspace.id !== sourceWorkspaceId)
      : workspaces,
    [isDraft, sourceWorkspaceId, workspaces],
  )
  const selectedWorkspace = availableWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId)
  const isCurrentProject = selectedWorkspaceId === sourceWorkspaceId
  const localMayMissChanges = !isDraft && isCurrentProject && sourceTarget?.kind === 'isolated'

  React.useEffect(() => {
    if (!open) return
    setSelectedWorkspaceId(getInitialHandoffWorkspaceId(isDraft, sourceWorkspaceId))
    setTargetKind(sourceTarget?.kind === 'isolated' ? 'isolated' : 'local')
    setWorktreeAvailable(null)
    setPendingAction(null)
  }, [isDraft, open, sourceTarget?.kind, sourceWorkspaceId])

  React.useEffect(() => {
    let disposed = false
    setWorktreeAvailable(null)
    if (isDraft || !selectedWorkspace) return () => { disposed = true }
    if (selectedWorkspace.id !== sourceWorkspaceId) setTargetKind('local')
    else setTargetKind(sourceTarget?.kind === 'isolated' ? 'isolated' : 'local')

    const inspect = async (): Promise<void> => {
      const root = selectedWorkspace.projectRootPath
        ?? await window.electronAPI.getWorkspaceFilesPath(selectedWorkspace.slug)
      const status = await window.electronAPI.getGitRepoStatus(root)
      if (!disposed) {
        const available = status?.isRepo === true
        setWorktreeAvailable(available)
        if (!available) setTargetKind('local')
      }
    }
    void inspect().catch(() => {
      if (!disposed) setWorktreeAvailable(false)
    })
    return () => { disposed = true }
  }, [isDraft, selectedWorkspace, sourceTarget?.kind, sourceWorkspaceId])

  const handleCopy = async (): Promise<void> => {
    if (pendingAction) return
    setPendingAction('copy')
    try {
      const result = await window.electronAPI.sessionCheckout.exportHandoffPrompt?.({ sessionId })
      if (!result) throw new Error('当前版本不支持生成交接内容')
      if (!result.ok) throw new Error(result.error.message)
      await copyGeneratedHandoffContent(result.value.prompt)
      toast.success('已生成并复制交接内容')
      onOpenChange(false)
    } catch (error) {
      toast.error('生成交接内容失败', {
        description: error instanceof Error ? error.message : '未知错误',
      })
      setPendingAction(null)
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!selectedWorkspace || pendingAction) return
    setPendingAction(isDraft ? 'move' : 'handoff')
    try {
      if (isDraft) {
        const updated = await window.electronAPI.moveAgentSessionToWorkspace({
          sessionId,
          targetWorkspaceId: selectedWorkspace.id,
        })
        await onMoved(updated, selectedWorkspace.name)
      } else {
        const inspected = await window.electronAPI.sessionCheckout.inspect({ sessionId })
        if (!inspected.ok) throw new Error(inspected.error.message)
        const result = await window.electronAPI.sessionCheckout.handoffSession?.({
          sessionId,
          expectedRevision: inspected.value.revision,
          targetKind,
          confirmedIgnoreDirtyLocal: targetKind === 'isolated',
          ...(selectedWorkspace.id !== sourceWorkspaceId
            ? { targetWorkspaceId: selectedWorkspace.id }
            : {}),
        })
        if (!result) throw new Error('当前版本不支持创建交接会话')
        if (!result.ok) throw new Error(result.error.message)
        await onHandedOff(result.value.session, selectedWorkspace.name)
      }
      onOpenChange(false)
    } catch (error) {
      console.error(`[${isDraft ? '迁移会话' : '交接到新会话'}] 操作失败:`, error)
      toast.error(isDraft ? '迁移失败' : '交接失败', {
        description: error instanceof Error ? error.message : '未知错误',
      })
      setPendingAction(null)
    }
  }

  const pending = pendingAction !== null
  const targetUnavailable = !isDraft && targetKind === 'isolated' && worktreeAvailable !== true
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDraft ? '迁移到其他项目' : '交接到新会话'}</DialogTitle>
          <DialogDescription>
            {isDraft
              ? '选择目标项目，草稿会话将移动过去。'
              : 'Domi 会用 AI 整理当前进度，并在你选择的位置创建新会话。原会话保持不变。'}
          </DialogDescription>
        </DialogHeader>

        {availableWorkspaces.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">没有其他可用项目，请先创建新项目。</p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">目标项目</span>
              <Select value={selectedWorkspaceId} onValueChange={setSelectedWorkspaceId}>
                <SelectTrigger><SelectValue placeholder="选择目标项目" /></SelectTrigger>
                <SelectContent>
                  {availableWorkspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      <span className="flex items-center gap-1.5">
                        <span>{workspace.name}</span>
                        {workspace.id === sourceWorkspaceId ? (
                          <span className="text-xs text-muted-foreground">当前项目</span>
                        ) : (
                          <LocalProjectBadge
                            projectRootPath={workspace.projectRootPath}
                            projectRootStatus={workspace.projectRootStatus}
                          />
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!isDraft && selectedWorkspace ? (
              <div className="grid gap-2">
                <span className="text-sm font-medium">工作位置</span>
                <div role="radiogroup" aria-label="工作位置" className="grid gap-2">
                  <HandoffLocationChoice
                    selected={targetKind === 'local'}
                    title="使用项目当前目录"
                    description={localMayMissChanges
                      ? '当前独立工作区中的修改不会自动带到项目目录。'
                      : '新会话直接使用目标项目现在的文件。'}
                    onSelect={() => setTargetKind('local')}
                  />
                  <HandoffLocationChoice
                    selected={targetKind === 'isolated'}
                    disabled={worktreeAvailable === false}
                    title="新建独立工作区（Worktree）"
                    description={worktreeAvailable === false
                      ? '这个项目目前不能创建 Worktree。'
                      : worktreeAvailable === null
                        ? '正在检查项目是否可以创建 Worktree。'
                        : '从已提交内容创建，当前未提交的修改不会带过去。'}
                    onSelect={() => setTargetKind('isolated')}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <div>
            {!isDraft ? (
              <Button variant="outline" onClick={handleCopy} disabled={pending}>
                {pendingAction === 'copy' ? '正在生成...' : '仅生成并复制交接内容'}
              </Button>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>取消</Button>
            <Button
              onClick={handleConfirm}
              disabled={!selectedWorkspaceId || pending || targetUnavailable || availableWorkspaces.length === 0}
            >
              {pendingAction === 'move'
                ? '迁移中...'
                : pendingAction === 'handoff'
                  ? '正在创建...'
                  : isDraft ? '确认迁移' : '创建新会话并继续'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
