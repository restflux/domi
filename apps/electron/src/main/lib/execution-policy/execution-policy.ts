import type {
  ExecutionPolicyMode,
  PolicyApprovalRequest,
  PolicyApprovalScope,
  PolicyApprovalResponse,
  PolicyDecision,
} from '@domi/shared'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { normalizeToolAction } from './tool-action-normalizer.ts'
import {
  extractDirectDeletionPaths,
  extractVariableResolvedDeletionPaths,
  hasUnresolvedDirectDeletion,
  hasExternalImpact,
  isCodeExecutionCommand,
  isDestructiveGitCommand,
  isKnownValidationCommand,
  isKnownReadOnlyCommand,
  isReadOnlyBashCommandAllowlisted,
  mayUseProcessNetwork,
} from './shell-command-classifier.ts'
import { findWorkspaceBoundaryCrossing, isWithinWorkspace, resolvePortablePath } from './workspace-boundary.ts'
import { analyzeShellCommand, initializeShellAnalysis, type ShellAnalysis } from './shell-analysis.ts'
import { findDeletedLocalBaselinePath } from './local-baseline.ts'
import { canonicalizePath } from './path-canonicalizer.ts'

export interface ToolCallContext {
  toolName: string
  input: Record<string, unknown>
  cwd?: string
  signal?: AbortSignal
  toolCallId?: string
  displayName?: string
  toolSource?: 'host' | 'product' | 'builtin-mcp' | 'mcp' | 'resource'
  /** 请求纯读取不受 Workspace Boundary 限制；Policy 仅会对规范化后仍可证明只读的动作采纳。 */
  skipWorkspaceBoundary?: boolean
  /** Controller 对当前 Bash source 生成的唯一 Canonical Shell Analysis。 */
  shellAnalysis?: ShellAnalysis
}

export interface PolicyApprovalAdapterContext {
  call: ToolCallContext
  signal?: AbortSignal
}

export interface ExecutionPolicy {
  authorize(call: ToolCallContext): Promise<PolicyDecision>
}

export interface ExecutionPolicyAuditEvent {
  sessionId?: string
  workspaceId?: string
  toolName: string
  action: string
  outcome: PolicyDecision['outcome']
  category: PolicyDecision['category']
  approval?: PolicyApprovalScope
  executionPolicy: ExecutionPolicyMode
  decisionCode: string
  shellAnalysisStatus?: 'static' | 'opaque' | 'invalid'
  shellStageCount?: number
  shellReasonCodes?: string[]
  durationMs: number
}

export interface ExecutionPolicyOptions {
  executionPolicy?: ExecutionPolicyMode | (() => ExecutionPolicyMode)
  sessionId?: string
  workspaceId?: string
  workspaceRoot?: string
  interaction?: 'interactive' | 'unattended'
  localBaselineRoot?: string
  localBaselinePaths?: readonly string[]
  localBaselineStatus?: 'captured' | 'unknown'
  /** 允许信任 PowerShell 静态变量求值所得删除路径的宿主管理目录（通常为 session workbench/.context）。 */
  trustedVariableDeletionRoots?: readonly string[]
  canonicalize?: (path: string) => Promise<string>
  requestApproval?: (
    request: PolicyApprovalRequest,
    context: PolicyApprovalAdapterContext,
  ) => Promise<PolicyApprovalResponse>
  audit?: (event: ExecutionPolicyAuditEvent) => void | Promise<void>
}

interface ResolvedExecutionPolicyOptions {
  executionPolicy: () => ExecutionPolicyMode
  sessionId?: string
  workspaceId?: string
  workspaceRoot: string
  interaction: 'interactive' | 'unattended'
  localBaselineRoot: string
  localBaselinePaths: readonly string[]
  localBaselineStatus: 'captured' | 'unknown'
  trustedVariableDeletionRoots: readonly string[]
  canonicalize: (path: string) => Promise<string>
  requestApproval: (
    request: PolicyApprovalRequest,
    context: PolicyApprovalAdapterContext,
  ) => Promise<PolicyApprovalResponse>
  audit: (event: ExecutionPolicyAuditEvent) => void | Promise<void>
}

