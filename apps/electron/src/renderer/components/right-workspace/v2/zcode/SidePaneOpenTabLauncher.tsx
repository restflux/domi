import { Globe2, SquareTerminal } from 'lucide-react'
import * as React from 'react'

interface SidePaneOpenTabLauncherProps {
  onOpenBrowser: () => void
  onOpenTerminal: () => void
}

/** 改编自 ZCode AnimatedSidePanePanel 的 openTabLauncher；宿主动作仍走 Domi owner-bound IPC。 */
export function SidePaneOpenTabLauncher({ onOpenBrowser, onOpenTerminal }: SidePaneOpenTabLauncherProps): React.ReactElement {
  const items = [
    { id: 'terminal', label: '终端', icon: SquareTerminal, onOpen: onOpenTerminal },
    { id: 'browser', label: '浏览器', icon: Globe2, onOpen: onOpenBrowser },
  ]
  return (
    <div className="side-pane-open-tab-shell flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-10">
        <div className="side-pane-open-tab-content flex w-full max-w-[20rem] flex-col gap-5">
          <div className="flex flex-col gap-2 text-center">
            <h2 className="text-xl font-semibold leading-7 text-foreground">打开标签页</h2>
            <p className="text-sm leading-5 text-muted-foreground">选择一个工具，在当前会话的工作区打开。</p>
          </div>
          <div className="side-pane-open-tab-list flex w-full flex-col gap-2">
            {items.map(({ id, label, icon: Icon, onOpen }) => (
              <button key={id} type="button" data-side-pane-open-tab-item={id}
                className="side-pane-open-tab-button flex h-12 min-w-0 items-center gap-3 rounded-xl bg-accent/60 px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onOpen}>
                <Icon className="size-4 text-muted-foreground" />
                <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
