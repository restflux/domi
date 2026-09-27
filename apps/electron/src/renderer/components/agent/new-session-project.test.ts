import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace } from '@domi/shared'
import { selectLocalDraftProject } from './new-session-project.ts'

const existing: AgentWorkspace = {
  id: 'existing', slug: 'domi', name: 'domi', projectRootPath: '/projects/domi', createdAt: 1, updatedAt: 1,
}

describe('open local project from new session', () => {
  test('Given the picker is cancelled When opening a local project Then no workspace is created', async () => {
    let creations = 0
    const result = await selectLocalDraftProject({
      workspaces: [existing],
      chooseFolder: async () => null,
      createWorkspace: async () => { creations++; return existing },
    })
    expect(result).toBeNull()
    expect(creations).toBe(0)
  })

  test('Given a folder already belongs to a project When it is selected Then reuse it without creating a second project', async () => {
    let creations = 0
    const result = await selectLocalDraftProject({
      workspaces: [existing],
      chooseFolder: async () => ({ name: 'domi', path: '/projects/domi/' }),
      createWorkspace: async () => { creations++; return existing },
    })
    expect(result).toEqual({ workspace: existing, created: false })
    expect(creations).toBe(0)
  })

  test('Given workspace creation fails When opening a new folder Then the error is not swallowed', async () => {
    await expect(selectLocalDraftProject({
      workspaces: [existing],
      chooseFolder: async () => ({ name: 'unavailable', path: '/projects/unavailable' }),
      createWorkspace: async () => { throw new Error('项目文件夹不可用') },
    })).rejects.toThrow('项目文件夹不可用')
  })

  test('Given a new folder When it is selected Then create only a workspace bound to that folder', async () => {
    const inputs: Array<{ name: string; projectRootPath?: string }> = []
    const result = await selectLocalDraftProject({
      workspaces: [existing],
      chooseFolder: async () => ({ name: 'notes', path: '/projects/notes' }),
      createWorkspace: async (input) => { inputs.push(input); return { ...existing, id: 'notes', ...input } },
    })
    expect(inputs).toEqual([{ name: 'notes', projectRootPath: '/projects/notes' }])
    expect(result).toMatchObject({ workspace: { id: 'notes' }, created: true })
  })
})
