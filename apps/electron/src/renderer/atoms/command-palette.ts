/**
 * Command Palette 状态原子
 *
 * 管理命令面板的开关。面板组件挂在 AppShell，
 * 快捷键（默认 Cmd/Ctrl+P，id: command-palette）在 GlobalShortcuts 中切换此原子。
 */

import { atom } from 'jotai'

/** 命令面板是否打开 */
export const commandPaletteOpenAtom = atom(false)
