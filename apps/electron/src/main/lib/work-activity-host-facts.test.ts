import { describe, expect, test } from 'bun:test'
import type { SessionTargetView } from '@domi/shared'
import {
  describeWorkActivityHostFailure,
  projectSessionTargetPendingActions,
  projectWorkActivitySource,
  resolveWorkActivityHostMetadata,
} from './work-activity-host-facts.ts'

function target(delivery: SessionTargetView['delivery']): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'Domi' },
    checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
    source: { ref: 'main', oid: 'a'.repeat(40) },
    current: { branch: 'work', oid: 'b'.repeat(40) },
    ownership: 'owner',
    dirty: true,
    revision: 2,
    delivery,
  }
}

const review = {
  reviewId: 'review-1',
  iteration: 1,
  preparedAt: 100,
  summary: '完成工作动态',
  validationStatus: 'passed' as const,
  tests: [],
  changedFiles: ['file.ts'],
  suggestedCommitMessage: 'feat: work activity',
}

describe('Work Activity host facts', () => {
  test('maps Ready for Review and Preview to the existing host review transaction', () => {
    expect(projectSessionTargetPendingActions(target({ state: 'ready_for_review', review }).delivery)).toEqual([{
      kind: 'ready_for_review',
      summary: '等待验收',
      occurredAt: 100,
    }])
    expect(projectSessionTargetPendingActions(target({ state: 'preview_active', review, previewedAt: 120 }).delivery)).toEqual([{
      kind: 'ready_for_review',
      summary: '等待完成 Local 验收',
      occurredAt: 120,
    }])
  })

  test('maps detached Preview and blocked cleanup to conflict attention', () => {
    expect(projectSessionTargetPendingActions(target({
      state: 'preview_detached',
      review,
      previewedAt: 120,
      detachedAt: 130,
      reason: 'preview_modified',
      attemptedAction: 'finalize_preview',
    }).delivery)).toEqual([{
      kind: 'conflict',
      summary: 'Local 验收内容已变化，需要处理',
      occurredAt: 130,
    }])

    expect(projectSessionTargetPendingActions(target({
      state: 'retained',
      review,
      commitOid: null,
      retention: 'retain_manual',
      retainedAt: 140,
      expiresAt: null,
      cleanup: 'blocked',
      cleanupMessage: '仍有协作会话占用',
    }).delivery)).toEqual([{
      kind: 'conflict',
      summary: '仍有协作会话占用',
      occurredAt: 100,
    }])
  })

  test('keeps automation source until the session is graduated', () => {
    expect(projectWorkActivitySource({ sourceAutomationId: 'automation-1' }, '每日检查')).toEqual({
      source: 'automation',
      automationName: '每日检查',
    })
    expect(projectWorkActivitySource({ sourceAutomationId: 'automation-1', automationGraduated: true }, '每日检查')).toEqual({
      source: 'manual',
    })
  })

  test('isolates workspace and Automation metadata failures per historical session', () => {
    const warnings: string[] = []
    expect(resolveWorkActivityHostMetadata({
      id: 'bad-history',
      workspaceId: 'broken-workspace',
      sourceAutomationId: 'broken-automation',
    }, {
      getWorkspaceName: () => { throw new Error('workspace index damaged') },
      getAutomationName: () => { throw new Error('automation index damaged') },
      warn: (message) => warnings.push(message),
    })).toEqual({
      workspaceName: '未分组项目',
      source: 'automation',
    })
    expect(warnings).toEqual([
      '[Work Activity] 读取工作区失败: bad-history',
      '[Work Activity] 读取 Automation 失败: bad-history',
    ])
  })

  test('formats a concise diagnostic reason for IPC callers', () => {
    expect(describeWorkActivityHostFailure(new Error('会话索引损坏'))).toBe('读取工作动态失败：会话索引损坏')
    expect(describeWorkActivityHostFailure('')).toBe('读取工作动态失败：未知宿主错误')
  })
})
