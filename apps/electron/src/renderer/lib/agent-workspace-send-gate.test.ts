import { describe, expect, test } from 'bun:test'
import {
  resolveDeferredWorkspaceSend,
  shouldDeferWorkspaceSend,
} from './agent-workspace-send-gate.ts'

describe('agent workspace send gate', () => {
  test('Given a session target is still loading without a snapshot When the user submits Then the message waits instead of being dropped', () => {
    expect(shouldDeferWorkspaceSend({ hasSnapshot: false, loading: true })).toBeTrue()
    expect(resolveDeferredWorkspaceSend({ hasSnapshot: false, loading: true, errorMessage: null })).toBe('wait')
  })

  test('Given an authoritative target already exists When a background refresh is loading Then sending remains available', () => {
    expect(shouldDeferWorkspaceSend({ hasSnapshot: true, loading: true })).toBeFalse()
    expect(resolveDeferredWorkspaceSend({ hasSnapshot: true, loading: true, errorMessage: null })).toBe('send')
  })

  test('Given inspection completes with an unselected target When a message is waiting Then sending resumes so the normal bind flow can run', () => {
    expect(resolveDeferredWorkspaceSend({ hasSnapshot: false, loading: false, errorMessage: null })).toBe('send')
  })

  test('Given workspace inspection fails before a target is available When a message is waiting Then it stays in the composer instead of being sent against an unknown target', () => {
    expect(resolveDeferredWorkspaceSend({
      hasSnapshot: false,
      loading: false,
      errorMessage: 'Session Target 检查失败',
    })).toBe('fail')
  })
})
