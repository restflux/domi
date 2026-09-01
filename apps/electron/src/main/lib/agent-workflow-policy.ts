import type { AgentWorkflow, PolicyDecision } from '@domi/shared'
import type { ExecutionPolicy } from './execution-policy/execution-policy.ts'
import type { AgentToolAnnotations } from './agent-tool-annotations.ts'
import { isReadOnlyBashCommandAllowlisted } from './execution-policy/shell-command-classifier.ts'
import { analyzeShellCommand, type ShellAnalysis } from './execution-policy/shell-analysis.ts'
import { isWithinWorkspace, resolvePortablePath } from './execution-policy/workspace-boundary.ts'

export interface PlanToolCall {
  toolName: string
  input: Record<string, unknown>
  cwd: string
  planSidecarDir: string
  interaction?: 'interactive' | 'unattended'
  toolSource?: 'host' | 'product' | 'builtin-mcp' | 'mcp' | 'resource'
  toolAnnotations?: AgentToolAnnotations
  signal?: AbortSignal
  toolCallId?: string
  displayName?: string
  shellAnalysis?: ShellAnalysis
}

export interface PlanToolAccessDecision {
  outcome: 'allow' | 'deny'
  reason: string
}

const RESTRICTED_HOST_READ_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'find',
  'ls',
  // 会话内可见进度只更新 Domi 的运行状态，不写项目、Local 或用户规划数据。
  'taskcreate',
  'taskupdate',
  'taskget',
  'tasklist',
  'todoread',
  'compactcontext',
])

const RESTRICTED_PRODUCT_READ_TOOLS = new Set([
  'taskcreate',
  'taskupdate',
  'taskget',
  'tasklist',
  'todoread',
])

const RESTRICTED_MANAGED_WEB_TOOLS = new Set(['websearch', 'webfetch'])

// Read Only / Plan First 约束本地写入，但不应阻断用户可见、宿主管理的网页调研。
// Browser Host 继续负责公开网络、页面身份、短生命周期 ref、凭据和触发来源等安全边界。
const RESTRICTED_MANAGED_BROWSER_TOOLS = new Set([
  'browseropen',
  'browsernavigate',
  'browsersnapshot',
  'browserclick',
  'browsertype',
  'browserscroll',
  'browserextract',
  'browserclose',
])

// Domi 内置生图在 session 输出模式下只创建会话附件，不修改 Session Target。
// workspace 输出仍必须走 Direct / 下一轮 Worktree，不能借此绕过项目写入边界。
const RESTRICTED_SESSION_IMAGE_TOOLS = new Set([
  'mcp__gpt_image__imagegen',
  'mcp__nano_banana__generate_image',
])

const RESTRICTED_READ_ONLY_CHROME_TOOLS = new Set([
  'mcp__chrome_devtools__list_pages',
  'mcp__chrome_devtools__take_snapshot',
  'mcp__chrome_devtools__take_screenshot',
  'mcp__chrome_devtools__list_network_requests',
  'mcp__chrome_devtools__performance_stop_trace',
])

const RESTRICTED_READ_ONLY_PLANNING_TOOLS = new Set([
  'mcp__planning__list_todos',
  'mcp__planning__get_todo',
  'mcp__planning__list_calendar_events',
  'mcp__planning__get_calendar_event',
  'mcp__planning__list_groups',
  'mcp__planning__list_tags',
  'mcp__planning__list_active_reminders',
])

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase()
}

function isHostTool(call: PlanToolCall): boolean {
  return call.toolSource === undefined || call.toolSource === 'host'
}

function restrictedWorkflowLabel(workflow: Exclude<AgentWorkflow, 'direct'>): string {
  return workflow === 'read-only' ? 'Read Only' : 'Plan First'
}

function hasTrustedReadOnlyCapability(call: PlanToolCall): boolean {
  return (call.toolSource === 'product' || call.toolSource === 'builtin-mcp' || call.toolSource === 'mcp')
    && call.toolAnnotations?.readOnlyHint === true
    && call.toolAnnotations.destructiveHint !== true
}

