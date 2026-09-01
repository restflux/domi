import { mkdir } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY } from '@domi/shared'
import type {
  AgentWorkflow,
  ExecutionPolicyMode,
  PolicyApprovalRequest,
  PolicyApprovalResponse,
} from '@domi/shared'
import type { CanUseToolOptions, PermissionResult } from './agent-permission-service.ts'
import { validateToolInput } from './agent-tool-input-validator.ts'
import { estimateTokenCount, WRITE_CONTENT_TOKEN_THRESHOLD } from './agent-tool-token-estimator.ts'
import { authorizeToolForWorkflow, transitionAgentWorkflow } from './agent-workflow-policy.ts'
import {
  createExecutionPolicy,
  type ExecutionPolicyAuditEvent,
  type PolicyApprovalAdapterContext,
} from './execution-policy/execution-policy.ts'
import { captureLocalBaseline } from './execution-policy/local-baseline.ts'
import { canonicalizePath } from './execution-policy/path-canonicalizer.ts'
import {
  analyzeShellCommand,
  initializeShellAnalysis,
  type ShellAnalysis,
  type ShellCommandStage,
} from './execution-policy/shell-analysis.ts'
import {
  extractCommandPathCandidates,
  extractGitWorktreeAddPaths,
  hasGitWorktreeAddInvocation,
  hasUnresolvedDirectDeletion,
  isDestructiveGitCommand,
  isKnownReadOnlyCommand,
} from './execution-policy/shell-command-classifier.ts'
import { normalizeToolAction } from './execution-policy/tool-action-normalizer.ts'
import { isWithinWorkspace, normalizeMsysPath, resolvePortablePath } from './execution-policy/workspace-boundary.ts'

export type PiExecutionAuthorizationRequest =
  | {
      type: 'tool'
      toolName: string
      input: Record<string, unknown>
      options: CanUseToolOptions
    }
  | {
      type: 'ask-user' | 'exit-plan' | 'request-direct-workflow'
      input: Record<string, unknown>
      signal: AbortSignal
    }

export type PiExecutionAuthorize = (
  request: PiExecutionAuthorizationRequest,
) => Promise<PermissionResult>

