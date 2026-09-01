import { atom } from 'jotai'

export type SessionHeaderCommandAction =
  | 'pin'
  | 'followUp'
  | 'archive'
  | 'move'
  | 'delete'

export interface SessionHeaderCommand {
  sessionType: 'agent' | 'chat'
  sessionId: string
  action: SessionHeaderCommandAction
}

/**
 * 内容区头部把当前会话操作交给 LeftSidebar 的统一生命周期处理器。
 * 侧边栏仍是归档、迁移、删除及其确认/级联规则的唯一执行入口，
 * 避免头部菜单复制一套容易漂移的会话清理逻辑。
 */
export const sessionHeaderCommandAtom = atom<SessionHeaderCommand | null>(null)
