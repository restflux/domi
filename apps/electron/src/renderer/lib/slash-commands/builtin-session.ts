/**
 * 内置会话控制命令 — 第一批（用户方案「键盘控制台」）。
 *
 * execute 不直接持有 React 状态：需要打开面板 / 切换工作方式等操作时，
 * 通过 SlashCommandHost（由 AgentView 注册）路由到既有组件与 IPC 链路。
 * `/plan` 是当前任务的一次性 Plan First 入口；/direct /read-only 仅保留兼容快捷命令。
 */
import { registerSlashCommand } from './registry'
import type { AgentWorkflow } from '@domi/shared'

export interface SlashCommandHost {
  openStatusCard: () => void
  openModelSelector: () => void
  openReasoningPicker: () => void
  openWorkflowPicker: () => void
  openSessionTree: () => void
  openForkPicker: () => void
  /** 直接切换持久工作方式（Plan First 只能由当前任务的 /plan 进入）。 */
  setWorkflow: (workflow: Exclude<AgentWorkflow, 'plan-first'>) => void
}

let host: SlashCommandHost | null = null

export function setSlashCommandHost(next: SlashCommandHost | null): void {
  host = next
}

export function registerBuiltinSlashCommands(): void {
  registerSlashCommand({
    id: 'compact',
    label: '压缩上下文',
    description: '手动压缩当前上下文，可补充压缩重点',
    group: 'session',
    behavior: 'insert',
    insertText: '/compact ',
  })

  registerSlashCommand({
    id: 'status',
    label: '查看会话状态',
    description: '显示当前会话运行状态',
    group: 'session',
    behavior: 'execute',
    execute: () => host?.openStatusCard(),
  })

  registerSlashCommand({
    id: 'model',
    label: '切换模型',
    description: '打开当前会话的模型选择器',
    group: 'session',
    behavior: 'execute',
    execute: () => host?.openModelSelector(),
  })

  registerSlashCommand({
    id: 'reasoning',
    aliases: ['thinking', 'effort'],
    label: '调整推理深度',
    description: '设置当前模型的推理等级',
    group: 'session',
    behavior: 'execute',
    execute: () => host?.openReasoningPicker(),
  })

  registerSlashCommand({
    id: 'workflow',
    label: '切换工作方式',
    description: '研究 / 执行',
    group: 'session',
    behavior: 'execute',
    execute: () => host?.openWorkflowPicker(),
  })

  registerSlashCommand({
    id: 'plan',
    label: '本次先规划，批准后执行',
    description: '本次先规划，批准后执行',
    group: 'session',
    behavior: 'insert',
    insertText: '/plan ',
  })

  // 兼容快捷命令：菜单不展示，直接输入旧命令仍可切换。
  registerSlashCommand({
    id: 'direct',
    label: '切换到执行',
    description: '立即修改和验证，越界操作仍单独确认',
    group: 'session',
    behavior: 'execute',
    hidden: true,
    execute: () => host?.setWorkflow('direct'),
  })

  registerSlashCommand({
    id: 'read-only',
    label: '切换到研究',
    description: '只读调研，需要修改时先征求确认',
    group: 'session',
    behavior: 'execute',
    hidden: true,
    execute: () => host?.setWorkflow('read-only'),
  })

  registerSlashCommand({
    id: 'tree',
    label: '打开会话树',
    description: '查看当前会话的 Session Tree',
    group: 'session',
    behavior: 'execute',
    execute: () => host?.openSessionTree(),
  })

  registerSlashCommand({
    id: 'fork',
    label: 'Fork 当前会话',
    description: 'Fork 为普通会话或 Managed Worktree',
    group: 'session',
    behavior: 'execute',
    execute: () => host?.openForkPicker(),
  })
}
