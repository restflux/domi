import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkActivityProjection, WorkSessionView } from '@domi/shared'
import { workActivityProjectionAtom } from '@/atoms/work-activity-atoms.ts'
import { WorkActivityHoverPreviewContent } from './WorkActivityHoverPreview.tsx'

const noop = (): void => undefined

function session(index: number): WorkSessionView {
  return {
    id: `session-${index}`,
    rootSessionId: `session-${index}`,
    workspaceId: `workspace-${index}`,
    workspaceName: `项目 ${index}`,
    title: `会话 ${index}`,
    source: 'manual',
    state: index < 2 ? 'attention_required' : index < 4 ? 'working' : 'recently_completed',
    reason: index < 2 ? '等待处理' : index < 4 ? '正在工作' : '已完成',
    phaseSummary: `阶段 ${index}`,
    stateChangedAt: 100 - index,
    unread: false,
    archived: false,
    activeSessionIds: index < 4 && index >= 2 ? [`session-${index}`] : [],
    completedChildren: 0,
    totalChildren: 0,
    tasks: [],
    children: [],
  }
}

function projection(): WorkActivityProjection {
  return {
    generatedAt: 200,
    counts: { attention_required: 2, working: 2, recently_completed: 2 },
    sessions: Array.from({ length: 6 }, (_, index) => session(index)),
  }
}

describe('Work Activity hover preview', () => {
  test('renders at most five host-sorted sessions with session and all-activity navigation', () => {
    const store = createStore()
    store.set(workActivityProjectionAtom, projection())
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <WorkActivityHoverPreviewContent onOpenAll={noop} onOpenSession={noop} />
      </Provider>,
    )

    expect(html).toContain('会话 0')
    expect(html).toContain('会话 4')
    expect(html).not.toContain('会话 5')
    expect(html).toContain('项目 0 · 阶段 0')
    expect(html).toContain('查看全部工作动态')
    expect(html).toContain('5 / 6')
  })
})
