import { atom } from 'jotai'
import type { WorkActivityProjection } from '@domi/shared'

export const EMPTY_WORK_ACTIVITY_PROJECTION: WorkActivityProjection = {
  sessions: [],
  counts: {
    attention_required: 0,
    working: 0,
    recently_completed: 0,
  },
  generatedAt: 0,
}

/** Main 进程生成的全局工作动态投影；Renderer 不自行推导会话状态。 */
export const workActivityProjectionAtom = atom<WorkActivityProjection>(EMPTY_WORK_ACTIVITY_PROJECTION)

/** 首次宿主读取完成前保持 true，避免把未知计数显示为 0。 */
export const workActivityLoadingAtom = atom(true)

/** 包含初次读取与后续失效刷新，用于页面重试反馈。 */
export const workActivityRefreshingAtom = atom(false)

/** 最近一次宿主读取失败的简短诊断；保留最后一份有效投影。 */
export const workActivityRefreshErrorAtom = atom<string | null>(null)

/** 由页面操作触发的刷新请求；全局监听器负责合并和执行。 */
const workActivityRefreshVersionAtom = atom(0)
export const requestWorkActivityRefreshAtom = atom(null, (get, set) => {
  set(workActivityRefreshVersionAtom, get(workActivityRefreshVersionAtom) + 1)
})

export const internalWorkActivityRefreshVersionAtom = workActivityRefreshVersionAtom
