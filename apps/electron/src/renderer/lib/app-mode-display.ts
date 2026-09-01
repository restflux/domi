import type { AppMode } from '../atoms/app-mode'

export interface AppModeDisplay {
  label: string
  description: string
}

/**
 * 面向用户的模式名称。内部持久化值继续使用 `agent`，产品界面统一展示为 Work。
 */
export const APP_MODE_DISPLAY: Record<AppMode, AppModeDisplay> = {
  agent: {
    label: 'Work',
    description: '操作项目、文件和工具，持续执行任务',
  },
  chat: {
    label: 'Chat',
    description: '轻量问答、讨论和内容生成',
  },
  scratch: {
    label: 'Scratch Pad',
    description: '随手记录和整理草稿',
  },
}
