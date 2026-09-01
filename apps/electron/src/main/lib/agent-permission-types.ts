import type { PermissionRequest } from '@domi/shared'
import type { AgentToolAnnotations } from './agent-tool-annotations.ts'

/** SDK PermissionBehavior */
type PermissionBehavior = 'allow' | 'deny'

/** SDK PermissionUpdateDestination */
type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'

interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate = {
  type: 'addRules' | 'replaceRules' | 'removeRules'
  rules: PermissionRuleValue[]
  behavior: PermissionBehavior
  destination: PermissionUpdateDestination
} | {
  type: 'setMode'
  mode: string
  destination: PermissionUpdateDestination
} | {
  type: 'addDirectories' | 'removeDirectories'
  directories: string[]
  destination: PermissionUpdateDestination
}

type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject'

export type PermissionResult = {
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  toolUseID?: string
  decisionClassification?: PermissionDecisionClassification
} | {
  behavior: 'deny'
  message: string
  interrupt?: boolean
  toolUseID?: string
  decisionClassification?: PermissionDecisionClassification
  stop?: boolean
}

export interface CanUseToolOptions {
  signal: AbortSignal
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  decisionReasonType?: string
  classifierApprovable?: boolean
  toolUseID: string
  agentID?: string
  title?: string
  displayName?: string
  description?: string
  toolSource?: 'host' | 'product' | 'builtin-mcp' | 'mcp' | 'resource'
  toolAnnotations?: AgentToolAnnotations
  policy?: PermissionRequest['policy']
}
