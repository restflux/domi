import { AGENT_IPC_CHANNELS, type AgentSessionMeta } from '@domi/shared'

interface CodemodeIpcRegistrar {
  handle(channel: string, listener: (event: unknown, sessionId: unknown, enabled: unknown) => Promise<AgentSessionMeta>): void
}
interface CodemodeSettingsStore {
  update(sessionId: string, updates: { readonlyCodemode: boolean }): AgentSessionMeta
}

/** Renderer 只能更新指定会话的曝光选择；用途/持久化由既有 Main 会话 store 校验，不热改当前 run。 */
export function registerReadonlyCodemodeIpc(ipc: CodemodeIpcRegistrar, store: CodemodeSettingsStore): void {
  ipc.handle(AGENT_IPC_CHANNELS.UPDATE_SESSION_READONLY_CODEMODE, async (_event, sessionId, enabled) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Agent 会话 ID 无效')
    if (typeof enabled !== 'boolean') throw new Error('只读 Codemode 设置必须是 boolean')
    return store.update(sessionId, { readonlyCodemode: enabled })
  })
}
