import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getWorktreeLocalFilesDialogRequest } from '@/atoms/worktree-local-files-atoms.ts'
import { WorktreeLocalFileRow, worktreeLocalFileStatusLabel } from './WorktreeLocalFilesDialog.tsx'

describe('Worktree 本地配置界面', () => {
  test('文件行仅显示相对路径与批准/缺失状态，并提供移除操作', () => {
    const onRemove = mock(() => undefined)
    const row = WorktreeLocalFileRow({ path: '.env.local', status: 'missing', targetExists: true, disabled: false, onRemove })
    const html = renderToStaticMarkup(row)
    expect(html).toContain('.env.local')
    expect(html).toContain('原项目文件缺失')
    expect(html).toContain('Worktree 已存在')
    expect(html).toContain('移除 .env.local')
    expect(html).not.toContain('fingerprint')
    const children = row.props.children
    children[1].props.onClick()
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  test('未批准与待保存条目保留不同状态，忙碌期间不能移除', () => {
    expect(worktreeLocalFileStatusLabel('unapproved')).toBe('待批准')
    expect(worktreeLocalFileStatusLabel('draft')).toBe('待保存')
    expect(worktreeLocalFileStatusLabel('ready')).toBe('已批准')
    const html = renderToStaticMarkup(WorktreeLocalFileRow({ path: 'config/local.json', status: 'unapproved', disabled: true, onRemove: () => undefined }))
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Worktree 尚未复制')
  })

  test('项目菜单仅为同项目的当前会话传 sessionId，其他项目与 Chat 不传', () => {
    const sessions = [{ id: 'session-a', workspaceId: 'project-a' }, { id: 'session-b', workspaceId: 'project-b' }]
    expect(getWorktreeLocalFilesDialogRequest('project-a', 'session-a', sessions)).toEqual({ projectId: 'project-a', sessionId: 'session-a' })
    expect(getWorktreeLocalFilesDialogRequest('project-b', 'session-a', sessions)).toEqual({ projectId: 'project-b' })
    expect(getWorktreeLocalFilesDialogRequest('project-a', 'chat-id', sessions)).toEqual({ projectId: 'project-a' })
    expect(getWorktreeLocalFilesDialogRequest('project-a', null, sessions)).toEqual({ projectId: 'project-a' })
  })
})
