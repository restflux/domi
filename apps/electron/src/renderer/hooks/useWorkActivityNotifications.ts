import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { WorkActivityNotificationEvent, WorkActivityNotificationTarget } from '@domi/shared'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { notificationSoundsAtom, playNotificationSoundForType } from '@/atoms/notifications'
import { useOpenSession } from './useOpenSession'
import {
  resolveWorkActivityNotificationNavigation,
  shouldPresentWorkActivityToast,
} from '@/lib/work-activity-notification-presentation'

export function useWorkActivityNotifications(): void {
  const sessions = useAtomValue(agentSessionsAtom)
  const sounds = useAtomValue(notificationSoundsAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const openSession = useOpenSession()

  const navigate = React.useCallback((target: WorkActivityNotificationTarget): void => {
    const navigation = resolveWorkActivityNotificationNavigation(target, sessions)
    if (navigation.type === 'work_activity') {
      setAppMode('agent')
      setActiveView('work-activity')
      return
    }
    openSession('agent', navigation.sessionId, navigation.title)
  }, [openSession, sessions, setActiveView, setAppMode])

  React.useEffect(() => {
    const unsubscribeDelivery = window.electronAPI.onWorkActivityNotification((event: WorkActivityNotificationEvent) => {
      const { notification } = event
      if (notification.playSound) {
        void playNotificationSoundForType(notification.soundType, sounds)
      }
      // system channel 仅镜像通知音；可见文案由 Main 的原生系统通知呈现。
      if (!shouldPresentWorkActivityToast(event)) return

      const show = notification.kind === 'attention' ? toast.warning : toast.success
      show(notification.title, {
        description: notification.body,
        duration: notification.kind === 'attention' ? 8_000 : 5_000,
        action: {
          label: notification.target.type === 'work_activity' ? '查看全部' : '查看会话',
          onClick: () => navigate(notification.target),
        },
      })
    })
    const unsubscribeNavigate = window.electronAPI.onWorkActivityNotificationNavigate(navigate)
    return () => {
      unsubscribeDelivery()
      unsubscribeNavigate()
    }
  }, [navigate, sounds])
}

export function WorkActivityNotificationInitializer(): null {
  useWorkActivityNotifications()
  return null
}
