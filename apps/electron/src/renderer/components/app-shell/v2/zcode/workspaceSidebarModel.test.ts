import { expect, test } from 'bun:test'
import type { AgentSessionMeta, AgentWorkspace } from '@domi/shared'
import { selectWorkspaceTaskGroupsV2 } from './workspaceSidebarModel.ts'

const workspace: AgentWorkspace = { id: 'project', name: '项目', slug: 'project', createdAt: 1, updatedAt: 2 }
const session = (id: number): AgentSessionMeta => ({
  id: String(id), title: `任务 ${id}`, workspaceId: 'project', createdAt: 1, updatedAt: id,
})

test('Given 2000 tasks When projecting ZCode-style sidebar Then render only bounded rows in updated order without changing inputs', () => {
  const sessions = Array.from({ length: 2000 }, (_, id) => session(id))
  sessions.push({ ...session(2001), sideChatParentSessionId: '0' }, { ...session(2002), archived: true })
  const [group] = selectWorkspaceTaskGroupsV2([workspace], sessions)
  expect(group?.sessions).toHaveLength(24)
  expect(group?.sessions[0]?.title).toBe('任务 1999')
  expect(group?.hiddenCount).toBe(1976)
  expect(sessions[0]?.id).toBe('0')
})
