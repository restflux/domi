import { createHash, randomUUID } from 'node:crypto'
import type { BrowserProfileKind } from '@domi/shared'

export type BrowserSessionSource = 'interactive' | 'automation' | 'delegation'

export interface BrowserProfileInput {
  workspaceId: string
  source: BrowserSessionSource
  ownerSessionId?: string
}

export interface BrowserProfileSelection {
  kind: BrowserProfileKind
  partition: string
}

export function resolveBrowserProfile(input: BrowserProfileInput): BrowserProfileSelection {
  if (input.source === 'interactive') {
    const digest = createHash('sha256').update(`workspace:${input.workspaceId}`).digest('hex').slice(0, 32)
    return { kind: 'project', partition: `persist:domi-browser-${digest}` }
  }

  const runKey = input.ownerSessionId || randomUUID()
  const digest = createHash('sha256')
    .update(`${input.source}:${input.workspaceId}:${runKey}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 32)
  return { kind: 'temporary', partition: `domi-browser-temp-${digest}` }
}
