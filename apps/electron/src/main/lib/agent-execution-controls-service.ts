import type {
  AgentExecutionControlsUpdate,
  AgentSessionMeta,
  AgentWorkflow,
  ExecutionPolicyMode,
} from '@domi/shared'
import {
  isAgentWorkflow,
  isExecutionPolicyMode,
} from '@domi/shared'

export interface AgentExecutionControlsDependencies {
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  persist: (sessionId: string, controls: AgentExecutionControlsUpdate) => AgentSessionMeta
  isActive: (sessionId: string) => boolean
  hasPendingExitPlan: (sessionId: string) => boolean
  rememberExecutionPolicy: (executionPolicy: ExecutionPolicyMode) => void
  rememberWorkflow: (workflow: AgentWorkflow) => void
  updateRuntime: (sessionId: string, controls: AgentExecutionControlsUpdate) => Promise<void>
  clearSessionCapabilities: (sessionId: string) => void
}

/** 主进程对 renderer Execution Controls 的验证、持久化和热更新边界。 */
export class AgentExecutionControlsService {
  constructor(private readonly dependencies: AgentExecutionControlsDependencies) {}

  async updateSessionExecutionControls(
    sessionId: string,
    controls: AgentExecutionControlsUpdate,
  ): Promise<AgentSessionMeta> {
    const session = this.dependencies.getSession(sessionId)
    if (!session) throw new Error(`Agent 会话不存在: ${sessionId}`)
    if (!controls || typeof controls !== 'object') throw new Error('Execution Controls 更新必须是对象')

    if (controls.executionPolicy !== undefined && !isExecutionPolicyMode(controls.executionPolicy)) {
      throw new Error(`无效的 Execution Policy: ${String(controls.executionPolicy)}`)
    }
    if (controls.workflow !== undefined && !isAgentWorkflow(controls.workflow)) {
      throw new Error(`无效的 Workflow: ${String(controls.workflow)}`)
    }
    if (controls.executionPolicy === undefined && controls.workflow === undefined) {
      throw new Error('Execution Controls 更新不能为空')
    }
    if (controls.workflow === 'direct' && this.dependencies.hasPendingExitPlan(sessionId)) {
      throw new Error('计划审批仍在等待处理，不能通过切换 Direct 绕过当前审批')
    }

    const validatedControls: AgentExecutionControlsUpdate = {
      // Legacy policy values remain valid IPC inputs, but the two-mode product model
      // always persists Execute/Research with Full Access underneath.
      ...(controls.executionPolicy && { executionPolicy: 'full-access' as const }),
      ...(controls.workflow && { workflow: controls.workflow === 'plan-first' ? 'read-only' as const : controls.workflow }),
    }
    const persisted = this.dependencies.persist(sessionId, validatedControls)
    if (validatedControls.executionPolicy) {
      this.dependencies.rememberExecutionPolicy(validatedControls.executionPolicy)
    }
    if (validatedControls.workflow) {
      this.dependencies.rememberWorkflow(validatedControls.workflow)
    }
    if (this.dependencies.isActive(sessionId)) {
      await this.dependencies.updateRuntime(sessionId, validatedControls)
    }
    return persisted
  }
}