export type PolicyResolution =
  | { kind: 'allow'; reason: string; decisionCode: string }
  | {
      kind: 'require-approval'
      category: PolicyApprovalRequest['category']
      reason: string
      decisionCode: string
    }
  | {
      kind: 'deny'
      category: 'user-denied' | 'unattended'
      reason: string
      decisionCode: string
    }

/**
 * 敏感文件清单：写入这些文件可能造成凭据/配置泄露或被用于代码执行。
 * 参考 Open-ClaudeCode src/utils/permissions/filesystem.ts 的 DANGEROUS_FILES，
 * 并按 Domi 场景扩展（.npmrc/.env）。
 */
const SENSITIVE_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
  '.npmrc',
  '.env',
])

/** 主目录下不允许自动写入的敏感目录（如 ~/.ssh/）。 */
const SENSITIVE_HOME_DIRECTORIES = new Set(['.ssh'])

async function arePathsWithinTrustedRoots(input: {
  paths: readonly string[]
  roots: readonly string[]
  cwd: string
  workspaceRoot: string
  canonicalize: (path: string) => Promise<string>
}): Promise<boolean> {
  if (input.paths.length === 0 || input.roots.length === 0) return false
  try {
    const resolvedCwd = resolvePortablePath(input.cwd, input.workspaceRoot)
    const [paths, roots] = await Promise.all([
      Promise.all(input.paths.map((path) => input.canonicalize(resolvePortablePath(path, resolvedCwd)))),
      Promise.all(input.roots.map((root) => input.canonicalize(resolvePortablePath(root, input.workspaceRoot)))),
    ])
    return paths.every((path) => roots.some((root) => isWithinWorkspace(path, root)))
  } catch {
    return false
  }
}

async function mayPathsTouchRoot(input: {
  paths: readonly string[]
  root: string
  cwd: string
  workspaceRoot: string
  canonicalize: (path: string) => Promise<string>
}): Promise<boolean> {
  if (input.paths.length === 0) return false
  try {
    const resolvedCwd = resolvePortablePath(input.cwd, input.workspaceRoot)
    const root = await input.canonicalize(resolvePortablePath(input.root, input.workspaceRoot))
    const paths = await Promise.all(input.paths.map((path) => input.canonicalize(resolvePortablePath(path, resolvedCwd))))
    return paths.some((path) => isWithinWorkspace(path, root) || isWithinWorkspace(root, path))
  } catch {
    return true
  }
}

interface PolicyResolutionFacts {
  executionPolicy: ExecutionPolicyMode
  deletedBaselinePath?: string
  unresolvedShellDeletion: boolean
  hasLocalBaseline: boolean
  localBaselineStatus: 'captured' | 'unknown'
  deletionMayTouchLocalBaselineRoot: boolean
  destructiveGit: boolean
  externalImpact: boolean
  sensitiveFileHit?: string
  processNetwork: boolean
  codeExecution: boolean
  boundaryCrossing?: string
  opaqueAction: boolean
  shellAction: boolean
  shellIsRoutine: boolean
  shellAnalysis?: ShellAnalysis
  aborted: boolean
  interaction: 'interactive' | 'unattended'
}

/**
 * 把已计算的权限 facts 收口为唯一强类型决定。它不执行 UI、审计或工具调用，
 * 调用方只需处理 allow / require-approval / deny 三种结果。
 */
