import { BrowserWindow, Notification } from 'electron'
import { AGENT_IPC_CHANNELS, type WorkActivityNotificationEvent, type WorkActivityNotificationTarget } from '@domi/shared'
import { getWorkActivityNotificationStatePath } from './config-paths.ts'
import { getSettings } from './settings-service.ts'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file.ts'
import { getWorkActivityProjection } from './work-activity-service.ts'
import {
  setWorkActivityHostInvalidationListener,
  setWorkActivityPresenceListener,
} from './work-activity-events.ts'
import {
  WorkActivityNotificationCoordinator,
  type WorkActivityNotificationDelivery,
  type WorkActivityNotificationPersistedState,
} from './work-activity-notification-coordinator.ts'

interface WorkActivityNotificationServiceOptions {
  getMainWindow: () => BrowserWindow | null
  showAndFocusMainWindow: () => void
}

const DEFAULT_STATE: WorkActivityNotificationPersistedState = {
  version: 1,
  initialized: false,
  handled: {},
  pendingCompletions: [],
}

let coordinator: WorkActivityNotificationCoordinator | null = null
const nativeNotifications = new Set<Notification>()

function loadPersistedState(): { exists: boolean; state: WorkActivityNotificationPersistedState } {
  const path = getWorkActivityNotificationStatePath()
  const parsed = readJsonFileSafe<Partial<WorkActivityNotificationPersistedState>>(path)
  if (!parsed || parsed.version !== 1 || typeof parsed.handled !== 'object' || !Array.isArray(parsed.pendingCompletions)) {
    return { exists: false, state: DEFAULT_STATE }
  }
  return {
    exists: true,
    state: {
      version: 1,
      initialized: parsed.initialized === true,
      handled: Object.fromEntries(Object.entries(parsed.handled ?? {}).filter((entry): entry is [string, number] => (
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
      ))),
      pendingCompletions: parsed.pendingCompletions.filter((item) => (
        item
        && typeof item.key === 'string'
        && typeof item.rootSessionId === 'string'
        && typeof item.title === 'string'
        && typeof item.workspaceName === 'string'
        && (item.source === 'manual' || item.source === 'automation')
        && (item.sessionIds === undefined || (Array.isArray(item.sessionIds) && item.sessionIds.every((id) => typeof id === 'string')))
        && typeof item.queuedAt === 'number'
        && typeof item.deliverAt === 'number'
      )).map((item) => ({
        ...item,
        sessionIds: item.sessionIds ?? [item.rootSessionId],
      })),
    },
  }
}

function sendRendererEvent(win: BrowserWindow | null, event: WorkActivityNotificationEvent): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(AGENT_IPC_CHANNELS.WORK_ACTIVITY_NOTIFICATION, event)
}

function sendNavigation(win: BrowserWindow | null, target: WorkActivityNotificationTarget): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const send = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(AGENT_IPC_CHANNELS.WORK_ACTIVITY_NOTIFICATION_NAVIGATE, target)
    }
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

function deliverNotification(
  delivery: WorkActivityNotificationDelivery,
  options: WorkActivityNotificationServiceOptions,
): void {
  const win = options.getMainWindow()
  const rendererEvent = delivery as WorkActivityNotificationEvent

  if (delivery.channel === 'toast') {
    sendRendererEvent(win, rendererEvent)
    return
  }

  // Renderer 复用现有 Web Audio 通知音；channel=system 时只播放声音，不再显示 Toast。
  if (delivery.notification.playSound) sendRendererEvent(win, rendererEvent)

  if (!Notification.isSupported()) return
  const native = new Notification({
    title: delivery.notification.title,
    body: delivery.notification.body,
    silent: true,
  })
  nativeNotifications.add(native)
  native.on('click', () => {
    options.showAndFocusMainWindow()
    sendNavigation(options.getMainWindow(), delivery.notification.target)
  })
  native.on('close', () => nativeNotifications.delete(native))
  native.show()
}

export async function startWorkActivityNotificationService(
  options: WorkActivityNotificationServiceOptions,
): Promise<void> {
  if (coordinator) return
  const instance = new WorkActivityNotificationCoordinator({
    now: Date.now,
    getProjection: getWorkActivityProjection,
    getSettings: () => {
      const settings = getSettings()
      return {
        notificationsEnabled: settings.notificationsEnabled ?? true,
        attentionNotificationsEnabled: settings.workActivityAttentionNotificationsEnabled ?? true,
        completionNotificationsEnabled: settings.workActivityCompletionNotificationsEnabled ?? true,
        soundEnabled: settings.notificationSoundEnabled ?? true,
      }
    },
    getWindowState: () => {
      const win = options.getMainWindow()
      return {
        visible: Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
        focused: Boolean(win && !win.isDestroyed() && win.isFocused()),
      }
    },
    loadState: loadPersistedState,
    saveState: (state) => writeJsonFileAtomic(getWorkActivityNotificationStatePath(), state),
    deliver: (delivery) => deliverNotification(delivery, options),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
    completionMergeWindowMs: 10_000,
  })
  coordinator = instance
  setWorkActivityHostInvalidationListener(() => {
    void instance.evaluateNow().catch((error) => {
      console.error('[Work Activity 通知] 投影对账失败:', error)
    })
  })
  setWorkActivityPresenceListener((activeSessionId) => instance.updatePresence({ activeSessionId }))
  try {
    await instance.start()
  } catch (error) {
    coordinator = null
    setWorkActivityHostInvalidationListener(null)
    setWorkActivityPresenceListener(null)
    throw error
  }
}

export function disposeWorkActivityNotificationService(): void {
  setWorkActivityHostInvalidationListener(null)
  setWorkActivityPresenceListener(null)
  coordinator?.dispose()
  coordinator = null
  for (const notification of nativeNotifications) notification.close()
  nativeNotifications.clear()
}