export interface PiExecutionControllerOptions {
  sessionId: string
  workspaceId?: string
  /** 当前 checkout 的 Workspace Boundary root。 */
  workspaceRoot: string
  /** 已由 Session Checkout 宿主解析的目标身份；权限策略不得从路径名称猜测。 */
  sessionTarget?: {
    kind: 'local' | 'isolated'
    ownership: 'owner' | 'inherited'
    followupOnly?: boolean
  }
  /** 真实 Local Checkout root，只用于运行前 Local Baseline 捕获。 */
  localBaselineRoot: string
  /** 当前会话私有工作台；不得在其中嵌套创建非托管 Git worktree。 */
  sessionWorkbenchRoot?: string
  planSidecarDir: string
  interaction: 'interactive' | 'unattended'
  getExecutionPolicy: () => ExecutionPolicyMode
  getWorkflow: () => AgentWorkflow
  /** 交互审批返回后复核 controller 仍属于创建它的精确 run。 */
  isRunActive?: () => boolean
  /** 重新验证当前会话是否仍持有精确普通 push grant。 */
  hasGitPushSessionTrust?: () => Promise<boolean>
  /** 为专用产品工具创建绑定当前 checkout/remote/ref 的普通 push 会话授权。 */
  requestGitPushSessionTrust?: (
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  requestApproval: (
    request: PolicyApprovalRequest,
    context: PolicyApprovalAdapterContext,
  ) => Promise<PolicyApprovalResponse>
  /** Host-owned product tool approval may return an edited, validated input. */
  requestProductToolApproval?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  audit: (event: ExecutionPolicyAuditEvent) => void | Promise<void>
  askUser: (input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult>
  exitPlan: (input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult & {
    executionScope?: 'run' | 'session'
  }>
  onWorkflowChanged: (
    workflow: AgentWorkflow,
    source:
      | 'enter-plan'
      | 'approve-plan-once'
      | 'approve-plan-persistent'
      | 'approve-read-only-once'
      | 'approve-read-only-persistent',
  ) => boolean | Promise<boolean>
}

/**
 * 构造一次 Pi run 的授权模块。调用方只注入运行上下文和交互适配器，
 * 所有工具验证、Workflow/Execution Policy 组合及交互路由都通过单一 authorize seam。
 */
function isPortableAbsolutePath(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

function containsDynamicPathSyntax(path: string): boolean {
  return /[$%`~]/.test(path)
    || (process.platform === 'win32' && path.startsWith('/'))
}

function gitGlobalArgsMayMatch(
  argvParts: readonly (string | undefined)[],
  predicate: (token: string) => boolean,
): boolean {
  for (const token of argvParts.slice(1)) {
    if (token === undefined) return true
    if (!token.startsWith('-')) return false
    if (predicate(token)) return true
  }
  return false
}

function stageExecutableName(stage: ShellCommandStage): string | undefined {
  return stage.executable.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().replace(/\.exe$/, '')
}

function wrapperWorkingDirectory(stage: ShellCommandStage): string | undefined {
  const executable = stageExecutableName(stage)
  const parts = stage.argvParts.slice(1)
  const valueFor = (shortOption: string, longOption: string): string | undefined => {
    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index]
      if (token === shortOption || token === longOption) return parts[index + 1]
      if (token?.startsWith(`${longOption}=`)) return token.slice(longOption.length + 1)
    }
    return undefined
  }
  if (executable === 'env') return valueFor('-C', '--chdir')
  if (executable === 'sudo') return valueFor('-D', '--chdir')
  if (executable === 'start-process' || executable === 'saps' || executable === 'start') {
    return valueFor('-WorkingDirectory', '-WorkingDirectory')
  }
  return undefined
}

function commandChangesWorkingDirectory(command: string, analysis = analyzeShellCommand(command)): boolean {
  return analysis.stages.some((stage) => {
    const executable = stageExecutableName(stage)
    if (executable && ['cd', 'pushd', 'set-location'].includes(executable)) return true
    if (wrapperWorkingDirectory(stage) !== undefined) return true
    return executable === 'git' && gitGlobalArgsMayMatch(stage.argvParts, (token) => token === '-C' || token.startsWith('-C='))
  })
}

async function commandRepositoryContextEscapesTarget(
  command: string,
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
  analysis = analyzeShellCommand(command),
): Promise<boolean> {
  const targetEscapes = async (rawTarget: string | undefined): Promise<boolean> => {
    if (!rawTarget || containsDynamicPathSyntax(rawTarget)) return true
    try {
      const canonical = await canonicalizePath(resolvePortablePath(normalizeMsysPath(rawTarget), workspaceRoot))
      return !isWithinWorkspace(canonical, canonicalWorkspaceRoot)
    } catch {
      return true
    }
  }

  for (const stage of analysis.stages) {
    const executable = stageExecutableName(stage)
    const wrappedCwd = wrapperWorkingDirectory(stage)
    if (wrappedCwd !== undefined && await targetEscapes(wrappedCwd)) return true
    if (executable && ['cd', 'pushd', 'set-location'].includes(executable)) {
      if (await targetEscapes(stage.argvParts.slice(1).find((token) => token !== undefined && !token.startsWith('-')))) return true
    }
    for (const assignment of stage.environment) {
      if ((assignment.name === 'GIT_DIR' || assignment.name === 'GIT_WORK_TREE')
        && await targetEscapes(assignment.value)) return true
    }
    if (executable !== 'git') continue
    const parts = stage.argvParts.slice(1)
    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index]
      if (token === undefined) return true
      if (token === '-C' || token === '--work-tree' || token === '--git-dir') {
        if (await targetEscapes(parts[index + 1])) return true
        index += 1
      } else if (token.startsWith('-C=') || token.startsWith('--work-tree=') || token.startsWith('--git-dir=')) {
        if (await targetEscapes(token.slice(token.indexOf('=') + 1))) return true
      }
    }
  }
  return false
}

/**
 * 从 shell 命令提取路径候选并做真实路径校验，判断命令是否触及 Local Checkout。
 * 覆盖 Windows 盘符（G:/、G:\）与 Git Bash MSYS（/g/...）拼写；无法解析的 token 忽略。
 */
async function shellCommandTouchesLocal(
  command: string,
  canonicalLocalRoot: string,
  workspaceRoot: string,
  analysis?: ShellAnalysis,
): Promise<boolean> {
  for (const rawPath of extractCommandPathCandidates(command, analysis)) {
    const portablePath = normalizeMsysPath(rawPath)
    try {
      const canonical = await canonicalizePath(resolvePortablePath(portablePath, workspaceRoot))
      if (isWithinWorkspace(canonical, canonicalLocalRoot)) return true
    } catch {
      // 非路径 token 或无法解析的路径不参与判定
    }
  }
  return false
}

export async function createPiExecutionController(
  options: PiExecutionControllerOptions,
): Promise<PiExecutionAuthorize> {
  await mkdir(options.planSidecarDir, { recursive: true })
  const canonicalPlanSidecarDir = await canonicalizePath(options.planSidecarDir)
  const canonicalWorkspaceRoot = await canonicalizePath(options.workspaceRoot)
  const canonicalLocalBaselineRoot = await canonicalizePath(options.localBaselineRoot)
  const isolatedFromLocal = !isWithinWorkspace(canonicalWorkspaceRoot, canonicalLocalBaselineRoot)
  const canonicalSessionWorkbenchRoot = options.sessionWorkbenchRoot
    ? await canonicalizePath(options.sessionWorkbenchRoot)
    : undefined
  const localBaseline = await captureLocalBaseline(options.localBaselineRoot)
  let browserExternalInteractionApproved = false
  const executionPolicy = createExecutionPolicy({
    executionPolicy: options.getExecutionPolicy,
    sessionId: options.sessionId,
    ...(options.workspaceId && { workspaceId: options.workspaceId }),
    workspaceRoot: options.workspaceRoot,
    interaction: options.interaction,
    localBaselineRoot: options.localBaselineRoot,
    localBaselinePaths: localBaseline.paths,
    localBaselineStatus: localBaseline.status,
    trustedVariableDeletionRoots: canonicalSessionWorkbenchRoot
      ? [join(canonicalSessionWorkbenchRoot, '.context')]
      : [],
    requestApproval: options.requestApproval,
    audit: options.audit,
  })

  const authorizeTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOptions: CanUseToolOptions,
  ): Promise<PermissionResult> => {
    const toolSource = toolOptions.toolSource ?? 'host'
    const isHostInteractionTool = toolSource === 'host'
    const validationFailure = validateToolInput(toolName, toolInput)
    if (validationFailure) return validationFailure
    const normalizedToolName = toolName.toLowerCase()
    const canonicalShellCommand = (normalizedToolName === 'bash' || normalizedToolName === 'terminalrun')
      && typeof toolInput.command === 'string'
      ? toolInput.command
      : undefined
    const hasShellSource = canonicalShellCommand !== undefined
    if (hasShellSource) await initializeShellAnalysis()
    const canonicalShellAnalysis = canonicalShellCommand === undefined
      ? undefined
      : analyzeShellCommand(canonicalShellCommand)
    if (toolName === 'Write' && typeof toolInput.content === 'string'
      && estimateTokenCount(toolInput.content) > WRITE_CONTENT_TOKEN_THRESHOLD) {
      return { behavior: 'deny', message: 'Write 内容过大，请拆分为较小的连续写入。' }
    }
    if (toolName === 'PlanFocusedValidation') {
      const trustedProductRead = toolSource === 'product'
        && toolOptions.toolAnnotations?.readOnlyHint === true
        && toolOptions.toolAnnotations.destructiveHint === false
      return trustedProductRead
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'PlanFocusedValidation 仅允许由 Domi 产品注册的可信只读工具调用。' }
    }
    const normalizedAction = normalizeToolAction(toolName, toolInput, canonicalShellAnalysis)
    if (options.sessionTarget?.kind === 'isolated'
      && options.sessionTarget.ownership === 'inherited'
      && normalizedAction.kind === 'shell'
      && isDestructiveGitCommand(normalizedAction.command, canonicalShellAnalysis)) {
      return { behavior: 'deny', message: 'inherited Isolated Checkout 由父会话持有；当前会话不能执行破坏性 Git，请交由 owner 会话处理。' }
    }
    if (isolatedFromLocal) {
      const action = normalizedAction
      if (action.kind === 'shell' && await commandRepositoryContextEscapesTarget(
        action.command,
        options.workspaceRoot,
        canonicalWorkspaceRoot,
        canonicalShellAnalysis,
      )) {
        return { behavior: 'deny', message: 'managed Worktree 会话不能把 cwd、git-dir 或 work-tree 切换到当前 Session Target 之外；Local 修改请使用维修事务。' }
      }
      const canonicalPaths: string[] = []
      for (const path of action.paths) {
        try {
          canonicalPaths.push(await canonicalizePath(resolvePortablePath(path, options.workspaceRoot)))
        } catch {
          return { behavior: 'deny', message: '无法验证工具路径，已保守拒绝。' }
        }
      }
      const unresolvedDirectDeletion = action.kind === 'shell'
        && hasUnresolvedDirectDeletion(action.command, canonicalShellAnalysis)
      const touchesLocal = canonicalPaths.some((path) => isWithinWorkspace(path, canonicalLocalBaselineRoot))
        || (action.kind === 'shell' && await shellCommandTouchesLocal(action.command, canonicalLocalBaselineRoot, options.workspaceRoot, canonicalShellAnalysis))
      if (unresolvedDirectDeletion) {
        return { behavior: 'deny', message: '删除命令包含动态目标，无法证明其不会写入或删除 Local Checkout；Full Access 也不能绕过 managed Worktree 的 Local 边界，请改用当前 Session Target 内的静态路径，或使用 Local 维修事务。' }
      }
      if (touchesLocal && action.kind === 'file' && action.operation === 'read') {
        return { behavior: 'allow', updatedInput: toolInput }
      }
      if (touchesLocal && action.kind === 'file' && action.operation !== 'read') {
        return { behavior: 'deny', message: 'managed Worktree 会话不能用普通文件工具直接写 Local；请先调用 RequestLocalMaintenance，批准后使用 LocalMaintenanceWrite/Edit。' }
      }
      if (touchesLocal && action.kind === 'shell') {
        if (isKnownReadOnlyCommand(action.command, canonicalShellAnalysis)) return { behavior: 'allow', updatedInput: toolInput }
        return { behavior: 'deny', message: '命令包含指向 Local Checkout 的路径，且不是可证明只读的命令；读取 Local 请使用 ls/cat/grep/git status 等只读命令，修改 Local 请在批准的维修事务中使用 LocalMaintenanceBash。' }
      }
      if (touchesLocal && action.kind === 'unknown' && toolSource !== 'product') {
        return { behavior: 'deny', message: '外部工具指向真实 Local Checkout，但未提供可验证的只读/写入语义；请使用显式读取工具，或通过 Local 维修事务修改。' }
      }
    }
    if (canonicalSessionWorkbenchRoot && canonicalShellCommand !== undefined) {
      const worktreeAddPaths = extractGitWorktreeAddPaths(canonicalShellCommand, canonicalShellAnalysis)
      const hasWorktreeAdd = hasGitWorktreeAddInvocation(canonicalShellCommand, canonicalShellAnalysis)
      const cwdIsUnverifiable = commandChangesWorkingDirectory(canonicalShellCommand, canonicalShellAnalysis)
      if ((hasWorktreeAdd && worktreeAddPaths.length === 0) || worktreeAddPaths.some((path) => (
        containsDynamicPathSyntax(path) || (!isPortableAbsolutePath(path) && cwdIsUnverifiable)
      ))) {
        return {
          behavior: 'deny',
          message: '无法可靠验证 Git worktree 的目标位置；请直接使用 Domi Session Target，或为用户明确要求的仓库维护任务提供会话工作台之外的绝对路径。',
        }
      }

      for (const path of worktreeAddPaths) {
        let canonicalWorktreePath: string
        try {
          canonicalWorktreePath = await canonicalizePath(
            resolvePortablePath(path, options.workspaceRoot),
          )
        } catch {
          return {
            behavior: 'deny',
            message: '无法验证 Git worktree 的目标路径，已保守拒绝。',
          }
        }
        if (isWithinWorkspace(canonicalWorktreePath, canonicalSessionWorkbenchRoot)) {
          return {
            behavior: 'deny',
            message: '不能在当前 Domi 会话工作台内创建 Git worktree；这会绕过 Session Target，并可能在删除会话时丢失修改。请新建会话并在首次发送前勾选 Worktree。',
          }
        }
      }
    }
    if (options.interaction === 'unattended' && isHostInteractionTool
      && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode' || toolName === 'RequestDirectWorkflow')) {
      return {
        behavior: 'deny',
        message: `无人值守调用不能等待 ${toolName} 用户交互，已拒绝。`,
      }
    }

    if (toolName === 'EnterPlanMode' && isHostInteractionTool) {
      const transition = transitionAgentWorkflow(options.getWorkflow(), { type: 'enter-plan' })
      if (transition.outcome === 'deny') {
        return { behavior: 'deny', message: '当前 Workflow 不能进入 Plan First。' }
      }
      if (!await options.onWorkflowChanged(transition.workflow, 'enter-plan')) {
        return { behavior: 'deny', message: '当前 run 已结束，未进入计划模式。' }
      }
      return { behavior: 'allow', updatedInput: toolInput }
    }

    const currentWorkflow = options.getWorkflow()
    if (toolName === 'RequestDirectWorkflow' && isHostInteractionTool) {
      if (currentWorkflow === 'direct') {
        return { behavior: 'allow', updatedInput: toolInput }
      }
      if (currentWorkflow === 'plan-first') {
        return { behavior: 'deny', message: '当前会话处于 Plan First，请通过 ExitPlanMode 提交计划审批。' }
      }
    }
    if (currentWorkflow !== 'direct') {
      let policyInput = toolInput
      if (currentWorkflow === 'plan-first'
        && (toolName === 'Write' || toolName === 'Edit')
        && typeof toolInput.file_path === 'string') {
        try {
          policyInput = {
            ...toolInput,
            file_path: await canonicalizePath(
              resolvePortablePath(toolInput.file_path, options.workspaceRoot),
            ),
          }
        } catch {
          return { behavior: 'deny', message: '无法验证计划 sidecar 写入路径，已保守拒绝。' }
        }
      }
      const decision = await authorizeToolForWorkflow({
        workflow: currentWorkflow,
        executionPolicy,
        call: {
          toolName,
          input: policyInput,
          cwd: options.workspaceRoot,
          planSidecarDir: canonicalPlanSidecarDir,
          interaction: options.interaction,
          toolSource,
          toolAnnotations: toolOptions.toolAnnotations,
          signal: toolOptions.signal,
          toolCallId: toolOptions.toolUseID,
          displayName: toolOptions.displayName,
          shellAnalysis: canonicalShellAnalysis,
        },
      })
      return decision.outcome === 'allow'
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: decision.reason }
    }

    if ((toolName === 'TerminalList' || toolName === 'TerminalRead') && toolSource === 'product') {
      return { behavior: 'allow', updatedInput: toolInput }
    }
    if ((toolName === 'TerminalInterrupt' || toolName === 'TerminalClose') && toolSource === 'product') {
      if (options.interaction !== 'interactive') {
        return { behavior: 'deny', message: '无人值守调用不能控制交互终端。' }
      }
      return { behavior: 'allow', updatedInput: toolInput }
    }

    if (toolName === 'RequestGitPushSessionTrust' || toolName === 'GitPushWithSessionTrust') {
      if (toolSource !== 'product') {
        return { behavior: 'deny', message: 'Git push 会话授权只能由 Domi 产品工具使用。' }
      }
      if (options.interaction !== 'interactive'
        || options.getExecutionPolicy() !== 'full-access'
        || !isolatedFromLocal
        || options.sessionTarget?.kind !== 'isolated'
        || options.sessionTarget.ownership !== 'owner'
        || options.sessionTarget.followupOnly === true) {
        return { behavior: 'deny', message: '普通 push 会话授权仅支持 Direct + Full Access 的交互式 owner Isolated Checkout。' }
      }
      if (toolName === 'RequestGitPushSessionTrust') {
        return options.requestGitPushSessionTrust
          ? options.requestGitPushSessionTrust(toolInput, toolOptions)
          : { behavior: 'deny', message: '普通 push 会话授权服务不可用。' }
      }
      if (!options.hasGitPushSessionTrust || !await options.hasGitPushSessionTrust()) {
        return { behavior: 'deny', message: '普通 Git push 会话授权不存在或已失效；仅在用户明确要求 push 时重新请求。' }
      }
      await options.audit({
        sessionId: options.sessionId,
        ...(options.workspaceId && { workspaceId: options.workspaceId }),
        toolName,
        action: 'session-git-push',
        outcome: 'allow',
        category: 'external-impact',
        approval: 'session',
        executionPolicy: options.getExecutionPolicy(),
        decisionCode: 'legacy-session-git-push',
        durationMs: 0,
      })
      return { behavior: 'allow', updatedInput: toolInput }
    }

    const localMaintenanceTool = toolName === 'LocalMaintenanceStatus'
      || toolName === 'LocalMaintenanceWrite'
      || toolName === 'LocalMaintenanceEdit'
      || toolName === 'LocalMaintenanceBash'
      || toolName === 'CompleteLocalMaintenance'
    if (localMaintenanceTool && toolSource === 'product') {
      if (toolName === 'LocalMaintenanceStatus') return { behavior: 'allow', updatedInput: toolInput }
      if (options.interaction === 'unattended') return { behavior: 'deny', message: '无人值守调用不能使用 Local 维修写能力。' }
      if (currentWorkflow !== 'direct') return { behavior: 'deny', message: 'Local 维修写能力只在 Direct Workflow 中开放。' }
      return { behavior: 'allow', updatedInput: toolInput }
    }

    if ((toolName === 'ApplyWorktree' || toolName === 'FinishWorktree' || toolName === 'RequestLocalMaintenance') && toolSource === 'product') {
      if (options.interaction === 'unattended') {
        return { behavior: 'deny', message: '无人值守调用不能将 managed Worktree 回写、提交或开启 Local 维修事务。' }
      }
      if (options.requestProductToolApproval) {
        return options.requestProductToolApproval(toolName, toolInput, toolOptions)
      }
      const approval = await options.requestApproval({
        scope: 'single',
        category: 'local-baseline',
        reason: toolName === 'FinishWorktree'
          ? 'FinishWorktree 将创建一个 Local Commit 并清理 managed Worktree，必须逐次明确确认。'
          : toolName === 'RequestLocalMaintenance'
            ? 'Local 维修事务将临时开放宿主管理的 Local 项目写 lease，必须基于当前快照逐次确认。'
            : 'ApplyWorktree 将把当前 managed Worktree 的修改写入用户 Local Checkout，必须逐次明确确认。',
        toolName,
      }, {
        call: {
          toolName,
          input: toolInput,
          cwd: options.workspaceRoot,
          signal: toolOptions.signal,
          toolCallId: toolOptions.toolUseID,
          displayName: toolOptions.displayName,
          toolSource,
        },
        signal: toolOptions.signal,
      })
      return approval === 'approved'
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: toolName === 'RequestLocalMaintenance'
            ? '用户未授权本次 Local 维修事务。'
            : `用户未授权本次 Worktree ${toolName === 'FinishWorktree' ? '提交' : 'Apply'}。` }
    }

    if ((toolName === 'BrowserClick' || toolName === 'BrowserType') && toolSource === 'product') {
      if (options.getWorkflow() !== 'direct') {
        return { behavior: 'deny', message: '浏览器点击和输入会与外部网页交互，请先进入 Direct 工作流。' }
      }
      if (options.interaction === 'unattended') {
        return { behavior: 'deny', message: '无人值守会话首版不能点击网页或向网页输入内容。' }
      }
      if (!browserExternalInteractionApproved) {
        const approval = await options.requestApproval({
          scope: 'session',
          category: 'external-impact',
          reason: '网页内容不可信；点击或输入可能提交表单、改变远端状态或触发不可逆操作。',
          toolName,
          decisionCode: 'browser_external_interaction',
        }, {
          call: {
            toolName,
            // 权限 UI 只需要稳定目标标识，BrowserType 正文不得进入权限请求或审计。
            input: toolName === 'BrowserType'
              ? {
                  ref: typeof toolInput.ref === 'string' ? toolInput.ref : undefined,
                  replace: toolInput.replace === true,
                  textLength: typeof toolInput.text === 'string' ? toolInput.text.length : 0,
                }
              : toolInput,
            cwd: options.workspaceRoot,
            signal: toolOptions.signal,
            toolCallId: toolOptions.toolUseID,
            displayName: toolOptions.displayName,
            toolSource,
          },
          signal: toolOptions.signal,
        })
        if (approval !== 'approved') {
          return { behavior: 'deny', message: '用户未授权本次 Agent 浏览器交互。' }
        }
        browserExternalInteractionApproved = true
      }
      return { behavior: 'allow', updatedInput: toolInput }
    }

    if (toolName === 'AskUserQuestion' && isHostInteractionTool) {
      return { behavior: 'allow', updatedInput: toolInput }
    }
    if (toolName === 'ExitPlanMode' && isHostInteractionTool) {
      return { behavior: 'deny', message: '当前会话不在 Plan First，不能提交计划审批。' }
    }

    const decision = await executionPolicy.authorize({
      toolName,
      input: toolInput,
      cwd: options.workspaceRoot,
      signal: toolOptions.signal,
      toolCallId: toolOptions.toolUseID,
      displayName: toolOptions.displayName,
      toolSource,
      shellAnalysis: canonicalShellAnalysis,
    })
    return decision.outcome === 'allow'
      ? { behavior: 'allow', updatedInput: toolInput }
      : { behavior: 'deny', message: decision.reason }
  }

  return async (request): Promise<PermissionResult> => {
    if (request.type === 'tool') {
      return authorizeTool(request.toolName, request.input, request.options)
    }
    if (request.type === 'ask-user') {
      return options.askUser(request.input, request.signal)
    }
    if (request.type === 'request-direct-workflow') {
      if (options.interaction === 'unattended') {
        return { behavior: 'deny', message: '无人值守调用不能请求切换 Workflow。' }
      }
      const currentWorkflow = options.getWorkflow()
      if (currentWorkflow === 'direct') {
        return { behavior: 'allow', updatedInput: request.input }
      }
      if (currentWorkflow !== 'read-only') {
        return { behavior: 'deny', message: '当前会话不在 Read Only，不能使用此切换请求。' }
      }

      const approveOnceLabel = '仅执行本次'
      const switchToExecuteLabel = '切换到执行'
      const readOnlyLabel = '保持研究'
      const readText = (key: string, maxLength: number): string => {
        const value = request.input[key]
        return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
      }
      const legacySections = [
        readText('intent', 4_000),
        readText('direction', 4_000),
        readText('reason', 4_000),
      ].filter(Boolean)
      const details = readText('details', 12_000)
        || legacySections.join('\n\n')
        || '已完成必要探索，准备按当前请求进行最小范围的实施与验证。'
      const summary = readText('summary', 240)
      const question = '实施反馈已展示在主会话区。如何继续？'
      const approval = await options.askUser({
        presentation: {
          kind: 'direct-workflow',
          details,
          ...(summary && { summary }),
        },
        questions: [{
          question,
          header: '批准执行',
          options: [
            {
              label: approveOnceLabel,
              description: '仅为当前任务临时开放执行；完成、失败或中止后自动回到研究。',
            },
            {
              label: switchToExecuteLabel,
              description: '立即执行当前任务，并让后续消息继续保持执行模式。',
            },
            {
              label: readOnlyLabel,
              description: '保持只读，可继续反馈或结束；当前方向不会实施。',
            },
          ],
          multiSelect: false,
          allowCustom: true,
        }],
      }, request.signal)
      if (approval.behavior === 'deny') return approval
      if (options.isRunActive && !options.isRunActive()) {
        return { behavior: 'deny', message: '审批对应的 run 已结束，未授权执行。' }
      }
      const answers = approval.updatedInput?.answers
      const answerRecord = answers && typeof answers === 'object'
        ? answers as Record<string, unknown>
        : null
      const adjustmentValue = answerRecord?.[DIRECT_WORKFLOW_ADJUSTMENT_ANSWER_KEY]
      const adjustment = typeof adjustmentValue === 'string' ? adjustmentValue.trim() : ''
      if (adjustment) {
        return {
          behavior: 'deny',
          message: `用户要求先调整实施方向，当前仍保持研究；请按以下意见修订实施反馈并重新调用 RequestDirectWorkflow，不能按原方向实施：${adjustment}`,
        }
      }

      const selected = answerRecord?.[question]
      if (selected !== approveOnceLabel && selected !== switchToExecuteLabel) {
        return { behavior: 'deny', message: '用户选择保持研究，未授权执行。' }
      }
      if (options.getWorkflow() === 'direct') {
        return { behavior: 'allow', updatedInput: request.input }
      }

      const transition = transitionAgentWorkflow(options.getWorkflow(), { type: 'approve-read-only' })
      if (transition.outcome === 'deny') {
        return { behavior: 'deny', message: 'Workflow 状态已变化，请重试。' }
      }
      const applied = await options.onWorkflowChanged(
        transition.workflow,
        selected === switchToExecuteLabel ? 'approve-read-only-persistent' : 'approve-read-only-once',
      )
      return applied
        ? { behavior: 'allow', updatedInput: request.input }
        : { behavior: 'deny', message: '审批对应的 run 已结束，未授权执行。' }
    }

    if (options.getWorkflow() !== 'plan-first') {
      return { behavior: 'deny', message: '当前会话不在 Plan First，不能提交计划审批。' }
    }
    const result = await options.exitPlan(request.input, request.signal)
    if (result.behavior === 'deny') return result
    if (options.isRunActive && !options.isRunActive()) {
      return { behavior: 'deny', message: '计划审批对应的 run 已结束，未授权执行。' }
    }
    const transition = transitionAgentWorkflow(options.getWorkflow(), { type: 'approve-plan' })
    if (transition.outcome === 'deny') {
      return { behavior: 'deny', message: '计划审批状态已变化，请重试。' }
    }
    const applied = await options.onWorkflowChanged(
      transition.workflow,
      result.executionScope === 'session' ? 'approve-plan-persistent' : 'approve-plan-once',
    )
    return applied
      ? { behavior: 'allow', updatedInput: request.input }
      : { behavior: 'deny', message: '计划审批对应的 run 已结束，未授权执行。' }
  }
}
