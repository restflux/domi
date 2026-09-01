import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { AgentSessionHandoffInput, SessionTargetRef, SessionTargetView } from '@domi/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx'
import {
  inspectSessionTargetAtomFamily,
  operateSessionTargetAtomFamily,
  sessionTargetStateAtomFamily,
  sessionTargetWorktreePendingAtomFamily,
} from '@/atoms/session-target-atoms.ts'
import { SessionTargetControl } from './SessionTargetControl.tsx'
import type { SessionTargetDisplayInput } from '@/lib/session-target-view-model.ts'
import { toast } from 'sonner'
import { worktreeManagerAtom } from '@/atoms/worktree-manager-atoms.ts'
import { agentSessionsAtom } from '@/atoms/agent-atoms.ts'
import { useOpenSession } from '@/hooks/useOpenSession.ts'
import { getSessionHandoffFeedback } from '@/lib/session-handoff-feedback.ts'

interface AgentSessionTargetProps {
  sessionId: string
  projectName: string
  /** 当前会话实际使用的项目根；用于在入口处判断 Worktree 是否可用。 */
  projectRootPath?: string
  persistedTarget?: SessionTargetRef
}

function displayTarget(
  snapshot: SessionTargetView,
  pendingAction: NonNullable<SessionTargetDisplayInput['pendingAction']> | null,
  running = false,
): SessionTargetDisplayInput {
  return {
    ...snapshot,
    pendingAction,
    running,
  }
}

function unselectedTarget(projectName: string): SessionTargetDisplayInput {
  return {
    project: { name: projectName },
    checkout: { id: '', kind: 'unselected', phase: 'unselected' },
    source: null,
    current: null,
    ownership: null,
    dirty: false,
    pendingAction: null,
  }
}

/** 负责每个 Agent 会话的 Session Target inspect 生命周期。 */
export function useInspectAgentSessionTarget(sessionId: string): void {
  const inspect = useSetAtom(inspectSessionTargetAtomFamily(sessionId))
  React.useEffect(() => {
    void inspect()
  }, [inspect])
}

