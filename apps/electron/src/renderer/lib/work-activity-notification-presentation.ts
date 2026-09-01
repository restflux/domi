import type {
  AgentSessionMeta,
  WorkActivityNotificationEvent,
  WorkActivityNotificationTarget,
} from '@domi/shared'

export type WorkActivityNotificationNavigation =
  | { type: 'work_activity' }
  | { type: 'session'; sessionId: string; title: string }

export function resolveWorkActivityNotificationNavigation(
  target: WorkActivityNotificationTarget,
  sessions: Pick<AgentSessionMeta, 'id' | 'title'>[],
): WorkActivityNotificationNavigation {
  if (target.type === 'work_activity') return { type: 'work_activity' }
  return {
    type: 'session',
    sessionId: target.rootSessionId,
    title: sessions.find((session) => session.id === target.rootSessionId)?.title ?? 'Agent 会话',
  }
}

/** system 通知由 Main 呈现，Renderer 只镜像声音；toast 才显示应用内卡片。 */
export function shouldPresentWorkActivityToast(event: WorkActivityNotificationEvent): boolean {
  return event.channel === 'toast'
}
