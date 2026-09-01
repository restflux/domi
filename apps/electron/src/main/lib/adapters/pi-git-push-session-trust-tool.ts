import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

interface GitPushSessionTrustToolContext {
  sessionId: string
  triggeredBy?: 'user' | 'automation' | 'delegation'
  sessionTarget?: {
    kind: 'local' | 'isolated'
    ownership: 'owner' | 'inherited'
    followupOnly?: boolean
  }
}

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/**
 * Full Access 已采用显式信任语义，普通 Bash push 不再需要额外 session grant。
 * 保留这个兼容 seam，避免旧进程内 grant/IPC 数据立刻迁移；新 Agent 不再暴露工具。
 */
export function shouldExposeGitPushSessionTrust(
  _ctx: Pick<GitPushSessionTrustToolContext, 'sessionTarget' | 'triggeredBy'>,
): boolean {
  return false
}

export function buildPiGitPushSessionTrustTools(
  _sdk: PiSdk,
  _ctx: GitPushSessionTrustToolContext,
): ToolDefinition[] {
  return []
}
