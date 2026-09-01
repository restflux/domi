/**
 * useOpenPreview — 统一的预览入口 Hook。
 *
 * 文件状态写入后直接打开 Right Workspace 的临时 Preview，连续选择文件会复用同一工具。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { previewFileMapAtom, type PreviewFile } from '@/atoms/preview-atoms'
import { agentDiffPanelTabAtom } from '@/atoms/agent-atoms'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms'

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile) => {
      store.set(previewFileMapAtom, (current) => {
        const next = new Map(current)
        next.set(sessionId, file)
        return next
      })
      store.set(rightWorkspaceSessionStateMapAtom, (current) => (
        activateSessionRightWorkspaceTab(current, sessionId, 'preview')
      ))
      store.set(agentDiffPanelTabAtom, (current) => {
        if (current.get(sessionId) !== 'chat') return current
        const next = new Map(current)
        next.set(sessionId, 'files')
        return next
      })
      store.set(rightWorkspaceOpenAtom, true)
    },
    [store],
  )
}
