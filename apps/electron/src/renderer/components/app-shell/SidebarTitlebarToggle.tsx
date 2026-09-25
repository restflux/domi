import type * as React from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarTitlebarToggleProps {
  isMac: boolean
  collapsed: boolean
  previewActive: boolean
  onToggle: () => void
}

/** 顶栏拖拽区自己持有按钮，no-drag 才能从 Electron 原生命中区域中扣除。 */
export function SidebarTitlebarToggle({ isMac, collapsed, previewActive, onToggle }: SidebarTitlebarToggleProps): React.ReactElement {
  const label = previewActive ? '固定展开侧边栏' : collapsed ? '展开侧边栏' : '收起侧边栏'
  return (
    <div className={cn('titlebar-drag-region fixed left-0 top-0 z-[90] h-[46px]', isMac ? 'w-[128px]' : 'w-[48px]')}>
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-controls="modern-left-sidebar"
        aria-expanded={!collapsed || previewActive}
        onClick={onToggle}
        className={cn('titlebar-no-drag absolute top-[9px] flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', isMac ? 'left-[88px]' : 'left-[10px]')}
      >
        {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
      </button>
    </div>
  )
}