export function resolvePolicyDecision(facts: PolicyResolutionFacts): PolicyResolution {
  if (facts.aborted) {
    return { kind: 'deny', category: 'user-denied', reason: '操作已中止', decisionCode: 'operation-aborted' }
  }
  if (facts.executionPolicy === 'full-access') {
    return { kind: 'allow', reason: 'Full Access 已由用户明确选择，普通工具风险由用户承担', decisionCode: 'full-access-bypass' }
  }

  const requireApproval = (
    category: Extract<PolicyResolution, { kind: 'require-approval' }>['category'],
    reason: string,
    decisionCode: string,
  ): PolicyResolution => {
    if (facts.interaction === 'unattended') {
      return {
        kind: 'deny', category: 'unattended',
        reason: `无人值守调用需要审批，已拒绝: ${reason}`,
        decisionCode: `unattended-${decisionCode}`,
      }
    }
    return { kind: 'require-approval', category, reason, decisionCode }
  }

  if (facts.deletedBaselinePath) {
    return requireApproval('local-baseline', `操作将删除 Local Baseline: ${facts.deletedBaselinePath}`, 'local-baseline-delete')
  }
  if (facts.unresolvedShellDeletion && (facts.hasLocalBaseline || facts.localBaselineStatus === 'unknown')) {
    return requireApproval('local-baseline', '删除命令包含动态目标，无法证明不会破坏 Local Baseline', 'local-baseline-dynamic-delete')
  }
  if (facts.deletionMayTouchLocalBaselineRoot && facts.localBaselineStatus === 'unknown') {
    return requireApproval('local-baseline', 'Local Baseline 捕获失败，无法证明删除不会破坏运行前已有工作', 'local-baseline-unknown')
  }
  if (facts.destructiveGit) {
    return requireApproval('destructive-git', '破坏性 Git 操作可能丢弃当前 Session Target 中的现有工作', 'session-target-destructive-git')
  }
  if (facts.externalImpact) {
    return requireApproval('external-impact', '当前 Execution Policy 要求确认远端推送、发布或部署', 'external-impact')
  }
  if (facts.sensitiveFileHit) {
    return requireApproval('sensitive-file', `写入敏感文件可能造成凭据/配置泄露: ${facts.sensitiveFileHit}`, 'sensitive-file-write')
  }
  if (facts.processNetwork) {
    return requireApproval('process-network', 'Agent 进程将发起网络访问', 'process-network')
  }
  if (facts.codeExecution) {
    return requireApproval('opaque-command', '解释器/包运行器将执行任意代码，无法证明仅产生安全的项目内副作用', 'code-execution')
  }
  if (facts.boundaryCrossing) {
    return requireApproval('workspace-boundary', `目标越过 Workspace Boundary: ${facts.boundaryCrossing}`, 'workspace-boundary')
  }
  if (facts.opaqueAction || (facts.shellAction && !facts.shellIsRoutine)) {
    return facts.shellAction && facts.shellAnalysis?.status !== 'static'
      ? requireApproval(
          'opaque-command',
          `无法可靠解析 Shell 结构，已保守请求确认（${facts.shellAnalysis?.reasonCodes.join(', ') || 'unknown'}）`,
          `shell-analysis-${facts.shellAnalysis?.status ?? 'unknown'}`,
        )
      : requireApproval('opaque-command', '无法证明该工具调用仅产生安全的项目内副作用', 'opaque-tool-action')
  }
  return { kind: 'allow', reason: '常规操作', decisionCode: 'routine' }
}

export async function findSensitiveFileHit(
  paths: readonly string[],
  canonicalize: (path: string) => Promise<string>,
): Promise<string | undefined> {
  const homeDir = homedir()
  for (const path of paths) {
    if (!path) continue
    let canonical: string
    try {
      canonical = await canonicalize(path)
    } catch {
      continue
    }
    const normalized = canonical.replace(/[\\/]+$/, '')
    if (SENSITIVE_FILES.has(basename(normalized))) return canonical
    for (const sensitiveDir of SENSITIVE_HOME_DIRECTORIES) {
      const sensitiveHomePath = join(homeDir, sensitiveDir)
      if (normalized === sensitiveHomePath || normalized.startsWith(sensitiveHomePath + sep)) {
        return canonical
      }
    }
  }
  return undefined
}

class DefaultExecutionPolicy implements ExecutionPolicy {
  constructor(private readonly options: ResolvedExecutionPolicyOptions) {}

