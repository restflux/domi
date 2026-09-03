/**
 * MainArea — 主内容区域。
 *
 * 中间区域只承载当前会话或全局工作视图。文件、改动、Browser、Preview 与草稿
 * 统一由 Right Workspace 承载，工具切换不会重挂载当前 AgentView。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeTabIdAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { interfaceVariantAtom } from '@/atoms/theme'
import { Panel } from '@/components/app-shell/Panel'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { WorkActivityView } from '@/components/work-activity/WorkActivityView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { TerminalDock } from '@/components/terminal/TerminalDock.tsx'
import { cn } from '@/lib/utils'

export function MainArea(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const deferredActiveTabId = React.useDeferredValue(activeTabId)
  const activeTab = React.useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [activeTabId, tabs],
  )

  React.useEffect(() => {
    if (tabs.length > 0 && !activeTabId) setActiveTabId(tabs[0]!.id)
  }, [activeTabId, setActiveTabId, tabs])

  return (
    <Panel
      variant="grow"
      className={cn('bg-content-area', isClassic && 'rounded-2xl shadow-xl dark:shadow-sm')}
    >
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div data-scroll-minimap-boundary className="relative flex h-full min-w-0 flex-1 flex-col">
          {activeView === 'planning' ? (
            automationFormOpen ? <AutomationFormView /> : <PlanningView />
          ) : activeView === 'work-activity' ? (
            <WorkActivityView />
          ) : activeView === 'agent-skills' ? (
            <AgentSkillsView />
          ) : (
            <>
              <TabBar />
              {deferredActiveTabId ? (
                <div className="min-h-0 flex-1">
                  <TabContent tabId={deferredActiveTabId} />
                </div>
              ) : (
                <WelcomeView />
              )}
              {activeTab?.type === 'agent' && (
                <TerminalDock ownerSessionId={activeTab.sessionId} />
              )}
            </>
          )}
        </div>
      </div>
    </Panel>
  )
}
