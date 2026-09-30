export type SessionHeaderMenuAction =
  | 'pin'
  | 'followUp'
  | 'rename'
  | 'archive'
  | 'move'
  | 'openProject'
  | 'copyPath'
  | 'copyId'
  | 'sessionTree'
  | 'gallery'
  | 'delete'

/** 子菜单项；如「打开项目文件夹」里的每个可用应用 */
export interface SessionHeaderMenuSubmenuItem {
  id: string
  label: string
  /** 分类用于图标：文件管理器 / 编辑器 / 终端 */
  kind?: 'file-manager' | 'editor' | 'terminal'
  /** 系统读取的真实应用图标（PNG data URL）；缺省时回退分类图标 */
  iconUrl?: string
}

export type SessionHeaderMenuEntry =
  | { type: 'separator' }
  | {
      type: 'item'
      action: SessionHeaderMenuAction
      label: string
      disabled?: boolean
      destructive?: boolean
    }
  | {
      type: 'submenu'
      action: SessionHeaderMenuAction
      label: string
      disabled?: boolean
      items: SessionHeaderMenuSubmenuItem[]
    }

interface AgentSessionHeaderMenuState {
  pinned: boolean
  needsFollowUp: boolean
  archived: boolean
  canTransfer: boolean
  isDraft: boolean
  canOpenProjectFolder: boolean
  hasSessionPath: boolean
  includeSessionTools?: boolean
  /** 本机可用的项目文件夹打开方式；多于一个时渲染为子菜单 */
  projectFolderOpeners?: SessionHeaderMenuSubmenuItem[]
}

interface ChatSessionHeaderMenuState {
  pinned: boolean
  archived: boolean
}

export function getAgentSessionTransferLabel(isDraft: boolean): '迁移到其他项目' | '交接到新会话' {
  return isDraft ? '迁移到其他项目' : '交接到新会话'
}

export function buildAgentSessionHeaderMenu(
  state: AgentSessionHeaderMenuState,
): SessionHeaderMenuEntry[] {
  // 只有一种打开方式（或探测失败）时保持普通菜单项，避免单元素子菜单。
  const openers = state.projectFolderOpeners ?? []
  const openProjectEntry: SessionHeaderMenuEntry = openers.length > 1
    ? {
        type: 'submenu',
        action: 'openProject',
        label: '打开项目文件夹',
        disabled: !state.canOpenProjectFolder,
        items: openers,
      }
    : {
        type: 'item',
        action: 'openProject',
        label: '打开项目文件夹',
        disabled: !state.canOpenProjectFolder,
      }

  return [
    { type: 'item', action: 'pin', label: state.pinned ? '取消置顶' : '置顶会话' },
    { type: 'item', action: 'followUp', label: state.needsFollowUp ? '取消待继续' : '标记为待继续' },
    { type: 'item', action: 'rename', label: '重命名' },
    { type: 'item', action: 'archive', label: state.archived ? '取消归档' : '归档' },
    { type: 'separator' },
    ...(state.includeSessionTools ? [
      { type: 'item', action: 'sessionTree', label: '会话树' } as const,
      { type: 'item', action: 'gallery', label: '生成图片画廊' } as const,
      { type: 'separator' } as const,
    ] : []),
    ...(state.canTransfer
      ? [{
          type: 'item',
          action: 'move',
          label: getAgentSessionTransferLabel(state.isDraft),
        } as const]
      : []),
    openProjectEntry,
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
