/**
 * App Mode Atom - 应用模式状态
 *
 * - chat: 对话模式
 * - agent: Work 模式（原 Flow）
 * - scratch: 草稿本模式
 */

import { atomWithStorage } from 'jotai/utils'

export type AppMode = 'chat' | 'agent' | 'scratch'
export type ConversationAppMode = Exclude<AppMode, 'scratch'>

/**
 * 在 Chat / Work 之间切换；从草稿本触发时进入 Chat，避免全局切换命令静默失效。
 */
export function resolveToggledConversationMode(currentMode: AppMode): ConversationAppMode {
  return currentMode === 'chat' ? 'agent' : 'chat'
}

/** App 模式，自动持久化到 localStorage */
export const appModeAtom = atomWithStorage<AppMode>('domi-app-mode', 'agent')
