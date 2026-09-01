/**
 * Agent headless runner 注册表
 *
 * 用于主进程内置工具在不直接 import agent-service.ts 的情况下启动/停止真实 Agent 会话，
 * 避免 AgentOrchestrator 与 agent-service 形成难以维护的循环依赖。
 */

import type {
  AgentExternalRunSource,
  AgentSendInput,
} from '@domi/shared'
import type { AgentStopSource } from './agent-stop-source.ts'

export interface HeadlessAgentRunCallbacks {
  onError: (error: string) => void
  onComplete: () => void
  onTitleUpdated: (title: string) => void
  source?: AgentExternalRunSource
  /** 发起此次 headless 运行的可见会话，用于将事件路由回其 renderer。 */
  originSessionId?: string
  /** Worktree handoff 的主进程一次性激活凭据；普通外部运行不设置。 */
  activationToken?: string
}

export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
) => Promise<void>

export type AgentStopper = (sessionId: string, source?: AgentStopSource) => void
export type AgentActiveChecker = (sessionId: string) => boolean

let headlessRunner: HeadlessAgentRunner | null = null
let agentStopper: AgentStopper | null = null
let agentActiveChecker: AgentActiveChecker | null = null

export function setHeadlessAgentRunner(runner: HeadlessAgentRunner): void {
  headlessRunner = runner
}

export function setAgentStopper(stopper: AgentStopper): void {
  agentStopper = stopper
}

export function setAgentActiveChecker(checker: AgentActiveChecker): void {
  agentActiveChecker = checker
}

export async function runRegisteredHeadlessAgent(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
): Promise<void> {
  if (!headlessRunner) {
    throw new Error('Agent headless runner 尚未初始化')
  }
  await headlessRunner(input, callbacks)
}

export function stopRegisteredAgent(sessionId: string, source: AgentStopSource = 'unknown'): void {
  if (!agentStopper) {
    throw new Error('Agent stopper 尚未初始化')
  }
  agentStopper(sessionId, source)
}

/**
 * 查询主进程内 Agent 运行态。注册表尚未初始化时按非运行处理，
 * 避免只读全局投影在启动早期反向拉起 agent-service 的完整依赖图。
 */
export function isRegisteredAgentActive(sessionId: string): boolean {
  return agentActiveChecker?.(sessionId) ?? false
}