export function resolveRestrictedWorkflowToolAccess(
  call: PlanToolCall,
  workflow: Exclude<AgentWorkflow, 'direct'>,
): PlanToolAccessDecision {
  const toolName = normalizedToolName(call.toolName)
  const label = restrictedWorkflowLabel(workflow)

  if (call.interaction === 'unattended'
    && isHostTool(call)
    && (toolName === 'askuserquestion' || toolName === 'exitplanmode' || toolName === 'requestdirectworkflow')) {
    return { outcome: 'deny', reason: '无人值守调用不能等待用户交互' }
  }

  if (isHostTool(call) && RESTRICTED_HOST_READ_TOOLS.has(toolName)) {
    return { outcome: 'allow', reason: `${label} 允许明确的只读宿主工具` }
  }

  if (isHostTool(call) && toolName === 'bash') {
    const command = typeof call.input.command === 'string' ? call.input.command : ''
    const analysis = call.shellAnalysis ?? analyzeShellCommand(command)
    if (isReadOnlyBashCommandAllowlisted(command, analysis)) {
      return { outcome: 'allow', reason: `${label} 允许经过严格分类的只读终端命令` }
    }
    return {
      outcome: 'deny',
      reason: `${label} 只允许可证明为无副作用的终端读取；可使用有限的纯 stdout 管道，但每个 stage 都必须只读。若命令无法证明，请优先改用内置 Read、Grep、Find 或 Ls，或拆成更简单的单一读取；普通文件输出仍禁止。`,
    }
  }

  if (isHostTool(call) && toolName === 'askuserquestion') {
    return { outcome: 'allow', reason: `${label} 允许向用户补充提问` }
  }

  if (workflow === 'read-only' && isHostTool(call) && toolName === 'requestdirectworkflow') {
    return { outcome: 'allow', reason: 'Read Only 允许请求用户切换当前会话到 Direct' }
  }

  if (workflow === 'plan-first' && isHostTool(call)
    && (toolName === 'enterplanmode' || toolName === 'exitplanmode')) {
    return { outcome: 'allow', reason: 'Plan First 允许计划生命周期交互工具' }
  }

  if (workflow === 'plan-first' && isHostTool(call)
    && (toolName === 'write' || toolName === 'edit')) {
    const filePath = typeof call.input.file_path === 'string' ? call.input.file_path : ''
    const resolvedPath = resolvePortablePath(filePath, call.cwd)
    if (filePath.toLowerCase().endsWith('.md') && isWithinWorkspace(resolvedPath, call.planSidecarDir)) {
      return { outcome: 'allow', reason: '计划文件位于当前会话 sidecar 目录' }
    }
    return { outcome: 'deny', reason: 'Plan First 只能写入当前会话 sidecar 中的 Markdown 计划文件' }
  }

  if (call.toolSource === 'product' && RESTRICTED_MANAGED_BROWSER_TOOLS.has(toolName)) {
    return { outcome: 'allow', reason: `${label} 允许宿主管理的有界内置浏览器调研` }
  }

  if (hasTrustedReadOnlyCapability(call)) {
    return { outcome: 'allow', reason: `${label} 允许工具注册时声明的可信只读能力` }
  }

  if (call.toolSource === 'product' && RESTRICTED_PRODUCT_READ_TOOLS.has(toolName)) {
    return { outcome: 'allow', reason: `${label} 允许明确的只读 Domi 产品工具` }
  }

  if (call.toolSource === 'product' && RESTRICTED_MANAGED_WEB_TOOLS.has(toolName)) {
    return { outcome: 'allow', reason: `${label} 允许只读 Managed Web Access` }
  }

  if (call.toolSource === 'product' && RESTRICTED_SESSION_IMAGE_TOOLS.has(toolName)) {
    if (workflow === 'read-only' && (call.input.outputMode === undefined || call.input.outputMode === 'session')) {
      return { outcome: 'allow', reason: 'Read Only 允许仅创建会话附件的内置生图工具' }
    }
    if (call.input.outputMode === 'workspace') {
      return {
        outcome: 'deny',
        reason: workflow === 'read-only'
          ? '工作区生图会修改 Session Target；普通 Research 请先调用 RequestDirectWorkflow，已交付 follow-up 请按 Session Target 指引调用 RequestNextWorktreeIteration 或 RequestWorktreePreviewRevision。'
          : 'Plan First 不能创建工作区图片；请完成计划审批后再执行。',
      }
    }
  }

  if (call.toolSource === 'builtin-mcp' && RESTRICTED_READ_ONLY_CHROME_TOOLS.has(toolName)) {
    return { outcome: 'allow', reason: `${label} 明确允许的只读 Chrome 工具` }
  }
  if ((call.toolSource === undefined || call.toolSource === 'product')
    && RESTRICTED_READ_ONLY_PLANNING_TOOLS.has(toolName)) {
    return { outcome: 'allow', reason: `${label} 明确允许的只读 Planning 工具` }
  }

  return { outcome: 'deny', reason: `${label} 默认拒绝未明确证明为只读的工具` }
}

