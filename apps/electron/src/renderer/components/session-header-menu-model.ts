export type SessionHeaderMenuAction =
  | 'pin'
  | 'followUp'
  | 'rename'
  | 'archive'
  | 'move'
  | 'openProject'
  | 'copyPath'
  | 'copyId'
  | 'delete'

export type SessionHeaderMenuEntry =
  | { type: 'separator' }
  | {
      type: 'item'
      action: SessionHeaderMenuAction
      label: string
      disabled?: boolean
      destructive?: boolean
    }

interface AgentSessionHeaderMenuState {
  pinned: boolean
  needsFollowUp: boolean
  archived: boolean
  canTransfer: boolean
  isDraft: boolean
  canOpenProjectFolder: boolean
  hasSessionPath: boolean
}

export function getAgentSessionTransferLabel(isDraft: boolean): '迁移到其他项目' | '交接到新会话' {
  return isDraft ? '迁移到其他项目' : '交接到新会话'
}

interface ChatSessionHeaderMenuState {
  pinned: boolean
  archived: boolean
}

export function buildAgentSessionHeaderMenu(
  state: AgentSessionHeaderMenuState,
): SessionHeaderMenuEntry[] {
  return [
    { type: 'item', action: 'pin', label: state.pinned ? '取消置顶' : '置顶会话' },
    { type: 'item', action: 'followUp', label: state.needsFollowUp ? '取消待继续' : '标记为待继续' },
    { type: 'item', action: 'rename', label: '重命名' },
    { type: 'item', action: 'archive', label: state.archived ? '取消归档' : '归档' },
    { type: 'separator' },
    ...(state.canTransfer
      ? [{
          type: 'item',
          action: 'move',
          label: getAgentSessionTransferLabel(state.isDraft),
        } as const]
      : []),
    { type: 'item', action: 'openProject', label: '打开项目文件夹', disabled: !state.canOpenProjectFolder },
    { type: 'item', action: 'copyPath', label: '复制会话目录', disabled: !state.hasSessionPath },
    { type: 'item', action: 'copyId', label: '复制会话 ID' },
    { type: 'separator' },
    { type: 'item', action: 'delete', label: '删除会话', destructive: true },
  ]
}

export function buildChatSessionHeaderMenu(
  state: ChatSessionHeaderMenuState,
): SessionHeaderMenuEntry[] {
  return [
    { type: 'item', action: 'pin', label: state.pinned ? '取消置顶' : '置顶对话' },
    { type: 'item', action: 'rename', label: '重命名' },
    { type: 'item', action: 'archive', label: state.archived ? '取消归档' : '归档' },
    { type: 'separator' },
    { type: 'item', action: 'copyId', label: '复制会话 ID' },
    { type: 'separator' },
    { type: 'item', action: 'delete', label: '删除对话', destructive: true },
  ]
}
