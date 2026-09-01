/** Agent ExitPlanMode 计划审批服务。 */

import { randomUUID } from 'node:crypto'
import type {
  ExitPlanAllowedPrompt,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ExecutionPolicyMode,
} from '@domi/shared'
import {
  normalizeSubmittedPlan,
  persistApprovedPlanSnapshot,
  persistCurrentPlan,
} from './agent-plan-sidecar.ts'

export interface ExitPlanRuntimeContext {
  executionPolicy: ExecutionPolicyMode
  planSidecarDir: string
  runToken: number
  isRunActive: () => boolean
}

export type ExitPlanPermissionResult =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
      workflow: 'direct'
      executionScope: 'run' | 'session'
    }
  | {
      behavior: 'deny'
      message: string
      workflow: 'plan-first'
      stop: boolean
    }

interface PendingExitPlan {
  resolve: (result: ExitPlanPermissionResult) => void
  request: ExitPlanModeRequest
  toolInput: Record<string, unknown>
  plan: string
  planSidecarDir: string
  runToken: number
  isRunActive: () => boolean
}

export interface ExitPlanResolution {
  sessionId: string
  workflow: 'direct' | 'plan-first'
  executionScope?: 'run' | 'session'
}

/** 管理 Pi Workflow 审批；默认只授权当前任务，明确选择后才持久切换到执行。 */
export class AgentExitPlanService {
  private pendingRequests = new Map<string, PendingExitPlan>()

  handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    context: ExitPlanRuntimeContext,
    signal: AbortSignal,
    sendToRenderer: (request: ExitPlanModeRequest) => void,
  ): Promise<ExitPlanPermissionResult> {
    if (signal.aborted) return Promise.resolve(this.denied('操作已中止', true))

    const plan = normalizeSubmittedPlan(input.plan)
    if (!plan) {
      return Promise.resolve(this.denied('请在 ExitPlanMode.plan 中提供非空的完整计划正文', false))
    }

    try {
      persistCurrentPlan(context.planSidecarDir, plan)
    } catch (error) {
      console.error('[Agent 计划] 写入 current-plan.md 失败:', error)
      return Promise.resolve(this.denied('计划文件写入失败，请检查会话工作台后重试', false))
    }

    const toolInput = { ...input, plan }
    const request: ExitPlanModeRequest = {
      requestId: randomUUID(),
      createdAt: Date.now(),
      sessionId,
      toolInput,
      allowedPrompts: this.parseAllowedPrompts(input),
      executionPolicy: context.executionPolicy,
    }

    sendToRenderer(request)
    return new Promise<ExitPlanPermissionResult>((resolve) => {
      this.pendingRequests.set(request.requestId, {
        resolve,
        request,
        toolInput,
        plan,
        planSidecarDir: context.planSidecarDir,
        runToken: context.runToken,
        isRunActive: context.isRunActive,
      })
      signal.addEventListener('abort', () => {
        if (!this.pendingRequests.delete(request.requestId)) return
        resolve(this.denied('操作已中止', true))
      }, { once: true })
    })
  }

  respondToExitPlanMode(response: ExitPlanModeResponse): ExitPlanResolution | null {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return null
    this.pendingRequests.delete(response.requestId)

    if (!pending.isRunActive()) {
      pending.resolve(this.denied('审批对应的 run 已结束，未授权执行', true))
      return { sessionId: pending.request.sessionId, workflow: 'plan-first' }
    }

    if (response.action === 'approve_current' || response.action === 'approve_and_switch') {
      try {
        persistApprovedPlanSnapshot(
          pending.planSidecarDir,
          pending.plan,
          new Date(),
          pending.request.requestId,
        )
      } catch (error) {
        // current-plan.md 已经是可访问的权威副本；历史快照失败不阻断用户批准。
        console.error('[Agent 计划] 写入获批计划快照失败:', error)
      }
      const executionScope = response.action === 'approve_and_switch' ? 'session' : 'run'
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.toolInput,
        workflow: 'direct',
        executionScope,
      })
      return { sessionId: pending.request.sessionId, workflow: 'direct', executionScope }
    }

    const message = response.action === 'feedback'
      ? response.feedback?.trim() || '用户要求修改计划'
      : '用户拒绝了计划'
    pending.resolve(this.denied(message, response.action === 'deny'))
    return { sessionId: pending.request.sessionId, workflow: 'plan-first' }
  }

  getPendingRequests(): ExitPlanModeRequest[] {
    return [...this.pendingRequests.values()].map((pending) => pending.request)
  }

  hasPendingRequest(sessionId: string): boolean {
    return [...this.pendingRequests.values()].some((pending) => pending.request.sessionId === sessionId)
  }

  clearSessionPending(sessionId: string, runToken?: number): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId !== sessionId) continue
      if (runToken !== undefined && pending.runToken !== runToken) continue
      pending.resolve(this.denied('会话已结束', true))
      this.pendingRequests.delete(requestId)
    }
  }

  private denied(message: string, stop: boolean): ExitPlanPermissionResult {
    return { behavior: 'deny', message, workflow: 'plan-first', stop }
  }

  private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
    if (!Array.isArray(input.allowedPrompts)) return []
    return input.allowedPrompts.filter((item): item is ExitPlanAllowedPrompt => (
      item !== null
      && typeof item === 'object'
      && (item as { tool?: unknown }).tool === 'Bash'
      && typeof (item as { prompt?: unknown }).prompt === 'string'
    ))
  }
}

export const exitPlanService = new AgentExitPlanService()
