import { bindAgentSessionTargetForLaunch } from './agent-session-target.ts'
import { SessionCheckoutError } from './session-checkout/index.ts'
import type { SessionCheckoutModule } from './session-checkout/index.ts'

export interface BridgeSessionTargetLaunchInput {
  sessionId: string
}

/** 无 renderer 选择器的 Bridge 运行统一显式绑定 Local。 */
export async function bindBridgeSessionTargetForLaunch(
  input: BridgeSessionTargetLaunchInput,
  checkout: Pick<SessionCheckoutModule, 'inspect' | 'bind'>,
): Promise<void> {
  try {
    await checkout.inspect(input.sessionId)
    return
  } catch (error) {
    if (!(error instanceof SessionCheckoutError) || error.code !== 'target_unselected') throw error
  }
  await bindAgentSessionTargetForLaunch(
    { ...input, choice: { kind: 'local' } },
    checkout,
  )
}

export async function bindProductionBridgeSessionTargetForLaunch(
  input: BridgeSessionTargetLaunchInput,
): Promise<void> {
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  await bindBridgeSessionTargetForLaunch(input, getSessionCheckoutModule())
}
