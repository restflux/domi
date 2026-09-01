import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import {
  internalWorkActivityRefreshVersionAtom,
  workActivityLoadingAtom,
  workActivityProjectionAtom,
  workActivityRefreshErrorAtom,
  workActivityRefreshingAtom,
} from '@/atoms/work-activity-atoms'
import { createSingleFlightRefresh } from '@/components/work-activity/work-activity-refresh'
import { describeWorkActivityRefreshError } from '@/components/work-activity/work-activity-view-model'

/**
 * 主窗口唯一的 Work Activity 数据入口。
 *
 * - 进入 Work 模式时读取一次宿主投影；Chat 模式不做无用扫描；
 * - Work 模式中的宿主失效事件、窗口重新聚焦和显式重试共用同一个 single-flight；
 * - 不做常驻轮询，避免侧栏与中央页分别扫描全部历史会话；
 * - 读取失败时保留最后一份有效投影。
 */
export function useGlobalWorkActivity(): void {
  const store = useStore()
  const mode = useAtomValue(appModeAtom)
  const refreshVersion = useAtomValue(internalWorkActivityRefreshVersionAtom)
  const workModeActiveRef = React.useRef(false)
  const handledRefreshVersionRef = React.useRef(refreshVersion)
  const refresh = React.useMemo(() => createSingleFlightRefresh(async () => {
    store.set(workActivityRefreshingAtom, true)
    try {
      const projection = await window.electronAPI.getWorkActivity()
      store.set(workActivityProjectionAtom, projection)
      store.set(workActivityRefreshErrorAtom, null)
    } catch (error) {
      console.error('[工作动态] 刷新失败:', error)
      store.set(workActivityRefreshErrorAtom, describeWorkActivityRefreshError(error))
    } finally {
      store.set(workActivityLoadingAtom, false)
      store.set(workActivityRefreshingAtom, false)
    }
  }), [store])

  React.useEffect(() => {
    if (mode !== 'agent') {
      workModeActiveRef.current = false
      handledRefreshVersionRef.current = refreshVersion
      return
    }
    if (!workModeActiveRef.current) {
      workModeActiveRef.current = true
      handledRefreshVersionRef.current = refreshVersion
      void refresh()
      return
    }
    if (handledRefreshVersionRef.current !== refreshVersion) {
      handledRefreshVersionRef.current = refreshVersion
      void refresh()
    }
  }, [mode, refresh, refreshVersion])

  React.useEffect(() => {
    const onChanged = window.electronAPI.onWorkActivityChanged
    const refreshIfWorkMode = (): void => {
      if (store.get(appModeAtom) === 'agent') void refresh()
    }
    const cleanupChanged = typeof onChanged === 'function'
      ? onChanged(refreshIfWorkMode)
      : () => undefined
    const handleFocus = refreshIfWorkMode
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshIfWorkMode()
    }
    const now = new Date()
    const nextDay = new Date(now)
    nextDay.setHours(24, 0, 1, 0)
    const midnightTimer = window.setTimeout(refreshIfWorkMode, nextDay.getTime() - now.getTime())

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      cleanupChanged()
      window.clearTimeout(midnightTimer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [refresh])
}
