import { performance } from 'node:perf_hooks'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '../src/renderer/atoms/agent-atoms.ts'
import { appModeAtom } from '../src/renderer/atoms/app-mode.ts'
import { TooltipProvider } from '../src/renderer/components/ui/tooltip.tsx'
import { LeftSidebar } from '../src/renderer/components/app-shell/LeftSidebar.tsx'
import { WorkbenchSidebarV2 } from '../src/renderer/components/app-shell/v2/WorkbenchSidebarV2.tsx'

// 同一固定会话集，只有左侧栏 UI 实现不同。SSR 不等于桌面帧率/PTY/原生 View。
const store = createStore()
store.set(appModeAtom, 'agent')
store.set(agentWorkspacesAtom, Array.from({ length: 4 }, (_, i) => ({ id: `workspace-${i}`, slug: `workspace-${i}`, name: `Project ${i}`, createdAt: 1, updatedAt: 1 })))
store.set(currentAgentWorkspaceIdAtom, 'workspace-0')
store.set(agentSessionsAtom, Array.from({ length: 2000 }, (_, i) => ({ id: `session-${i}`, workspaceId: `workspace-${i % 4}`, title: `Task ${i}`, createdAt: 1, updatedAt: i })))

function benchmark(name: string, Component: typeof LeftSidebar | typeof WorkbenchSidebarV2): void {
  const times: number[] = []
  for (let i = 0; i < 15; i++) {
    const start = performance.now()
    const html = renderToStaticMarkup(<Provider store={store}><TooltipProvider><Component width={280} /></TooltipProvider></Provider>)
    const elapsed = performance.now() - start
    if (i > 2) times.push(elapsed)
    if (!html.includes('Project 0')) throw new Error(`${name}: missing first workspace`)
  }
  times.sort((a, b) => a - b)
  console.log(`${name}: median=${times[6]?.toFixed(2)}ms p95=${times[11]?.toFixed(2)}ms; 2000 sessions / 4 workspaces / 12 warm runs`)
}

benchmark('v1 LeftSidebar', LeftSidebar)
benchmark('v2 WorkbenchSidebar', WorkbenchSidebarV2)
