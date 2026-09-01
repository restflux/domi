import type { AgentStreamPayload, ExitPlanModeResponse } from '@domi/shared'
import type { ExitPlanResolution } from './agent-exit-plan-service'

interface AskUserResponder {
  respondToAskUser(requestId: string, answers: Record<string, string>): string | null
}

interface ExitPlanResponder {
  respondToExitPlanMode(response: ExitPlanModeResponse): ExitPlanResolution | null
}

interface InteractionEventBus {
  emit(sessionId: string, payload: AgentStreamPayload): void
}

interface AgentInteractionResponseServiceOptions {
  askUser: AskUserResponder
  exitPlan: ExitPlanResponder
  eventBus: InteractionEventBus
  onChanged: () => void
}

/** 桌面端与各 IM 共用的回答入口，确保首个有效回答胜出并同步 resolved 事件。 */
export class AgentInteractionResponseService {
  constructor(private readonly options: AgentInteractionResponseServiceOptions) {}

  respondAskUser(requestId: string, answers: Record<string, string>): boolean {
    const sessionId = this.options.askUser.respondToAskUser(requestId, answers)
    if (!sessionId) return false
    this.options.onChanged()
    this.options.eventBus.emit(sessionId, {
      kind: 'domi_event',
      event: { type: 'ask_user_resolved', requestId },
    })
    return true
  }

  respondExitPlan(response: ExitPlanModeResponse): boolean {
    const resolution = this.options.exitPlan.respondToExitPlanMode(response)
    if (!resolution) return false
    this.options.onChanged()
    this.options.eventBus.emit(resolution.sessionId, {
      kind: 'domi_event',
      event: { type: 'exit_plan_mode_resolved', requestId: response.requestId },
    })
    return true
  }
}
