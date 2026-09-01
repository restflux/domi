import { describe, expect, test } from 'bun:test'
import type { SessionTargetBindChoice, SessionTargetView } from '@domi/shared'
import { SessionCheckoutError } from './session-checkout/index.ts'
import { bindBridgeSessionTargetForLaunch } from './bridge-session-target.ts'

const localView: SessionTargetView = {
  project: { id: 'project-1', name: 'Domi' },
  checkout: { id: 'local:project-1', kind: 'local', label: 'Local Checkout', phase: 'ready' },
  source: { ref: 'refs/heads/main', oid: 'abcdef0123456789' },
  current: { branch: 'main', oid: 'abcdef0123456789' },
  ownership: 'owner',
  dirty: false,
  revision: 1,
}

describe('Bridge Session Target launch', () => {
  test('Given a headless Bridge Pi session When launch is prepared Then Local is explicitly bound before run', async () => {
    const calls: Array<{ sessionId: string; choice: SessionTargetBindChoice }> = []

    await bindBridgeSessionTargetForLaunch(
      { sessionId: 'bridge-session' },
      {
        inspect: async () => {
          throw new SessionCheckoutError('target_unselected', '会话尚未选择 Session Target')
        },
        bind: async (sessionId, choice) => {
          calls.push({ sessionId, choice })
          return localView
        },
      },
    )

    expect(calls).toEqual([{ sessionId: 'bridge-session', choice: { kind: 'local' } }])
  })

  test('Given a Bridge Pi session already owns an Isolated target When launch is prepared Then its existing target is preserved', async () => {
    let bindCalls = 0

    await bindBridgeSessionTargetForLaunch(
      { sessionId: 'isolated-session' },
      {
        inspect: async () => ({
          ...localView,
          checkout: { id: 'isolated-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'ready' },
        }),
        bind: async () => {
          bindCalls += 1
          return localView
        },
      },
    )

    expect(bindCalls).toBe(0)
  })
})
