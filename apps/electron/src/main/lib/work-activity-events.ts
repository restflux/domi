import { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@domi/shared'

let hostInvalidationListener: (() => void) | null = null
let presenceListener: ((activeSessionId: string | null) => void) | null = null

/** 注册宿主侧投影失效观察者；通知协调器与 Renderer 共享同一失效事实。 */
export function setWorkActivityHostInvalidationListener(listener: (() => void) | null): void {
  hostInvalidationListener = listener
}

export function setWorkActivityPresenceListener(listener: ((activeSessionId: string | null) => void) | null): void {
  presenceListener = listener
}

export function reportWorkActivityPresence(activeSessionId: string | null): void {
  presenceListener?.(activeSessionId)
}

/** 广播无载荷失效信号；Renderer 必须重新读取宿主投影，不能把事件本身当状态。 */
export function broadcastWorkActivityChanged(): void {
  hostInvalidationListener?.()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(AGENT_IPC_CHANNELS.WORK_ACTIVITY_CHANGED)
    }
  }
}