/** 兼容既有调用方名称；Plan First 在只读基线上额外开放 sidecar 计划写入。 */
export function resolvePlanToolAccess(call: PlanToolCall): PlanToolAccessDecision {
  return resolveRestrictedWorkflowToolAccess(call, 'plan-first')
}

export function resolveReadOnlyToolAccess(call: PlanToolCall): PlanToolAccessDecision {
  return resolveRestrictedWorkflowToolAccess(call, 'read-only')
}

export interface WorkflowToolAuthorizationInput {
  workflow: AgentWorkflow
  call: PlanToolCall
  executionPolicy: ExecutionPolicy
}

/**
 * 组合 Workflow 的本地只读硬约束与 Execution Policy。Read Only / Plan First
 * 允许已证明无副作用的读取，以及宿主管理的显式有界网页交互例外；
 * 本地读取可跳过只约束修改范围的 Workspace Boundary。
 */
export async function authorizeToolForWorkflow(
  input: WorkflowToolAuthorizationInput,
): Promise<PolicyDecision> {
  const call = input.call
  if (input.workflow === 'direct') {
    return input.executionPolicy.authorize({
      toolName: call.toolName,
      input: call.input,
      cwd: call.cwd,
      signal: call.signal,
      toolCallId: call.toolCallId,
      displayName: call.displayName,
      toolSource: call.toolSource,
      shellAnalysis: call.shellAnalysis,
    })
  }

  const workflowDecision = resolveRestrictedWorkflowToolAccess(call, input.workflow)
  if (workflowDecision.outcome === 'deny') {
    return { outcome: 'deny', category: 'routine', reason: workflowDecision.reason }
  }

  const toolName = normalizedToolName(call.toolName)
  if (isHostTool(call) && (RESTRICTED_HOST_READ_TOOLS.has(toolName) || toolName === 'bash')) {
    return input.executionPolicy.authorize({
      toolName: call.toolName,
      input: call.input,
      cwd: call.cwd,
      signal: call.signal,
      toolCallId: call.toolCallId,
      displayName: call.displayName,
      toolSource: call.toolSource ?? 'host',
      skipWorkspaceBoundary: true,
      shellAnalysis: call.shellAnalysis,
    })
  }

  return { outcome: 'allow', category: 'routine', reason: workflowDecision.reason }
}

export type AgentWorkflowEvent =
  | { type: 'enter-plan' }
  | { type: 'approve-plan' }
  | { type: 'approve-read-only' }
  | { type: 'feedback' }
  | { type: 'deny-plan' }

export interface AgentWorkflowTransition {
  workflow: AgentWorkflow
  outcome: 'allow' | 'deny'
}

export function transitionAgentWorkflow(
  current: AgentWorkflow,
  event: AgentWorkflowEvent,
): AgentWorkflowTransition {
  switch (event.type) {
    case 'enter-plan':
      return current === 'plan-first'
        ? { workflow: current, outcome: 'allow' }
        : { workflow: 'plan-first', outcome: 'allow' }
    case 'approve-plan':
      return current === 'plan-first'
        ? { workflow: 'direct', outcome: 'allow' }
        : { workflow: current, outcome: 'deny' }
    case 'approve-read-only':
      return current === 'read-only'
        ? { workflow: 'direct', outcome: 'allow' }
        : { workflow: current, outcome: 'deny' }
    case 'feedback':
    case 'deny-plan':
      return { workflow: current, outcome: 'deny' }
  }
}
