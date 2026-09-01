import { describe, expect, test } from 'bun:test'
import {
  isVisionRelaySourceEligible,
  isVisionRelayTargetEligible,
  shouldExposeVisionRelay,
} from './vision-relay-policy'

describe('Vision Relay capability policy', () => {
  test('only confirmed text-only source models are eligible', () => {
    expect(isVisionRelaySourceEligible('unsupported')).toBe(true)
    expect(isVisionRelaySourceEligible('supported')).toBe(false)
    expect(isVisionRelaySourceEligible('unknown')).toBe(false)
  })

  test('only confirmed image-capable target models are eligible', () => {
    expect(isVisionRelayTargetEligible('supported')).toBe(true)
    expect(isVisionRelayTargetEligible('unsupported')).toBe(false)
    expect(isVisionRelayTargetEligible('unknown')).toBe(false)
  })

  test('tool is exposed only for configured interactive user sessions with a text-only source', () => {
    const configured = { enabled: true, channelId: 'vision-channel', modelId: 'vision-model', authorizationVersion: 'v1' }
    expect(shouldExposeVisionRelay({ configured, sourceCapability: 'unsupported', triggeredBy: 'user' })).toBe(true)
    expect(shouldExposeVisionRelay({ configured, sourceCapability: 'supported', triggeredBy: 'user' })).toBe(false)
    expect(shouldExposeVisionRelay({ configured, sourceCapability: 'unknown', triggeredBy: 'user' })).toBe(false)
    expect(shouldExposeVisionRelay({ configured, sourceCapability: 'unsupported', triggeredBy: 'automation' })).toBe(false)
    expect(shouldExposeVisionRelay({ configured, sourceCapability: 'unsupported', triggeredBy: 'delegation' })).toBe(false)
    expect(shouldExposeVisionRelay({ configured, sourceCapability: 'unsupported' })).toBe(false)
    expect(shouldExposeVisionRelay({ configured: { enabled: false }, sourceCapability: 'unsupported', triggeredBy: 'user' })).toBe(false)
  })
})