  async authorize(call: ToolCallContext): Promise<PolicyDecision> {
    const startedAt = Date.now()
    const shellToolName = ['bash', 'shell', 'powershell', 'command'].includes(call.toolName.toLowerCase().replace(/[^a-z]/g, ''))
    if (shellToolName && typeof call.input.command === 'string' && !call.shellAnalysis) await initializeShellAnalysis()
    const canonicalShellAnalysis = shellToolName && typeof call.input.command === 'string'
      ? call.shellAnalysis ?? analyzeShellCommand(call.input.command.trim())
      : undefined
    const action = normalizeToolAction(call.toolName, call.input, canonicalShellAnalysis)
    const managedWebTool = call.toolSource === 'product'
      && (call.toolName === 'WebSearch' || call.toolName === 'WebFetch')
    const externallyOwnedTool = call.toolSource !== undefined
      && call.toolSource !== 'host'
      && !managedWebTool
    const executionPolicy = this.options.executionPolicy()
    const restrictedWorkflowShellRead = call.skipWorkspaceBoundary === true
      && action.kind === 'shell'
      && isReadOnlyBashCommandAllowlisted(action.command, canonicalShellAnalysis)
    const boundaryExemptRead = call.skipWorkspaceBoundary === true
      && ((action.kind === 'file' && action.operation === 'read') || restrictedWorkflowShellRead)
    const boundaryCrossing = boundaryExemptRead || executionPolicy === 'full-access'
      ? undefined
      : await findWorkspaceBoundaryCrossing({
          paths: action.paths,
          cwd: call.cwd ?? this.options.workspaceRoot,
          workspaceRoot: this.options.workspaceRoot,
          canonicalize: this.options.canonicalize,
        })
    const shellAnalysis = canonicalShellAnalysis
    const deletionPaths = action.kind === 'file' && action.operation === 'delete'
      ? action.paths
      : action.kind === 'shell'
        ? extractDirectDeletionPaths(action.command, canonicalShellAnalysis)
        : []
    const variableResolvedDeletionPaths = executionPolicy !== 'full-access' && action.kind === 'shell'
      ? extractVariableResolvedDeletionPaths(action.command, canonicalShellAnalysis)
      : []
    const variableResolvedDeletionTrusted = executionPolicy !== 'full-access' && await arePathsWithinTrustedRoots({
      paths: variableResolvedDeletionPaths,
      roots: this.options.trustedVariableDeletionRoots,
      cwd: call.cwd ?? this.options.workspaceRoot,
      workspaceRoot: this.options.workspaceRoot,
      canonicalize: this.options.canonicalize,
    })
    const unresolvedShellDeletion = executionPolicy !== 'full-access'
      && action.kind === 'shell'
      && (hasUnresolvedDirectDeletion(action.command, canonicalShellAnalysis)
        || (variableResolvedDeletionPaths.length > 0 && !variableResolvedDeletionTrusted))
    const deletionMayTouchLocalBaselineRoot = executionPolicy !== 'full-access'
      && (unresolvedShellDeletion
        || await mayPathsTouchRoot({
          paths: deletionPaths,
          root: this.options.localBaselineRoot,
          cwd: call.cwd ?? this.options.workspaceRoot,
          workspaceRoot: this.options.workspaceRoot,
          canonicalize: this.options.canonicalize,
        }))
    const deletedBaselinePath = executionPolicy !== 'full-access'
      ? await findDeletedLocalBaselinePath({
          operation: deletionPaths.length > 0 ? 'delete' : 'read',
          targetPaths: deletionPaths,
          localBaselinePaths: this.options.localBaselinePaths,
          cwd: call.cwd ?? this.options.workspaceRoot,
          workspaceRoot: this.options.workspaceRoot,
          canonicalize: this.options.canonicalize,
        })
      : undefined
    const destructiveGit = executionPolicy !== 'full-access'
      && action.kind === 'shell'
      && isDestructiveGitCommand(action.command, canonicalShellAnalysis)
    const externalImpact = action.kind === 'shell'
      && executionPolicy !== 'full-access'
      && hasExternalImpact(action.command, canonicalShellAnalysis)
    const sensitiveFileHit = executionPolicy !== 'full-access'
      && action.kind === 'file'
      && action.operation !== 'read'
      ? await findSensitiveFileHit(action.paths, this.options.canonicalize)
      : undefined
    const codeExecution = action.kind === 'shell'
      && executionPolicy !== 'full-access'
      && isCodeExecutionCommand(action.command, canonicalShellAnalysis)
    const processNetwork = action.kind === 'shell'
      && executionPolicy !== 'full-access'
      && mayUseProcessNetwork(action.command, canonicalShellAnalysis)
    const opaqueAction = executionPolicy !== 'full-access'
      && (externallyOwnedTool
        || (action.kind === 'unknown' && !managedWebTool)
        || (action.kind === 'file' && action.operation !== 'read' && action.paths.length === 0))
    const shellIsRoutine = action.kind === 'shell'
      && (executionPolicy === 'full-access'
        || restrictedWorkflowShellRead
        || isKnownReadOnlyCommand(action.command, canonicalShellAnalysis)
        || isKnownValidationCommand(action.command, canonicalShellAnalysis))
    const resolution = resolvePolicyDecision({
      executionPolicy,
      deletedBaselinePath,
      unresolvedShellDeletion,
      hasLocalBaseline: this.options.localBaselinePaths.length > 0,
      localBaselineStatus: this.options.localBaselineStatus,
      deletionMayTouchLocalBaselineRoot,
      destructiveGit,
      externalImpact,
      sensitiveFileHit,
      processNetwork,
      codeExecution,
      boundaryCrossing,
      opaqueAction,
      shellAction: action.kind === 'shell',
      shellIsRoutine,
      shellAnalysis,
      aborted: call.signal?.aborted === true,
      interaction: this.options.interaction,
    })

    const decision = resolution.kind === 'require-approval'
      ? await this.requireApproval(call, resolution)
      : resolution.kind === 'deny'
        ? { outcome: 'deny' as const, category: resolution.category, reason: resolution.reason }
        : { outcome: 'allow' as const, category: 'routine' as const, reason: resolution.reason }
    await this.recordAudit({
      ...(this.options.sessionId && { sessionId: this.options.sessionId }),
      ...(this.options.workspaceId && { workspaceId: this.options.workspaceId }),
      toolName: call.toolName,
      action: action.kind,
      outcome: decision.outcome,
      category: decision.category,
      ...('approval' in decision && decision.approval ? { approval: decision.approval } : {}),
      executionPolicy,
      decisionCode: resolution.decisionCode,
      ...(shellAnalysis && {
        shellAnalysisStatus: shellAnalysis.status,
        shellStageCount: shellAnalysis.stages.length,
        shellReasonCodes: shellAnalysis.reasonCodes,
      }),
      durationMs: Date.now() - startedAt,
    })
    return decision
  }

