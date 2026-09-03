import * as React from 'react'
import { cn } from '@/lib/utils'
import type { AgentFileSourceFilter } from '@/atoms/agent-atoms'
import type { ScratchPadSaveState } from '@/atoms/tab-atoms'
import type { RightWorkspaceTool } from '@/lib/right-workspace-model'

interface RightWorkspaceHeaderProps {
  activeTool: RightWorkspaceTool
  previewTitle?: string
  fileSourceFilter: AgentFileSourceFilter
  scratchSaveState: ScratchPadSaveState
  onFileSourceFilterChange: (filter: AgentFileSourceFilter) => void
}

export function RightWorkspaceHeader({
  activeTool,
  previewTitle,
  fileSourceFilter,
  scratchSaveState,
  onFileSourceFilterChange,
}: RightWorkspaceHeaderProps): React.ReactElement | null {
  // Browser 和 Terminal 自带内容上下文；Changes 与问答也无需重复工具名称。
  if (activeTool === 'browser' || activeTool === 'terminal' || activeTool === 'changes' || activeTool === 'side-chat') return null

  const previewContextTitle = activeTool === 'preview'
    ? previewTitle ?? '预览'
    : null
  const scratchSaveLabel: Record<ScratchPadSaveState, string> = {
    loading: '正在加载',
    saving: '正在保存…',
    saved: '已保存到本地',
    error: '保存失败',
  }

  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-2 titlebar-no-drag">
      {activeTool === 'files' ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-muted/50 p-0.5" role="group" aria-label="文件来源">
          {(['session', 'project'] as const).map((source) => (
            <button
              key={source}
              type="button"
              onClick={() => onFileSourceFilterChange(source)}
              className={cn(
                'h-6 min-w-0 flex-1 rounded-md px-2 text-[11px] transition-colors',
                fileSourceFilter === source
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {source === 'session' ? '会话文件' : '项目文件'}
            </button>
          ))}
        </div>
      ) : activeTool === 'preview' ? (
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={previewContextTitle ?? undefined}>
          {previewContextTitle}
        </span>
      ) : activeTool === 'scratch' ? (
        <span className={cn(
          'min-w-0 flex-1 truncate text-[11px]',
          scratchSaveState === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}>
          {scratchSaveLabel[scratchSaveState]}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
    </header>
  )
}
