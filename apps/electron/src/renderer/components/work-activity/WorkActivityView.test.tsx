import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkActivityRefreshFailure, WorkActivityView } from './WorkActivityView.tsx'
import { workActivityLoadingAtom, workActivityProjectionAtom } from '@/atoms/work-activity-atoms.ts'

describe('WorkActivityView', () => {
  test('renders the global state-first page without creating a conversation tab surface', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <WorkActivityView />
      </Provider>,
    )

    expect(html).toContain('工作动态')
    expect(html).toContain('aria-label="筛选工作状态"')
    expect(html).toContain('待处理')
    expect(html).toContain('进行中')
    expect(html).toContain('已完成')
    expect(html).toContain('搜索项目、会话、阶段或自动任务')
    expect(html).toContain('aria-label="筛选项目"')
    expect(html).toContain('aria-label="筛选来源"')
    expect(html).not.toContain('确认停止')
  })

  test('renders the projection already loaded by the global Work Activity initializer', () => {
    const store = createStore()
    store.set(workActivityLoadingAtom, false)
    store.set(workActivityProjectionAtom, {
      generatedAt: 100,
      counts: { attention_required: 1, working: 0, recently_completed: 0 },
      sessions: [{
        id: 'attention',
        rootSessionId: 'attention',
        workspaceId: 'workspace-1',
        workspaceName: 'Domi',
        title: '等待验收',
        source: 'manual',
        state: 'attention_required',
        reason: '等待验收',
        pendingActionKind: 'ready_for_review',
        phaseSummary: '已准备好验收',
        stateChangedAt: 100,
        unread: true,
        archived: false,
        activeSessionIds: [],
        completedChildren: 0,
        totalChildren: 0,
        tasks: [],
        children: [],
      }],
    })

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <WorkActivityView />
      </Provider>,
    )

    expect(html).toContain('等待验收')
    expect(html).toContain('已准备好验收')
    expect(html).not.toContain('正在读取工作动态')
  })

  test('renders a diagnostic refresh failure with an explicit retry action', () => {
    const html = renderToStaticMarkup(
      <WorkActivityRefreshFailure
        reason="当前主进程未注册工作动态接口"
        retrying={false}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('工作动态刷新失败')
    expect(html).toContain('当前主进程未注册工作动态接口')
    expect(html).toContain('重试')
  })

  test('keeps status controls first in the filter row and out of the window-controls header area', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <WorkActivityView />
      </Provider>,
    )

    const searchIndex = html.indexOf('搜索项目、会话、阶段或自动任务')
    const statusFilterIndex = html.indexOf('aria-label="筛选工作状态"')
    const workspaceFilterIndex = html.indexOf('aria-label="筛选项目"')

    expect(searchIndex).toBeGreaterThan(-1)
    expect(statusFilterIndex).toBeGreaterThan(-1)
    expect(searchIndex).toBeGreaterThan(statusFilterIndex)
    expect(workspaceFilterIndex).toBeGreaterThan(searchIndex)
    expect(html).not.toContain('工作状态概览')
    expect(html).not.toContain('pr-[126px]')
  })
})
