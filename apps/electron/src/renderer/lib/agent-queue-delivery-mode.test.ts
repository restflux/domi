import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_AGENT_QUEUE_DELIVERY_MODE,
  normalizeAgentQueueDeliveryMode,
} from './agent-queue-delivery-mode'

describe('normalizeAgentQueueDeliveryMode', () => {
  test('accepts the supported delivery modes', () => {
    expect(normalizeAgentQueueDeliveryMode('one-at-a-time')).toBe('one-at-a-time')
    expect(normalizeAgentQueueDeliveryMode('all')).toBe('all')
  })

  test('normalizes missing, malformed, and legacy values to one-at-a-time', () => {
    for (const value of [undefined, null, '', 'oneAtATime', 'batch', 'followUp', 1, {}, []]) {
      expect(normalizeAgentQueueDeliveryMode(value)).toBe(DEFAULT_AGENT_QUEUE_DELIVERY_MODE)
    }
  })
})
