import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { ChevronDown, LockKeyhole, PlugZap, Telescope, Upload, X, Zap } from 'lucide-react'
import type { AgentExecutionControlsUpdate, AgentWorkflow, NormalizedAgentExecutionSettings } from '@domi/shared'
import { cn } from '@/lib/utils.ts'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  agentExecutionControlsPendingMapAtom,
  agentSessionCapabilityGrantsAtomFamily,
  agentSessionCapabilityGrantsMapAtom,
  agentSessionExecutionControlsAtomFamily,
  agentSessionTemporaryExecutionAtomFamily,
  agentSessionsAtom,
} from '@/atoms/agent-atoms'
import { buildAgentWorkflowUpdate, formatExecutionControlsError } from '@/lib/agent-execution-controls.ts'
import { AGENT_WORKFLOW_DISPLAY_OPTIONS, getAgentWorkflowRuntimeDisplay } from '@/lib/agent-control-display.ts'

interface ExecutionControlsProps {
  sessionId: string
  /** 宿主 Session Target 覆盖持久工作方式时，展示当前真正生效的只读状态。 */
  forcedReadOnlyReason?: 'delivered' | 'retained' | 'preview_active'
}

type ModeIcon = React.ComponentType<{ className?: string }>

const MODE_ICONS: Record<'read-only' | 'direct', ModeIcon> = {
  'read-only': Telescope,
  direct: Zap,
}

