/**
 * Slash 命令体系 — 共享类型。
 *
 * `/` 被定位为「当前 Agent 会话的键盘控制台」：系统命令（会话控制 / Domi 入口）
 * 与 Skill 显式调用共用 `/` 菜单。本模块只描述结构与纯逻辑，不依赖 React 组件；
 * 命令的 execute 实现由 AgentView / SlashStatusCard 等挂载点注入。
 */
import type { Atom } from 'jotai'

export type SlashCommandGroup = 'session' | 'domi' | 'skill'

/**
 * 命令行为：
 * - execute：选中后立即执行（如 /status 打开状态卡、/tree 打开会话树）
 * - picker：选中后打开子菜单（如 /workflow、/reasoning、/fork）
 * - insert：选中后在输入框填入文本，等待用户补充后发送（如 /compact）
 * - skill：Skill 显式调用，保持现有 mention 节点插入路径
 */
export type SlashCommandBehavior = 'execute' | 'picker' | 'insert' | 'skill'

/** 执行命令时可用到的会话上下文。getState 抽象 Jotai store，便于纯函数单测。 */
export interface SlashCommandContext {
  sessionId: string
  getState: <T>(atom: Atom<T>) => T
  workspaceSlug?: string | null
  isStreaming: boolean
}

export interface SlashCommandDefinition {
  /** 命令名（不含 '/'），如 'status'。 */
  id: string
  /** 快捷别名（不含 '/'），如 /plan → workflow。 */
  aliases?: string[]
  /** 菜单显示名。 */
  label: string
  description: string
  group: SlashCommandGroup
  behavior: SlashCommandBehavior
  /** 动态可用性；缺省始终可用。 */
  isAvailable?: (ctx: SlashCommandContext) => boolean
  /** 隐藏命令：可通过别名/直接输入触发，但不显示在 `/` 菜单（如兼容的 /direct）。 */
  hidden?: boolean
  /** behavior=insert 时填入输入框的文本（含尾随空格，如 '/compact '）。 */
  insertText?: string
  /** behavior=execute / picker 时执行；args 为命令后剩余参数（按空格拆分）。 */
  execute?: (ctx: SlashCommandContext, args: string[]) => void
}

/** 传入菜单合并的 Skill 条目（来自 workspace capabilities）。 */
export interface SlashSkillEntry {
  id: string
  name: string
  description?: string
  sourceLabel?: string
}

export interface SlashMenuItem {
  kind: 'command' | 'skill'
  id: string
  /** 菜单展示标签，命令为 /status，Skill 为 /coach。 */
  label: string
  /** 可读名称：命令的 label，Skill 的 name。 */
  name: string
  description: string
  group: SlashCommandGroup
  behavior: SlashCommandBehavior
  sourceLabel?: string
  /** insert 命令填入输入框的文本（含尾随空格）。 */
  insertText?: string
  /** 该行是否展示在菜单（hidden 命令不会生成菜单项）。 */
  hidden?: boolean
}
