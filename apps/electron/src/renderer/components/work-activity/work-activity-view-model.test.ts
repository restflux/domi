import { describe, expect, test } from 'bun:test'
import type { WorkSessionView } from '@domi/shared'
import {
  collectWorkActivityWorkspaces,
  describeWorkActivityRefreshError,
  describeWorkActivityStopImpact,
  filterWorkActivitySessions,
} from './work-activity-view-model.ts'

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
    phaseSummary: '正在验证中央页面',
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

describe('Work Activity view model', () => {
  test('combines project, source and lightweight search filters', () => {
    const sessions = [
      session(),
      session({
        id: 'automation',
        rootSessionId: 'automation',
        workspaceId: 'workspace-2',
        workspaceName: '站点',
        title: '巡检',
        source: 'automation',
        automationName: '每日巡检',
        phaseSummary: '正在运行测试',
      }),
    ]

    expect(filterWorkActivitySessions(sessions, {
      query: '运行测试',
      workspaceId: 'workspace-2',
      source: 'automation',
    }).map((item) => item.id)).toEqual(['automation'])
    expect(filterWorkActivitySessions(sessions, {
      query: '不存在',
      workspaceId: 'all',
      source: 'all',
    })).toEqual([])
  })

  test('does not search hidden reasons or child result details', () => {
    const item = session({ reason: '内部错误码 E_PRIVATE' })
    expect(filterWorkActivitySessions([item], {
      query: 'E_PRIVATE',
      workspaceId: 'all',
      source: 'all',
    })).toEqual([])
  })

  test('extracts a concise host diagnostic from Electron IPC failures', () => {
    expect(describeWorkActivityRefreshError(new Error(
      "Error invoking remote method 'agent:get-work-activity': Error: 读取工作动态失败：会话索引损坏",
    ))).toBe('会话索引损坏')
    expect(describeWorkActivityRefreshError(new Error(
      "Error invoking remote method 'agent:get-work-activity': Error: No handler registered for 'agent:get-work-activity'",
    ))).toBe('当前主进程未注册工作动态接口，请重启对应的开发实例')
    expect(describeWorkActivityRefreshError(new Error('getWorkActivity is not a function'))).toBe(
      '当前 Preload 未提供工作动态接口，请重启对应的开发实例',
    )
  })

  test('deduplicates workspace options and describes exact stop impact', () => {
    expect(collectWorkActivityWorkspaces([
      session(),
      session({ id: 'session-2', rootSessionId: 'session-2' }),
    ])).toEqual([{ id: 'workspace-1', name: 'Domi' }])

    expect(describeWorkActivityStopImpact(session({
      activeSessionIds: ['session-1', 'child-1', 'child-2'],
      totalChildren: 2,
    }))).toBe('当前执行和 2 个运行中的子 Agent 将被中断；已有文件改动会保留。')
    expect(describeWorkActivityStopImpact(session())).toBe('当前执行将被中断；已有文件改动会保留。')
  })
})
