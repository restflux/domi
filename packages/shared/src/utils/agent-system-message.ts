import type { SDKSystemMessage } from '../types/agent'

export type SDKCompactStatus = 'compacting' | 'success' | 'failed' | 'noop'

export function getSDKCompactStatus(message: SDKSystemMessage): SDKCompactStatus | undefined {
  if (message.subtype === 'compact_boundary') return 'success'
  if (message.subtype === 'compacting') return 'compacting'

  if (message.subtype !== 'status') return undefined
  if (message.compact_result === 'success' || message.compact_result === 'failed' || message.compact_result === 'noop') {
    return message.compact_result
  }
  if (message.status === 'compacting') return 'compacting'
  if (typeof message.compact_error === 'string' && message.compact_error.trim().length > 0) {
    return 'failed'
  }
  return undefined
}

export function isPersistableSDKSystemMessage(message: SDKSystemMessage): boolean {
  return message.subtype === 'permission_denied'
    || message.subtype === 'worktree_handoff_created'
    || message.subtype === 'worktree_ready_for_review'
    || message.subtype === 'worktree_next_iteration_requested'
    || message.subtype === 'worktree_preview_revision_requested'
    || getSDKCompactStatus(message) != null
}
