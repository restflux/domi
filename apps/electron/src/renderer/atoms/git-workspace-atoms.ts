import { atom } from 'jotai'
import type { GitWorkspaceSnapshot } from '@domi/shared'

/** 轻量 Git 面板 SWR 缓存，按 session 隔离。 */
export const gitWorkspaceSnapshotAtom = atom<Map<string, GitWorkspaceSnapshot>>(new Map())
