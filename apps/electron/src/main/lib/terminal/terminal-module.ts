import type { BrowserWindow } from 'electron'
import { TERMINAL_IPC_CHANNELS } from '@domi/shared'
import { getAgentSessionMeta } from '../agent-session-manager.ts'
import { resolveProductionAgentSessionTarget } from '../agent-session-target.ts'
import { buildAgentRuntimeEnv } from '../agent-runtime-env.ts'
import { getRuntimeStatus } from '../runtime-init.ts'
import { getSettings } from '../settings-service.ts'
import { TerminalSessionService, type TerminalOwnerContext } from './terminal-session-service.ts'
import { terminalRuntimeClient } from './terminal-runtime-client.ts'

export interface TerminalModuleOptions {
  getMainWindow: () => BrowserWindow | null
}

let terminalService: TerminalSessionService | null = null

export function configureTerminalModule(options: TerminalModuleOptions): TerminalSessionService {
  terminalService = new TerminalSessionService({
    runtime: terminalRuntimeClient,
    resolveOwner: resolveTerminalOwner,
    onOutput: (event) => send(options.getMainWindow(), TERMINAL_IPC_CHANNELS.OUTPUT, event),
    onStateChanged: (event) => send(options.getMainWindow(), TERMINAL_IPC_CHANNELS.STATE_CHANGED, event),
  })
  return terminalService
}

export function peekTerminalSessionService(): TerminalSessionService | null {
  return terminalService
}

export function getTerminalSessionService(): TerminalSessionService {
  if (!terminalService) throw new Error('TerminalModule 尚未初始化。')
  return terminalService
}

export async function disposeTerminalModule(): Promise<void> {
  const service = terminalService
  terminalService = null
  await service?.dispose()
}

async function resolveTerminalOwner(ownerSessionId: string): Promise<TerminalOwnerContext | undefined> {
  const session = getAgentSessionMeta(ownerSessionId)
  if (!session?.workspaceId) return undefined
  const target = await resolveProductionAgentSessionTarget({
    sessionId: ownerSessionId,
    agentCwdMode: session.agentCwdMode,
  })
  const runtimeEnv = buildAgentRuntimeEnv({
    runtimeStatus: getRuntimeStatus(),
    windowsShellPreference: getSettings().windowsShellPreference,
    processEnv: process.env,
  })
  return {
    ownerSessionId,
    source: session.sourceDelegationId
      ? 'delegation'
      : session.sourceAutomationId
        ? 'automation'
        : 'interactive',
    workspaceRoot: target.workspaceRoot,
    allowedCwdRoots: [target.workspaceRoot, ...(session.attachedDirectories ?? [])],
    target: {
      kind: target.lease.kind,
      ...(target.lease.kind === 'isolated' ? { checkoutId: target.lease.checkoutId } : {}),
      revision: target.lease.revision,
    },
    env: runtimeEnv.env,
  }
}

function send(window: BrowserWindow | null, channel: string, event: unknown): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, event)
}
