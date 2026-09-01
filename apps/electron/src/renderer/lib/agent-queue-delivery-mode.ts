import type { AgentQueueDeliveryMode } from '@/types/settings'

/** Native Pi queue delivery mode. The safe default consumes one queued item per turn. */
export const DEFAULT_AGENT_QUEUE_DELIVERY_MODE: AgentQueueDeliveryMode = 'one-at-a-time'

/**
 * Normalize persisted queue delivery settings at the renderer boundary.
 * Missing, legacy, and malformed values intentionally fall back to the safe default.
 */
export function normalizeAgentQueueDeliveryMode(value: unknown): AgentQueueDeliveryMode {
  return value === 'all' ? 'all' : DEFAULT_AGENT_QUEUE_DELIVERY_MODE
}

export type { AgentQueueDeliveryMode }
