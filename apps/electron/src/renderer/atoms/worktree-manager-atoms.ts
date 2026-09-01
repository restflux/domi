import { atom } from 'jotai'

export interface WorktreeManagerState {
  open: boolean
  scope: 'project' | 'all' | 'attention'
  projectId?: string
  focusCheckoutId?: string
}

export const worktreeManagerAtom = atom<WorktreeManagerState>({
  open: false,
  scope: 'all',
})
