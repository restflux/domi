/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { DEFAULT_WORK_SIDEBAR_PREFERENCES } from '../../types'
import type { WorkSidebarPreferences } from '../../types'
/** 侧边栏视图模式 */
export type SidebarViewMode = 'active' | 'archived'

/** 侧边栏视图模式（active = 显示活跃对话，archived = 显示已归档对话） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/** Work 项目会话列表分组与排序偏好；由 settings.json 初始化并持久化。 */
export const workSidebarPreferencesAtom = atom<WorkSidebarPreferences>({
  ...DEFAULT_WORK_SIDEBAR_PREFERENCES,
})

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'domi-workspace-list-height',
  120,
)

/** 左侧边栏宽度（px），用户可拖拽调整，持久化到 localStorage */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'domi-left-sidebar-width',
  300,
)
