/**
 * DiffPanelTabBar — 右侧面板顶部 Tab 栏（单层分段控件）
 *
 * 原「文件 / 文件改动」外层 Tab 与文件视图内层「会话文件 / 项目文件」子 Tab
 * 合并为一层：[会话文件 | 项目文件 | 文件改动 (+ 问答)]，
 * 消除双层 Tab 的认知成本。会话/项目两个入口仍写入原有两层状态：
 * AgentSidePanelTab('files') + AgentFileSourceFilter，持久化结构不变。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { agentDiffUnseenChangesAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import type { AgentSidePanelTab, AgentFileSourceFilter } from '@/atoms/agent-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'

interface DiffPanelTabBarProps {
  activeTab: AgentSidePanelTab
  onTabChange: (tab: AgentSidePanelTab) => void
  /** 文件来源过滤（会话 / 项目），与 onTabChange 联动形成单层分段控件 */
  sourceFilter?: AgentFileSourceFilter
  onSourceFilterChange?: (filter: AgentFileSourceFilter) => void
  onCloseChat?: () => void
  showChatTab?: boolean
  isWindows?: boolean
}

interface PreviousTabState {
  sessionId: string | null
  activeTab: AgentSidePanelTab
}

export function DiffPanelTabBar({
  activeTab,
  onTabChange,
  sourceFilter,
  onSourceFilterChange,
  onCloseChat,
  showChatTab = false,
  isWindows = false,
}: DiffPanelTabBarProps): React.ReactElement {
  const unseenMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenMap = useSetAtom(agentDiffUnseenChangesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const unseenChanges = unseenMap.get(currentSessionId ?? '') ?? false
  const prevTabStateRef = React.useRef<PreviousTabState>({ sessionId: currentSessionId, activeTab })

  const clearUnseen = React.useCallback((sessionId = currentSessionId) => {
    if (!sessionId) return
    setUnseenMap((prev) => {
      if (prev.get(sessionId) === false) return prev
      const m = new Map(prev)
      m.set(sessionId, false)
      return m
    })
  }, [currentSessionId, setUnseenMap])

  // 同一会话内，从「文件改动」切走时，说明用户已经看过当前改动。
  React.useEffect(() => {
    const previous = prevTabStateRef.current
    if (previous.sessionId === currentSessionId && previous.activeTab === 'changes' && activeTab !== 'changes') {
      clearUnseen(currentSessionId)
    }
    prevTabStateRef.current = { sessionId: currentSessionId, activeTab }
  }, [activeTab, currentSessionId, clearUnseen])

  const handleChangesClick = () => {
    clearUnseen()
    if (activeTab !== 'changes') {
      onTabChange('changes')
    }
  }

  /** 文件来源入口：切到 files 视图并同时切换来源过滤 */
  const handleSourceClick = (filter: AgentFileSourceFilter) => {
    if (activeTab !== 'files') onTabChange('files')
    if (sourceFilter !== filter) onSourceFilterChange?.(filter)
  }

  const tabButtonClass = (active: boolean) => cn(
    'chrome-tab flex-1 px-2 h-[34px] text-xs transition-colors select-none cursor-pointer whitespace-nowrap overflow-visible',
    isClassic ? 'rounded-t-lg' : 'rounded-none',
    'border-t border-l border-r',
    active
      ? isClassic
        ? 'bg-content-area text-foreground border-border/50'
        : 'app-tab-active text-foreground border-border/80'
      : isClassic
        ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50'
        : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
  )

  const filesActive = activeTab === 'files'

  return (
    <div className="chrome-tabbar side-panel-tabbar flex items-end h-[34px] tabbar-bg relative flex-shrink-0">
      <div className={cn("absolute inset-0 titlebar-drag-region", isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
      <div className="relative flex items-end flex-1 titlebar-no-drag">
        {/* 有来源过滤 props 时渲染合并后的单层分段控件；否则回退旧「文件」单 Tab */}
        {onSourceFilterChange ? (
          <>
            <button
              type="button"
              onClick={() => handleSourceClick('session')}
              className={tabButtonClass(filesActive && sourceFilter === 'session')}
            >
              会话文件
            </button>
            <button
              type="button"
              onClick={() => handleSourceClick('project')}
              className={tabButtonClass(filesActive && sourceFilter === 'project')}
            >
              项目文件
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onTabChange('files')}
            className={tabButtonClass(filesActive)}
          >
            文件
          </button>
        )}
        <button
          type="button"
          onClick={handleChangesClick}
          className={cn(tabButtonClass(activeTab === 'changes'), 'relative')}
        >
          <span className="inline-flex items-center gap-1">
            {unseenChanges && activeTab !== 'changes' && (
              <span className="size-2 rounded-full bg-primary ring-1 ring-background shrink-0" />
            )}
            文件改动
          </span>
        </button>
        {showChatTab && (
          <div
            className={cn(
              'chrome-tab flex-1 h-[34px] text-xs transition-colors select-none relative whitespace-nowrap overflow-visible',
              isClassic ? 'rounded-t-lg' : 'rounded-none',
              'border-t border-l border-r',
              activeTab === 'chat'
                ? isClassic
                  ? 'bg-content-area text-foreground border-border/50'
                  : 'app-tab-active text-foreground border-border/80'
                : isClassic
                  ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50'
                  : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
            )}
          >
            <div className="flex h-full items-center">
              <button
                type="button"
                onClick={() => onTabChange('chat')}
                className="min-w-0 flex-1 self-stretch px-2 text-left"
              >
                <span className="block truncate text-center">问答</span>
              </button>
              {onCloseChat && (
                <button
                  type="button"
                  className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  aria-label="关闭问答 Tab"
                  onClick={onCloseChat}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
