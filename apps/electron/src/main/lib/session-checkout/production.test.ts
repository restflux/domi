import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@domi/shared'
import { resolveUnboundSessionTargetPolicy } from './unbound-session-target-policy.ts'

function session(overrides: Partial<AgentSessionMeta>): AgentSessionMeta {
  return {
    id: 'session-a',
    title: '会话 A',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('production Session Checkout lookup policy', () => {
  test('新 Pi unselected 会话不能被隐式降级为 Local', () => {
    expect(resolveUnboundSessionTargetPolicy(session({
      sessionTarget: { kind: 'unselected' },
    }))).toBe('unselected')
  })

  test('显式 isolated 意图在 registry 丢失时不能静默降级为 Local', () => {
    expect(resolveUnboundSessionTargetPolicy(session({
      sessionTarget: { kind: 'isolated', checkoutId: 'checkout-a' },
    }))).toBe('unselected')
  })

  test('历史缺字段会话保持 Local 兼容', () => {
    expect(resolveUnboundSessionTargetPolicy(session({}))).toBe('local')
  })


})
