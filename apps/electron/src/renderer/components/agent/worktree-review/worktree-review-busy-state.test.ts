import { describe, expect, test } from 'bun:test'
import { worktreeOperationBusyLabel } from './worktree-review-busy-state.ts'

describe('worktreeOperationBusyLabel', () => {
  test('maps each checkout mutation to one user-facing operation label', () => {
    expect(worktreeOperationBusyLabel('preview')).toBe('正在创建预览…')
    expect(worktreeOperationBusyLabel('checkpoint')).toBe('正在保存进度…')
    expect(worktreeOperationBusyLabel('rollback_preview')).toBe('正在撤回预览…')
    expect(worktreeOperationBusyLabel('finalize_preview')).toBe('正在保存修改…')
    expect(worktreeOperationBusyLabel('retry_cleanup')).toBe('正在清理环境…')
    expect(worktreeOperationBusyLabel('release_collaborators')).toBe('正在结束协作占用…')
  })
})
