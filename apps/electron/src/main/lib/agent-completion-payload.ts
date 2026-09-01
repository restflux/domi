import { AGENT_IPC_CHANNELS } from '@domi/shared'
import type {
  AgentSendInput,
  AgentStreamCompletePayload,
} from '@domi/shared'

export type AgentStreamCompletionDetails = Omit<
  AgentStreamCompletePayload,
  'sessionId' | 'triggeredBy'
>

export interface AgentStreamCompleteTarget {
  send(channel: string, payload: AgentStreamCompletePayload): void
}

export function buildAgentStreamCompletePayload(
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  details: AgentStreamCompletionDetails = {},
): AgentStreamCompletePayload {
  return {
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
    ...details,
  }
}

export function sendAgentStreamComplete(
  target: AgentStreamCompleteTarget,
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  details: AgentStreamCompletionDetails = {},
): void {
  target.send(
    AGENT_IPC_CHANNELS.STREAM_COMPLETE,
    buildAgentStreamCompletePayload(run, details),
  )
}
