import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkActivityProjection, WorkSessionView } from '@domi/shared'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { workActivityProjectionAtom } from '@/atoms/work-activity-atoms.ts'
import {
  WorkActivitySidebarOverview,
  WorkActivitySidebarRailButton,
} from './WorkActivitySidebarOverview.tsx'

const noop = (): void => undefined

function session(overrides: Partial<WorkSessionView> = {}): WorkSessionView {
  return {
    id: 'session-1',
    rootSessionId: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Domi',
    title: '实现工作动态',
    source: 'manual',
    state: 'working',
    reason: '正在工作',
    phaseSummary: '正在实现左侧概览',
    stateChangedAt: 100,
    unread: false,
    archived: false,
    activeSessionIds: ['session-1'],
    completedChildren: 0,
    totalChildren: 0,
    tasks: [],
    children: [],
    ...overrides,
  }
}

function projection(): WorkActivityProjection {
  return {
    generatedAt: 200,
    counts: {
      attention_required: 2,
      working: 1,
      recently_completed: 1,
    },
    sessions: [
      session({ id: 'attention-old', rootSessionId: 'attention-old', title: '等待回答', state: 'attention_required', reason: '等待用户回答', activeSessionIds: [] }),
      session({ id: 'attention-review', rootSessionId: 'attention-review', title: '等待验收', state: 'attention_required', reason: '等待验收', activeSessionIds: [] }),
      session({ id: 'working', rootSessionId: 'working', title: '正在开发', state: 'working' }),
      session({ id: 'completed', rootSessionId: 'completed', title: '已完成但不应进入前三项', state: 'recently_completed', activeSessionIds: [] }),
    ],
  }
}

function renderWithProjection(element: React.ReactElement): string {
  const store = createStore()
  store.set(workActivityProjectionAtom, projection())
  return renderToStaticMarkup(
    <Provider store={store}>
      <TooltipProvider>{element}</TooltipProvider>
    </Provider>,
  )
}

describe('Work Activity sidebar overview', () => {
  test('keeps the expanded sidebar entry to one compact row without mounting session details', () => {
    const html = renderWithProjection(
      <WorkActivitySidebarOverview active={false} onOpenAll={noop} onOpenSession={noop} />,
    )

    expect(html).toContain('aria-label="工作动态概览，需要处理 2，正在工作 1，最近完成 1"')
    expect(html).toContain('需处理 2')
    expect(html).toContain('进行中 1')
    expect(html).toContain('已完成 1')
    expect(html).toContain('h-11')
    expect(html).not.toContain('等待回答')
    expect(html).not.toContain('等待验收')
    expect(html).not.toContain('正在开发')
  })

  test('keeps the collapsed rail compact while exposing attention count and a lightweight tooltip summary', () => {
    const html = renderWithProjection(
      <WorkActivitySidebarRailButton active={false} onClick={noop} />,
    )

    expect(html).toContain('aria-label="工作动态，需要处理 2，正在工作 1，最近完成 1"')
    expect(html).toContain('>2</span>')
    expect(html).toContain('需处理 2 · 进行中 1 · 已完成 1')
  })
})