  private async recordAudit(event: ExecutionPolicyAuditEvent): Promise<void> {
    try {
      await this.options.audit(event)
    } catch {
      // 遥测存储故障不得改写或绕过已经作出的权限决定。
    }
  }

  private async requireApproval(
    call: ToolCallContext,
    resolution: Extract<PolicyResolution, { kind: 'require-approval' }>,
  ): Promise<PolicyDecision> {
    const response = await this.options.requestApproval({
      scope: 'single',
      category: resolution.category,
      reason: resolution.reason,
      toolName: call.toolName,
      decisionCode: resolution.decisionCode,
    }, { call, signal: call.signal })
    return response === 'approved'
      ? { outcome: 'allow', category: resolution.category, approval: 'single', reason: resolution.reason }
      : { outcome: 'deny', category: 'user-denied', reason: '用户拒绝了此操作' }
  }
}

function resolveExecutionPolicyMode(
  mode: ExecutionPolicyOptions['executionPolicy'],
): () => ExecutionPolicyMode {
  if (typeof mode === 'function') return mode
  const fixedMode = mode ?? 'controlled'
  return () => fixedMode
}

export function createExecutionPolicy(options: ExecutionPolicyOptions = {}): ExecutionPolicy {
  return new DefaultExecutionPolicy({
    executionPolicy: resolveExecutionPolicyMode(options.executionPolicy),
    ...(options.sessionId && { sessionId: options.sessionId }),
    ...(options.workspaceId && { workspaceId: options.workspaceId }),
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    interaction: options.interaction ?? 'interactive',
    localBaselineRoot: options.localBaselineRoot ?? options.workspaceRoot ?? process.cwd(),
    localBaselinePaths: options.localBaselinePaths ?? [],
    localBaselineStatus: options.localBaselineStatus ?? 'captured',
    trustedVariableDeletionRoots: options.trustedVariableDeletionRoots ?? [],
    canonicalize: options.canonicalize ?? canonicalizePath,
    requestApproval: options.requestApproval ?? (async () => 'denied'),
    audit: options.audit ?? (() => undefined),
  })
}