export function ExecutionControls({ sessionId, forcedReadOnlyReason }: ExecutionControlsProps): React.ReactElement {
  const controls = useAtomValue(agentSessionExecutionControlsAtomFamily(sessionId))
  const temporaryExecution = useAtomValue(agentSessionTemporaryExecutionAtomFamily(sessionId))
  const grants = useAtomValue(agentSessionCapabilityGrantsAtomFamily(sessionId))
  const pushGrant = grants.find((grant) => grant.kind === 'git_push_current_source')
  const pendingMap = useAtomValue(agentExecutionControlsPendingMapAtom)
  const setPendingMap = useSetAtom(agentExecutionControlsPendingMapAtom)
  const setCapabilityGrantsMap = useSetAtom(agentSessionCapabilityGrantsMapAtom)
  const setSessions = useSetAtom(agentSessionsAtom)
  const [open, setOpen] = React.useState(false)
  const disabled = pendingMap.has(sessionId)

  React.useEffect(() => {
    let active = true
    void window.electronAPI.getSessionCapabilityGrants(sessionId)
      .then((nextGrants) => {
        if (!active) return
        setCapabilityGrantsMap((previous) => {
          const next = new Map(previous)
          if (nextGrants.length === 0) next.delete(sessionId)
          else next.set(sessionId, nextGrants)
          return next
        })
      })
      .catch(console.error)
    return () => { active = false }
  }, [sessionId, setCapabilityGrantsMap])

  const revokePushGrant = React.useCallback(async (): Promise<void> => {
    if (!pushGrant) return
    try {
      const nextGrants = await window.electronAPI.revokeSessionCapabilityGrant(sessionId, pushGrant.grantId)
      setCapabilityGrantsMap((previous) => {
        const next = new Map(previous)
        if (nextGrants.length === 0) next.delete(sessionId)
        else next.set(sessionId, nextGrants)
        return next
      })
      toast.success('已撤销代码上传授权')
    } catch (error) {
      toast.error('撤销代码上传授权失败', { description: formatExecutionControlsError(error) })
    }
  }, [pushGrant, sessionId, setCapabilityGrantsMap])

  const updateControls = React.useCallback(async (update: AgentExecutionControlsUpdate): Promise<void> => {
    const optimistic: NormalizedAgentExecutionSettings = { ...controls, ...update, executionPolicy: 'full-access' }
    setPendingMap((previous) => new Map(previous).set(sessionId, optimistic))
    try {
      const persisted = await window.electronAPI.updateSessionExecutionControls(sessionId, {
        ...update,
        executionPolicy: 'full-access',
      })
      setSessions((previous) => previous.map((session) => session.id === sessionId ? persisted : session))
    } catch (error) {
      toast.error('工作方式更新失败', { description: formatExecutionControlsError(error) })
    } finally {
      setPendingMap((previous) => {
        if (previous.get(sessionId) !== optimistic) return previous
        const next = new Map(previous)
        next.delete(sessionId)
        return next
      })
    }
  }, [controls, sessionId, setPendingMap, setSessions])

  const selectMode = (workflow: AgentWorkflow): void => {
    setOpen(false)
    void updateControls(buildAgentWorkflowUpdate(workflow))
  }

  const currentWorkflow = controls.workflow === 'direct' ? 'direct' : 'read-only'
  const preferredMode = getAgentWorkflowRuntimeDisplay(currentWorkflow, temporaryExecution)
  const forcedMode = forcedReadOnlyReason
    ? {
        kind: 'forced-read-only' as const,
        label: forcedReadOnlyReason === 'preview_active'
          ? '验收中 · 只读'
          : forcedReadOnlyReason === 'retained'
            ? '已保留 · 只读'
            : '已交付 · 只读',
        description: forcedReadOnlyReason === 'preview_active'
          ? '当前 Local Preview 正在验收，项目修改需要先撤回验收。会话附件生图等非项目操作仍可继续。'
          : '当前 Worktree 已交付或保留，项目修改需要创建下一轮 Worktree。会话附件生图等非项目操作仍可继续。',
      }
    : undefined
  const currentMode = forcedMode ?? preferredMode
  const isTemporaryExecution = !forcedMode && currentMode.kind === 'temporary-execute'
  const CurrentModeIcon = forcedMode ? LockKeyhole : isTemporaryExecution ? PlugZap : MODE_ICONS[currentWorkflow]
  const modeOptions = AGENT_WORKFLOW_DISPLAY_OPTIONS.filter((option) => option.value !== 'plan-first')

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                aria-label={`工作方式：${currentMode.label}${pushGrant ? `；代码上传授权：${pushGrant.remoteName}/${pushGrant.targetBranch}` : ''}`}
                title={forcedMode ? `当前生效：${forcedMode.label}；下一轮默认：${preferredMode.label}` : undefined}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
                  isTemporaryExecution && 'text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300',
                )}
              >
                <CurrentModeIcon className="size-3.5" />
                <span>{currentMode.label}</span>
                {pushGrant ? (
                  <span
                    data-session-capability-indicator="git-push"
                    className="flex size-4 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400"
                    title={`允许上传到 ${pushGrant.remoteName}/${pushGrant.targetBranch}`}
                  >
                    <Upload className="size-2.5" />
                  </span>
                ) : null}
                <ChevronDown className="size-3" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p>工作方式：{currentMode.label}</p>
            <p className={cn('mt-1 text-muted-foreground', isTemporaryExecution && 'text-amber-600 dark:text-amber-400')}>
              {currentMode.description}
            </p>
            {pushGrant ? <p className="mt-1 text-sky-600 dark:text-sky-400">代码上传授权：{pushGrant.remoteName}/{pushGrant.targetBranch}</p> : null}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[272px] p-1.5"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            工作方式
          </div>
          {forcedMode ? (
            <div className="mx-1 mb-1.5 rounded-md bg-amber-500/10 px-2 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              <p className="font-medium">当前生效：{forcedMode.label}</p>
              <p className="mt-0.5 text-muted-foreground">下一轮默认：{preferredMode.label}</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            {modeOptions.map((option) => {
              const workflow = option.value === 'direct' ? 'direct' : 'read-only'
              const active = currentWorkflow === workflow
              const OptionIcon = MODE_ICONS[workflow]
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant="ghost"
                  aria-pressed={active}
                  className={cn(
                    'h-auto justify-start rounded-md px-2.5 py-2 text-left',
                    active && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => selectMode(option.value)}
                >
                  <OptionIcon className="mr-2 mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">{option.label}</div>
                    <div className="mt-0.5 whitespace-normal text-[11px] font-normal leading-snug text-muted-foreground">
                      {isTemporaryExecution && workflow === 'read-only'
                        ? '立即结束本次执行并恢复只读调研'
                        : option.description}
                    </div>
                  </div>
                </Button>
              )
            })}
          </div>
          {pushGrant ? (
            <div className="mx-1 mt-1.5 rounded-md bg-sky-500/10 px-2 py-2 text-[11px]">
              <div className="flex items-start gap-2">
                <Upload className="mt-0.5 size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">允许上传到 {pushGrant.remoteName}/{pushGrant.targetBranch}</p>
                  <p className="mt-0.5 truncate text-muted-foreground">{pushGrant.remoteDisplay}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="撤销代码上传授权"
                  className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => { void revokePushGrant() }}
                >
                  <X className="size-3" />
                </Button>
              </div>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}
