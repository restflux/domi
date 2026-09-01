import * as React from 'react'
import { WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'

export interface RightWorkspaceTitlebarDragRegionProps {
  isWindows: boolean
}

/**
 * 右侧工作区只保留顶部空白为窗口拖拽区。
 *
 * Windows 必须避让自定义窗口按钮，不能让整个侧栏根节点参与原生 hit-test，
 * 否则底层 drag 区会吞掉上层窗口按钮的点击。
 */
export function RightWorkspaceTitlebarDragRegion({
  isWindows,
}: RightWorkspaceTitlebarDragRegionProps): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-right-workspace-titlebar-drag-region=""
      className={cn(
        'pointer-events-none absolute left-0 top-0 h-[34px] titlebar-drag-region',
        isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0',
      )}
    />
  )
}
