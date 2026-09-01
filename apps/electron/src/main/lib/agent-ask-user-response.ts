import { randomUUID } from 'node:crypto'
import { DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY } from '@domi/shared'
import type { AskUserRequest, SDKMessage } from '@domi/shared'

export function extractDirectWorkflowAdjustment(
  request: AskUserRequest | null | undefined,
  answers: Record<string, string>,
): string | null {
  const presentation = request?.toolInput.presentation
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return null
  if ((presentation as Record<string, unknown>).kind !== 'direct-workflow') return null

  const value = answers[DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]
  if (typeof value !== 'string') return null
  const adjustment = value.trim()
  return adjustment || null
}

export function createDirectWorkflowAdjustmentUserMessage(
  adjustment: string,
  options: { uuid?: string; createdAt?: number } = {},
): SDKMessage {
  return {
    type: 'user',
    uuid: options.uuid ?? randomUUID(),
    message: {
      content: [{ type: 'text', text: adjustment }],
    },
    parent_tool_use_id: null,
    _createdAt: options.createdAt ?? Date.now(),
    _interactionKind: 'direct-workflow-adjustment',
  } as unknown as SDKMessage
}
