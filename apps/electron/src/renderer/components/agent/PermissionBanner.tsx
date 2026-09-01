/**
 * PermissionBanner — Agent 权限请求横幅
 *
 * 内联在 Agent 对话流底部，当有待处理的权限请求时显示。
 * 显示工具名、命令内容、危险等级，提供允许/拒绝/总是允许操作。
 * 支持队列模式：多个并发请求按 FIFO 逐个展示。
 *
 * 设计参考 Craft Agents OSS 的内联权限 UI。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Shield, ShieldAlert, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { allPendingPermissionRequestsAtom, agentStreamingStatesAtom, finalizeStreamingActivities } from '@/atoms/agent-atoms'
import type { DangerLevel, WorktreeRetentionMode } from '@domi/shared'
import { dispatchLocalMaintenanceResume } from '@/lib/local-maintenance-resume.ts'
import {
  createWorktreeApplyConflictResumeFromContinuation,
  dispatchWorktreeApplyConflictResume,
} from '@/lib/worktree-apply-conflict-resume.ts'

/** 危险等级对应的图标颜色 */
const DANGER_ICON_STYLES: Record<DangerLevel, string> = {
  safe: 'text-green-500',
  normal: 'text-primary',
  dangerous: 'text-amber-500',
}

/** 解析工具显示名称（MCP 工具显示 server / tool） */
function formatToolName(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1]} / ${parts.slice(2).join('__')}`
  }
  return toolName
}

/** PermissionBanner 属性接口 */
interface PermissionBannerProps {
  sessionId: string
}

export function PermissionBanner({ sessionId }: PermissionBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingPermissionRequestsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [responding, setResponding] = React.useState(false)
  const [finishCommitMessage, setFinishCommitMessage] = React.useState('')
  const [finishRetention, setFinishRetention] = React.useState<WorktreeRetentionMode>('cleanup')
  const respondRef = React.useRef<(behavior: 'allow' | 'deny', alwaysAllow?: boolean) => void>()

  const request = requests[0] ?? null
  const isFinishWorktree = request?.toolName === 'FinishWorktree'
  const isLocalMaintenance = request?.toolName === 'RequestLocalMaintenance'
  const isGitPushTrust = request?.sessionCapability?.kind === 'git_push_current_source'

  React.useEffect(() => {
    setFinishCommitMessage(isFinishWorktree && typeof request?.toolInput.commitMessage === 'string'
      ? request.toolInput.commitMessage
      : '')
    setFinishRetention(isFinishWorktree && (
      request?.toolInput.retention === 'retain_24h'
      || request?.toolInput.retention === 'retain_3d'
      || request?.toolInput.retention === 'retain_manual'
    ) ? request.toolInput.retention : 'cleanup')
  }, [request?.requestId, isFinishWorktree])

  // Enter 键快捷允许
  React.useEffect(() => {
    if (!request) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) return
      if (e.key === 'Enter') {
        e.preventDefault()
        respondRef.current?.('allow')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  /** 关闭权限请求 & 终止 Agent */
  const handleDismiss = (): void => {
    if (request?.deferred) {
      respondRef.current?.('deny')
      return
    }
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current || !current.running) return prev
      const map = new Map(prev)
      map.set(sessionId, {
        ...current,
        running: false,
        ...finalizeStreamingActivities(current.toolActivities),
      })
      return map
    })
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    window.electronAPI.stopAgent(sessionId, 'renderer-permission-dismiss').catch(console.error)
  }

  if (!request) return null

  const iconColor = DANGER_ICON_STYLES[request.dangerLevel]
  const isDangerous = request.dangerLevel === 'dangerous'
  const IconComponent = isDangerous ? ShieldAlert : Shield

  /** 响应权限请求 */
  const respond = async (behavior: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (responding) return
    setResponding(true)

    try {
      const result = await window.electronAPI.respondPermission({
        requestId: request.requestId,
        behavior,
        alwaysAllow,
        ...(isFinishWorktree && behavior === 'allow'
          ? { updatedInput: { commitMessage: finishCommitMessage, retention: finishRetention } }
          : {}),
      })
      if (!result.ok) {
        toast.error(
          isGitPushTrust
            ? '普通 Git push 会话授权失败'
            : isLocalMaintenance
              ? 'Local 维修确认已失效或开启失败'
              : 'Worktree 确认已失效或执行失败',
          { description: result.message },
        )
      } else if (isGitPushTrust && behavior === 'allow') {
        toast.success('已信任当前会话的普通 Git push', {
          description: `${request.sessionCapability!.remoteName}/${request.sessionCapability!.targetBranch}`,
        })
      } else if (request.deferred && behavior === 'allow') {
        if (result.continuation?.kind === 'local_maintenance' && result.sessionId) {
          dispatchLocalMaintenanceResume({
            sessionId: result.sessionId,
            requestId: result.continuation.requestId,
            transactionId: result.continuation.transactionId,
            goal: result.continuation.goal,
          })
        }
        if (result.continuation?.kind === 'worktree_apply_conflict' && result.sessionId) {
          dispatchWorktreeApplyConflictResume(createWorktreeApplyConflictResumeFromContinuation(result.sessionId, result.continuation))
        }
        if (result.continuation?.kind === 'worktree_apply_conflict') {
          toast.warning('检测到 Worktree 冲突，Local 未修改', { description: 'Domi 正在让原 Agent 自动继续解决冲突。' })
        } else {
          toast.success(isLocalMaintenance ? 'Local 维修事务已开启，正在自动继续' : isFinishWorktree ? 'Worktree 已提交并完成收口' : 'Worktree 已应用到 Local')
        }
      }
      // 确定性成功/失败会消费 snapshot-bound 请求；短暂 busy 则保留确认卡重试。
      if (result.consumed !== false) {
        setAllRequests((prev) => {
          const map = new Map(prev)
          const current = map.get(sessionId) ?? []
          const newValue = current.filter((r) => r.requestId !== request.requestId)
          if (newValue.length === 0) map.delete(sessionId)
          else map.set(sessionId, newValue)
          return map
        })
      }
    } catch (error) {
      console.error('[PermissionBanner] 响应失败:', error)
    } finally {
      setResponding(false)
    }
  }

  respondRef.current = respond

  return (
    <div
      className="mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <IconComponent className={`size-4 ${iconColor}`} />
          <span className="text-sm font-medium">
            {isGitPushTrust ? '信任本会话普通 Git push？' : isLocalMaintenance ? '开启 Local 维修事务？' : isFinishWorktree ? finishRetention === 'cleanup' ? '提交并清理？' : '提交并保留运行环境？' : isDangerous ? '危险操作需要确认' : '需要确认'}
          </span>
          {requests.length > 1 && (
            <span className="text-xs text-muted-foreground">
              (+{requests.length - 1})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground font-mono">
            {request.sdkDisplayName ?? formatToolName(request.toolName)}
          </span>
          <button
            type="button"
            className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
            onClick={handleDismiss}
            title={request.deferred ? '拒绝并关闭确认卡' : '关闭并终止 Agent'}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 命令/操作内容 */}
      <div className="px-3 pb-2 space-y-1.5">
        {isGitPushTrust ? (
          <div data-session-capability="git-push" className="space-y-1.5 rounded-lg bg-muted/35 px-2.5 py-2 text-xs">
            <p>
              允许当前会话把 managed Worktree 的 <span className="font-mono">HEAD</span> 普通推送到
              {' '}<span className="font-medium">{request.sessionCapability!.remoteName}/{request.sessionCapability!.targetBranch}</span>
              {' '}（{request.sessionCapability!.remoteDisplay}）。
            </p>
            <pre className="overflow-x-auto rounded bg-background/60 px-2 py-1 font-mono text-[11px]">
              {request.sessionCapability!.recommendedCommand}
            </pre>
            <p className="text-[11px] text-muted-foreground">
              仅当前会话有效；remote、目标分支或 Worktree 变化即失效。强推、删除、批量推送、发布部署和 Local 写回仍需单独确认。
            </p>
          </div>
        ) : null}
        {/* SDK 可读标题（优先展示，描述操作意图） */}
        {request.sdkTitle && (
          <p className="text-xs text-foreground">{request.sdkTitle}</p>
        )}
        {/* SDK 详细描述（与标题不同时才展示） */}
        {request.sdkDescription && request.sdkDescription !== request.sdkTitle && (
          <p className="text-xs text-muted-foreground">{request.sdkDescription}</p>
        )}
        {request.policy ? (
          <div data-policy-explanation className="space-y-1 rounded-lg bg-muted/35 px-2.5 py-2 text-[11px]">
            <p><span className="text-muted-foreground">分类：</span><span className="font-mono">{request.policy.category}</span></p>
            <p className="text-foreground">{request.policy.reason}</p>
            <p className="text-muted-foreground">
              Execution Policy：<span className="font-mono">{request.policy.executionPolicy}</span>
              {' · '}Workflow：<span className="font-mono">{request.policy.workflow}</span>
              {' · '}Scope：<span className="font-mono">{request.policy.scope}</span>
            </p>
            <p className="text-muted-foreground">判定：<span className="font-mono">{request.policy.decisionCode}</span></p>
          </div>
        ) : null}
        {isLocalMaintenance ? (
          <div className="space-y-1.5 rounded bg-amber-500/5 p-2 text-xs text-muted-foreground">
            <p>事务不会切换 Session Target。Domi 会先保存 dirty Local 的 HEAD、branch、index、working tree patch 与 untracked 恢复 artifacts。</p>
            <p>批准后 Domi 会自动续跑当前 Agent，并仅开放 Local 项目内受控写入、测试与普通 git add/commit；reset/clean/restore、删除、项目外写入和后台进程仍被阻止。</p>
            {typeof request.toolInput.goal === 'string' ? <p className="text-foreground">目标：{request.toolInput.goal}</p> : null}
          </div>
        ) : isFinishWorktree ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Domi 只会提交本轮 Worktree 增量。默认提交后清理临时 Worktree；后续仍可在当前会话创建新一轮修改。</p>
            <Textarea
              value={finishCommitMessage}
              onChange={(event) => setFinishCommitMessage(event.target.value)}
              placeholder={'提交标题\n\n- 具体变更一\n- 具体变更二'}
              rows={6}
              maxLength={500}
              autoFocus
              className="scrollbar-thin min-h-[132px] max-h-[240px] resize-none overflow-y-auto font-mono text-sm [field-sizing:content]"
            />
            <p className="text-right text-[11px] text-muted-foreground">首行作为标题，空行后可列详细说明 · {finishCommitMessage.length}/500</p>
            <label className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-2 text-xs">
              <input
                type="checkbox"
                checked={finishRetention !== 'cleanup'}
                onChange={(event) => setFinishRetention(event.target.checked ? 'retain_24h' : 'cleanup')}
                className="size-3.5 accent-primary"
              />
              <span>提交后暂时保留当前运行环境</span>
            </label>
            {finishRetention !== 'cleanup' ? (
              <div className="space-y-1.5 rounded-md bg-muted/40 p-2.5">
                <select
                  value={finishRetention}
                  onChange={(event) => setFinishRetention(event.target.value as WorktreeRetentionMode)}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="retain_24h">保留 24 小时</option>
                  <option value="retain_3d">保留 3 天</option>
                  <option value="retain_manual">手动清理</option>
                </select>
                <p className="text-[11px] text-muted-foreground">仅用于保留依赖、构建产物或调试现场；后续修改仍会创建新的 Worktree。</p>
              </div>
            ) : null}
          </div>
        ) : request.command ? (
          <pre className="text-xs font-mono bg-background/50 rounded px-2 py-1.5 overflow-x-auto scrollbar-thin whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
            {request.command}
          </pre>
        ) : !request.sdkTitle && !isGitPushTrust && Object.keys(request.toolInput).length > 0 ? (
          <pre className="text-xs font-mono bg-background/50 rounded px-2 py-1.5 overflow-x-auto scrollbar-thin whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
            {JSON.stringify(request.toolInput, null, 2)}
          </pre>
        ) : !request.sdkTitle && !isGitPushTrust ? (
          <p className="text-xs text-muted-foreground">
            {request.description}
          </p>
        ) : null}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center justify-end gap-1.5 px-3 pb-2.5">
        <span className="text-[10px] text-muted-foreground/40 mr-auto">
          Enter 允许
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => respond('deny')}
          disabled={responding}
          className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
        >
          <X className="size-3 mr-1" />
          拒绝
        </Button>

        {!isGitPushTrust && request.allowAlways !== false && <Button
          variant="outline"
          size="sm"
          onClick={() => respond('allow', true)}
          disabled={responding}
          className="h-7 px-3 text-xs"
        >
          本次会话总是允许
        </Button>}

        <Button
          variant="default"
          size="sm"
          onClick={() => respond('allow')}
          disabled={responding || (isFinishWorktree && !finishCommitMessage.trim())}
          className="h-7 px-3 text-xs"
        >
          <Check className="size-3 mr-1" />
          {isGitPushTrust ? '信任本会话普通 Push' : isLocalMaintenance ? '确认开启维修事务' : isFinishWorktree ? finishRetention === 'cleanup' ? '确认提交并清理' : '确认提交并保留环境' : '允许'}
        </Button>
      </div>
    </div>
  )
}