export function AgentSessionTargetBadge({
  sessionId,
  projectName: _projectName,
}: AgentSessionTargetProps): React.ReactElement | null {
  const state = useAtomValue(sessionTargetStateAtomFamily(sessionId))
  const operate = useSetAtom(operateSessionTargetAtomFamily(sessionId))
  const setWorktreeManager = useSetAtom(worktreeManagerAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const openSession = useOpenSession()
  const [cleanupConfirmationOpen, setCleanupConfirmationOpen] = React.useState(false)
  const [handoffOpen, setHandoffOpen] = React.useState(false)
  const [handoffTargetKind, setHandoffTargetKind] = React.useState<'local' | 'isolated'>('isolated')
  const [handoffPending, setHandoffPending] = React.useState(false)
  useInspectAgentSessionTarget(sessionId)
  if (!state.snapshot) return null

  const target = displayTarget(state.snapshot, state.pendingAction)
  const delivery = target.delivery
  const isOwnerWorktree = target.checkout.kind === 'isolated' && target.ownership === 'owner'
  const canCreateWorktree = target.source?.oid !== 'unversioned'
  const previewActive = delivery?.state === 'preview_active'
  const canDiscardWorktree = isOwnerWorktree
    && (target.checkout.phase === 'ready' || target.checkout.phase === 'recovery_required')
    && !state.loading
  const canRetryCleanup = isOwnerWorktree
    && (delivery?.state === 'finalized' || delivery?.state === 'retained')
    && !state.loading

  const lifecycleAction = canRetryCleanup
    ? {
        label: delivery?.state === 'retained' ? '清理保留环境' : '重试清理环境',
        icon: 'retry' as const,
        disabled: false,
        pending: state.pendingAction === 'retry_cleanup',
        onClick: () => { void operate({ action: 'retry_cleanup' }) },
      }
    : canDiscardWorktree
      ? {
          label: previewActive ? '放弃任务并检查 Preview' : '放弃任务并清理 Worktree',
          icon: 'cleanup' as const,
          disabled: false,
          pending: state.pendingAction === 'discard',
          onClick: () => setCleanupConfirmationOpen(true),
        }
      : undefined

  const confirmHandoff = async (): Promise<void> => {
    if (!state.snapshot || !window.electronAPI.sessionCheckout.handoffSession || handoffPending) return
    setHandoffPending(true)
    try {
      const input: AgentSessionHandoffInput = {
        sessionId,
        expectedRevision: state.snapshot.revision,
        targetKind: handoffTargetKind,
        confirmedIgnoreDirtyLocal: handoffTargetKind === 'isolated',
      }
      const result = await window.electronAPI.sessionCheckout.handoffSession(input)
      if (!result.ok) {
        toast.error('无法交接到新会话', { description: result.error.message })
        return
      }
      setAgentSessions((sessions) => sessions.some((session) => session.id === result.value.session.id)
        ? sessions.map((session) => session.id === result.value.session.id ? result.value.session : session)
        : [result.value.session, ...sessions])
      setHandoffOpen(false)
      openSession('agent', result.value.session.id, result.value.session.title)
      const feedback = getSessionHandoffFeedback(result.value, handoffTargetKind)
      toast.success(feedback.title, { description: feedback.description })
    } finally {
      setHandoffPending(false)
    }
  }

  const confirmCleanup = (): void => {
    setCleanupConfirmationOpen(false)
    void operate({ action: 'discard', confirmDirty: true })
  }

  return (
    <>
      <SessionTargetControl
        target={target}
        compact
        disabled
        className="titlebar-no-drag max-w-[min(50vw,36rem)]"
        onChooseTarget={() => undefined}
        worktreeLifecycleAction={lifecycleAction}
        sessionHandoffAction={{
          disabled: state.loading || state.pendingAction !== null,
          pending: handoffPending,
          onClick: () => {
            setHandoffTargetKind(target.checkout.kind === 'local' && !canCreateWorktree ? 'local' : target.checkout.kind === 'local' ? 'local' : 'isolated')
            setHandoffOpen(true)
          },
        }}
        onOpenWorktreeManager={(scope) => setWorktreeManager({
          open: true,
          scope,
          ...(scope === 'project' ? { projectId: state.snapshot!.project.id } : {}),
          focusCheckoutId: state.snapshot!.checkout.id,
        })}
        onRevealTarget={() => {
          if (state.snapshot?.checkout.kind === 'isolated') {
            void window.electronAPI.sessionCheckout.revealManaged?.({ checkoutId: state.snapshot.checkout.id }).then((result) => {
              if (result && !result.ok) toast.error('无法打开 Worktree', { description: result.error.message })
            })
            return
          }
          void window.electronAPI.showSessionTargetInFolder({ sessionId, relativePath: '' }).catch((error) => {
            toast.error('无法打开 Session Target', {
              description: error instanceof Error ? error.message : '打开工作位置失败',
            })
          })
        }}
      />
      <AlertDialog open={handoffOpen} onOpenChange={setHandoffOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>交接到新会话</AlertDialogTitle>
            <AlertDialogDescription>
              Domi 会从当前已持久化的对话创建 durable handoff，并自动打开新的 Agent 会话。原会话和现有文件保持不变。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            {target.checkout.kind === 'local' ? (
              <label className="flex cursor-pointer gap-3 rounded-md border p-3 text-sm">
                <input type="radio" name="handoff-target" checked={handoffTargetKind === 'local'} onChange={() => setHandoffTargetKind('local')} />
                <span><strong>继续使用当前 Local</strong><span className="mt-1 block text-xs text-muted-foreground">只换新会话和上下文，不创建 Worktree、不复制文件。</span></span>
              </label>
            ) : null}
            {canCreateWorktree ? (
              <label className="flex cursor-pointer gap-3 rounded-md border p-3 text-sm">
                <input type="radio" name="handoff-target" checked={handoffTargetKind === 'isolated'} onChange={() => setHandoffTargetKind('isolated')} />
                <span><strong>创建新的 Worktree</strong><span className="mt-1 block text-xs text-muted-foreground">基于最新 Local HEAD 创建 fresh managed Worktree，并自动继续未完成任务。</span></span>
              </label>
            ) : null}
          </div>
          {handoffTargetKind === 'isolated' ? (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
              新 Worktree 只基于点击时的最新 Local HEAD 创建；Local 中现有 staged、unstaged 或 untracked 修改不会复制，也不会被 reset、rebase 或覆盖。
            </div>
          ) : null}
          {target.checkout.kind === 'isolated' ? (
            <p className="text-xs text-muted-foreground">当前 Worktree 的稳定任务快照和旧恢复证据会保留；为避免绕过 Preview，不能直接交接到 Local。</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={handoffPending}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={handoffPending} onClick={() => void confirmHandoff()}>
              {handoffPending ? '正在交接…' : '确认交接并自动继续'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cleanupConfirmationOpen} onOpenChange={setCleanupConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{previewActive ? '放弃任务并检查 Local Preview？' : '放弃任务并清理 Worktree？'}</AlertDialogTitle>
            <AlertDialogDescription>
              {previewActive
                ? '放弃任务不会撤回 Local Preview。若 Preview 已被提交，Domi 只清理 Worktree；若仍未提交或状态无法证明，操作会停止并保留恢复证据。'
                : 'Worktree 中尚未交付的修改将被永久放弃并清理，Local 中的文件不会受到影响。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={state.pendingAction !== null}
              onClick={confirmCleanup}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              确认清理 Worktree
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * 输入框上方的 Session Target 状态条：仅在全新会话未绑定 target 时显示，
 * 默认 Local，可勾选 Worktree；首次发送前由 AgentView 完成实际绑定，绑定后状态条消失。
 * 已对过话的会话（已绑定）不再显示、不可变更。
 */
export function AgentSessionTargetChooser({
  sessionId,
  projectName,
  projectRootPath,
  persistedTarget: _persistedTarget,
}: AgentSessionTargetProps): React.ReactElement | null {
  const state = useAtomValue(sessionTargetStateAtomFamily(sessionId))
  const [worktreePending, setWorktreePending] = useAtom(sessionTargetWorktreePendingAtomFamily(sessionId))
  const inspect = useSetAtom(inspectSessionTargetAtomFamily(sessionId))
  const [worktreeAvailable, setWorktreeAvailable] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    let disposed = false
    setWorktreeAvailable(null)
    if (!projectRootPath) {
      setWorktreeAvailable(false)
      return () => { disposed = true }
    }
    void window.electronAPI.getGitRepoStatus(projectRootPath)
      .then((status) => {
        if (!disposed) setWorktreeAvailable(status?.isRepo === true)
      })
      .catch(() => {
        if (!disposed) setWorktreeAvailable(false)
      })
    return () => { disposed = true }
  }, [projectRootPath])

  React.useEffect(() => {
    if (worktreeAvailable === false && worktreePending) setWorktreePending(false)
  }, [setWorktreePending, worktreeAvailable, worktreePending])

  // 已绑定（对过话）后不显示操作条。
  if (state.snapshot) return null
  // inspect 尚未完成时由输入框外的状态行提示，避免让用户误以为输入框本身正在加载。
  if (state.loading) return null
  if (state.error && state.error.code !== 'target_unselected') {
    return (
      <div className="flex min-h-9 items-center gap-2 px-2.5 py-1 text-xs" role="alert">
        <span className="min-w-0 flex-1 truncate text-destructive">{state.error.message}</span>
        <button
          type="button"
          className="shrink-0 underline underline-offset-2 text-foreground/70 transition-colors hover:text-foreground"
          onClick={() => { void inspect() }}
        >
          重试检查工作区
        </button>
      </div>
    )
  }

  return (
    <SessionTargetControl
      target={unselectedTarget(projectName)}
      className="w-full"
      worktreeChecked={worktreePending}
      worktreeDisabled={state.loading || worktreeAvailable === null || worktreeAvailable === false}
      worktreeAvailable={worktreeAvailable !== false}
      worktreeUnavailableReason="当前项目不是 Git 仓库，Worktree 仅支持 Git 项目"
      onToggleWorktree={(checked) => { setWorktreePending(checked) }}
      onChooseTarget={() => undefined}
    />
  )
}
