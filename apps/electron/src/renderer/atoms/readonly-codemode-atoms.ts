import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { getReadonlyCodemodeUnavailableReason, type AgentSessionMeta, type ReadonlyCodemodeUnavailableReason } from '@domi/shared'
import { agentSessionsAtom } from './agent-atoms.ts'

interface ReadonlyCodemodeState {
  enabled: boolean
  pending: boolean
  unavailableReason?: ReadonlyCodemodeUnavailableReason
}
type PersistReadonlyCodemode = (sessionId: string, enabled: boolean) => Promise<AgentSessionMeta>

/** 仅一个会话配置来源（Main JSON）；pending 属于本 store，不在卸载/重挂载时丢失。 */
export function createReadonlyCodemodeAtoms(persist: PersistReadonlyCodemode) {
  const pending = atom(new Set<string>())
  const state = atomFamily((sessionId: string) => atom((get): ReadonlyCodemodeState => {
    const session = get(agentSessionsAtom).find(item => item.id === sessionId)
    return { enabled: session?.readonlyCodemode === true, pending: get(pending).has(sessionId),
      unavailableReason: getReadonlyCodemodeUnavailableReason(session) }
  }))
  const update = atom(null, async (get, set, input: { sessionId: string; enabled: boolean }): Promise<void> => {
    const { sessionId, enabled } = input
    if (get(pending).has(sessionId)) return
    const session = get(agentSessionsAtom).find(item => item.id === sessionId)
    if (!session) throw new Error('会话尚未加载')
    if (enabled && getReadonlyCodemodeUnavailableReason(session)) throw new Error('当前会话或预设不支持只读 Codemode')
    set(pending, new Set(get(pending)).add(sessionId))
    try {
      const saved = await persist(sessionId, enabled)
      if (saved.id !== sessionId || typeof saved.readonlyCodemode !== 'boolean') throw new Error('会话设置保存结果无效')
      // 不整体替换异步返回的旧meta，避免覆盖期间更改的模型/标题/权限，也不恢复已删除的会话。
      set(agentSessionsAtom, previous => previous.map(item => item.id === sessionId && item.createdAt === session.createdAt
        ? { ...item, readonlyCodemode: saved.readonlyCodemode, updatedAt: Math.max(item.updatedAt, saved.updatedAt) } : item))
    } finally {
      const next = new Set(get(pending))
      next.delete(sessionId)
      set(pending, next)
    }
  })
  return { state, update }
}

const settings = createReadonlyCodemodeAtoms((sessionId, enabled) => window.electronAPI.updateSessionReadonlyCodemode(sessionId, enabled))
export const readonlyCodemodeStateAtomFamily = settings.state
export const updateReadonlyCodemodeAtom = settings.update
