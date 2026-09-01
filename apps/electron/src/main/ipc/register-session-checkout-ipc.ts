import {
  SESSION_CHECKOUT_IPC_CHANNELS,
  type ListManagedWorktreesInput,
  type BulkCleanupManagedWorktreesInput,
  type BulkCleanupManagedWorktreesResult,
  type BulkCleanupManagedWorktreeCandidate,
  type ConfirmWorktreeIterationInput,
  type ConfirmWorktreeIterationResult,
  type ManageWorktreeInput,
  type ManagedWorktreeSummaryView,
  type OperateSessionCheckoutInput,
  type PreflightSessionCheckoutInput,
  type RendererSessionTargetChoice,
  type RevealManagedWorktreeInput,
  type SessionCheckoutIpcResult,
  type SessionCheckoutOperationResult,
  type SessionCheckoutAction,
  type SessionTargetRef,
  type SessionTargetView,
  type WorktreeRetentionMode,
  type WorktreeApplyPreflightView,
  type WorktreeRecoveryHandoffInput,
  type WorktreeRecoveryHandoffResult,
  type AgentSessionHandoffInput,
  type AgentSessionHandoffResult,
} from '@domi/shared'

interface SessionCheckoutIpcRegistrar {
  handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void
}

export interface SessionCheckoutIpcModule {
  inspect(sessionId: string): Promise<SessionTargetView>
  preflight?(sessionId: string, expectedRevision: number): Promise<WorktreeApplyPreflightView>
  bind(sessionId: string, choice: RendererSessionTargetChoice): Promise<SessionTargetView>
  operate(input: OperateSessionCheckoutInput): Promise<SessionCheckoutOperationResult>
  listManagedWorktrees?(input?: ListManagedWorktreesInput): Promise<ManagedWorktreeSummaryView[]>
  inspectManagedWorktreeCleanup?(input?: ListManagedWorktreesInput): Promise<ManagedWorktreeSummaryView[]>
  bulkCleanupManagedWorktrees?(candidates: BulkCleanupManagedWorktreeCandidate[]): Promise<BulkCleanupManagedWorktreesResult>
  manageManagedWorktree?(input: ManageWorktreeInput): Promise<ManagedWorktreeSummaryView>
  resolveManagedRootForReveal?(checkoutId: string): Promise<string>
}

const HANDOFF_SESSION_CHANNEL = SESSION_CHECKOUT_IPC_CHANNELS.HANDOFF_SESSION ?? 'session-checkout:handoff-session'

const INVALID_REQUEST = {
  ok: false,
  error: { code: 'invalid_request', message: 'Session Target 请求参数无效' },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseInspectInput(input: unknown): string | null {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId']) || !isSessionId(input.sessionId)) return null
  return input.sessionId
}

function parsePreflightInput(input: unknown): PreflightSessionCheckoutInput | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ['sessionId', 'expectedRevision'])
    || !isSessionId(input.sessionId)
    || typeof input.expectedRevision !== 'number'
    || !Number.isSafeInteger(input.expectedRevision)
  ) return null
  return { sessionId: input.sessionId, expectedRevision: input.expectedRevision }
}

function parseChoice(value: unknown): RendererSessionTargetChoice | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind'])) return null
  return value.kind === 'local' || value.kind === 'isolated' ? { kind: value.kind } : null
}

function parseBindInput(input: unknown): { sessionId: string; choice: RendererSessionTargetChoice } | null {
  if (!isRecord(input) || !hasExactKeys(input, ['sessionId', 'choice']) || !isSessionId(input.sessionId)) return null
  const choice = parseChoice(input.choice)
  return choice ? { sessionId: input.sessionId, choice } : null
}

function parseConfirmIterationInput(input: unknown): ConfirmWorktreeIterationInput | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ['sessionId', 'requestId'])
    || !isSessionId(input.sessionId)
    || !isSessionId(input.requestId)
    || input.requestId.length > 100
  ) return null
  return { sessionId: input.sessionId, requestId: input.requestId }
}

function parseRetention(value: unknown): WorktreeRetentionMode | null {
  return value === 'cleanup' || value === 'retain_24h' || value === 'retain_3d' || value === 'retain_manual'
    ? value
    : null
}

function parseAction(value: unknown): SessionCheckoutAction | null {
  if (
    value === 'apply'
    || value === 'finish'
    || value === 'preview'
    || value === 'checkpoint'
    || value === 'rollback_preview'
    || value === 'finalize_preview'
    || value === 'retry_cleanup'
    || value === 'discard'
    || value === 'recover'
    || value === 'release_collaborator'
    || value === 'release_collaborators'
  ) return value
  return null
}

function parseOperateInput(input: unknown): OperateSessionCheckoutInput | null {
  if (
    !isRecord(input)
    || !isSessionId(input.sessionId)
    || typeof input.expectedRevision !== 'number'
    || !Number.isSafeInteger(input.expectedRevision)
  ) return null
  const action = parseAction(input.action)
  if (!action) return null

  if (action === 'checkpoint') {
    if (
      !hasExactKeys(input, ['sessionId', 'action', 'expectedRevision', 'commitMessage'])
      || typeof input.commitMessage !== 'string'
      || input.commitMessage.trim().length === 0
    ) return null
    return {
      sessionId: input.sessionId,
      action,
      expectedRevision: input.expectedRevision,
      commitMessage: input.commitMessage.trim(),
    }
  }

  if (action === 'finish' || action === 'finalize_preview') {
    if (
      !hasExactKeys(input, ['sessionId', 'action', 'expectedRevision', 'commitMessage', 'retention'])
      || typeof input.commitMessage !== 'string'
      || input.commitMessage.trim().length === 0
    ) return null
    const retention = parseRetention(input.retention)
    if (!retention) return null
    return {
      sessionId: input.sessionId,
      action,
      expectedRevision: input.expectedRevision,
      commitMessage: input.commitMessage.trim(),
      retention,
    }
  }

  if (action === 'release_collaborator') {
    if (
      !hasExactKeys(input, ['sessionId', 'action', 'expectedRevision', 'collaboratorSessionId'])
      || !isSessionId(input.collaboratorSessionId)
    ) return null
    return {
      sessionId: input.sessionId,
      action,
      expectedRevision: input.expectedRevision,
      collaboratorSessionId: input.collaboratorSessionId,
    }
  }

  if (action === 'rollback_preview') {
    if (
      !hasExactKeys(input, ['sessionId', 'action', 'expectedRevision'], ['resumeRevision'])
      || (input.resumeRevision !== undefined && typeof input.resumeRevision !== 'boolean')
    ) return null
    return {
      sessionId: input.sessionId,
      action,
      expectedRevision: input.expectedRevision,
      ...(input.resumeRevision === undefined ? {} : { resumeRevision: input.resumeRevision }),
    }
  }

  if (action === 'discard') {
    if (
      !hasExactKeys(input, ['sessionId', 'action', 'expectedRevision', 'confirmDirty'])
      || typeof input.confirmDirty !== 'boolean'
    ) return null
    return {
      sessionId: input.sessionId,
      action,
      expectedRevision: input.expectedRevision,
      confirmDirty: input.confirmDirty,
    }
  }

  if (!hasExactKeys(input, ['sessionId', 'action', 'expectedRevision'])) return null
  return { sessionId: input.sessionId, action, expectedRevision: input.expectedRevision }
}

function parseListManagedInput(input: unknown): ListManagedWorktreesInput | null {
  if (!isRecord(input) || !hasExactKeys(input, [], ['projectId', 'needsAttention', 'checkoutId', 'includeDiagnostics'])) return null
  if (input.projectId !== undefined && !isSessionId(input.projectId)) return null
  if (input.needsAttention !== undefined && typeof input.needsAttention !== 'boolean') return null
  if (input.checkoutId !== undefined && !isSessionId(input.checkoutId)) return null
  if (input.includeDiagnostics !== undefined && typeof input.includeDiagnostics !== 'boolean') return null
  return {
    ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}),
    ...(typeof input.needsAttention === 'boolean' ? { needsAttention: input.needsAttention } : {}),
    ...(typeof input.checkoutId === 'string' ? { checkoutId: input.checkoutId } : {}),
    ...(typeof input.includeDiagnostics === 'boolean' ? { includeDiagnostics: input.includeDiagnostics } : {}),
  }
}

function parseBulkCleanupManagedInput(input: unknown): BulkCleanupManagedWorktreesInput | null {
  if (!isRecord(input) || !hasExactKeys(input, ['candidates']) || !Array.isArray(input.candidates)) return null
  if (input.candidates.length === 0 || input.candidates.length > 100) return null
  const candidates: BulkCleanupManagedWorktreeCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of input.candidates) {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ['checkoutId', 'expectedRevision'])
      || !isSessionId(candidate.checkoutId)
      || typeof candidate.expectedRevision !== 'number'
      || !Number.isSafeInteger(candidate.expectedRevision)
      || seen.has(candidate.checkoutId)
    ) return null
    seen.add(candidate.checkoutId)
    candidates.push({ checkoutId: candidate.checkoutId, expectedRevision: candidate.expectedRevision })
  }
  return { candidates }
}

function parseManageInput(input: unknown): ManageWorktreeInput | null {
  if (!isRecord(input) || !isSessionId(input.checkoutId) || typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision)) return null
  if (input.action === 'cleanup_retained' || input.action === 'retry_cleanup') {
    return hasExactKeys(input, ['checkoutId', 'expectedRevision', 'action'])
      ? { checkoutId: input.checkoutId, expectedRevision: input.expectedRevision, action: input.action }
      : null
  }
  if (input.action === 'discard') {
    if (
      !hasExactKeys(input, ['checkoutId', 'expectedRevision', 'action', 'confirmDirty'])
      || input.confirmDirty !== true
    ) return null
    return {
      checkoutId: input.checkoutId,
      expectedRevision: input.expectedRevision,
      action: 'discard',
      confirmDirty: true,
    }
  }
  if (input.action === 'set_retention') {
    if (!hasExactKeys(input, ['checkoutId', 'expectedRevision', 'action', 'retention'])) return null
    const retention = parseRetention(input.retention)
    if (!retention || retention === 'cleanup') return null
    return { checkoutId: input.checkoutId, expectedRevision: input.expectedRevision, action: input.action, retention }
  }
  return null
}

function parseSessionHandoffInput(input: unknown): AgentSessionHandoffInput | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ['sessionId', 'expectedRevision', 'targetKind', 'confirmedIgnoreDirtyLocal'])
    || !isSessionId(input.sessionId)
    || typeof input.expectedRevision !== 'number'
    || !Number.isSafeInteger(input.expectedRevision)
    || (input.targetKind !== 'local' && input.targetKind !== 'isolated')
    || typeof input.confirmedIgnoreDirtyLocal !== 'boolean'
  ) return null
  return {
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
    targetKind: input.targetKind,
    confirmedIgnoreDirtyLocal: input.confirmedIgnoreDirtyLocal,
  }
}

function parseRecoveryHandoffInput(input: unknown): WorktreeRecoveryHandoffInput | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ['sessionId', 'expectedRevision', 'confirmedIgnoreDirtyLocal'])
    || !isSessionId(input.sessionId)
    || typeof input.expectedRevision !== 'number'
    || !Number.isSafeInteger(input.expectedRevision)
    || input.confirmedIgnoreDirtyLocal !== true
  ) return null
  return {
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
    confirmedIgnoreDirtyLocal: true,
  }
}

function parseRevealManagedInput(input: unknown): RevealManagedWorktreeInput | null {
  return isRecord(input) && hasExactKeys(input, ['checkoutId']) && isSessionId(input.checkoutId)
    ? { checkoutId: input.checkoutId }
    : null
}

function stableFailure(error: unknown): SessionCheckoutIpcResult<never> {
  if (isRecord(error) && typeof error.code === 'string' && error.code.length > 0) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error instanceof Error ? error.message : 'Session Target 操作失败',
      },
    }
  }
  return {
    ok: false,
    error: { code: 'internal_error', message: 'Session Target 操作失败' },
  }
}

async function invoke<T>(operation: () => Promise<T>): Promise<SessionCheckoutIpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return stableFailure(error)
  }
}

/** IPC 边界负责严格输入校验和稳定错误序列化，不接收 renderer 路径。 */
export function registerSessionCheckoutIpc(
  ipc: SessionCheckoutIpcRegistrar,
  module: SessionCheckoutIpcModule,
  persistTarget?: (sessionId: string, target: Exclude<SessionTargetRef, { kind: 'unselected' }>) => void,
  assertIdle?: (sessionId: string) => Promise<void>,
  revealManagedRoot?: (root: string) => Promise<void> | void,
  prepareManagedDiscard?: (ownerSessionId: string) => Promise<void>,
  getActiveManagedSessions?: (ownerSessionId: string) => Promise<string[]>,
  prepareRecoveryHandoff?: (input: WorktreeRecoveryHandoffInput) => Promise<WorktreeRecoveryHandoffResult>,
  prepareSessionHandoff?: (input: AgentSessionHandoffInput) => Promise<AgentSessionHandoffResult>,
  confirmIteration?: (input: ConfirmWorktreeIterationInput) => Promise<ConfirmWorktreeIterationResult>,
): void {
  ipc.handle(HANDOFF_SESSION_CHANNEL, async (_, input) => {
    const parsed = parseSessionHandoffInput(input)
    if (!parsed || !prepareSessionHandoff) return INVALID_REQUEST
    return invoke(async () => {
      await assertIdle?.(parsed.sessionId)
      return prepareSessionHandoff(parsed)
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.HANDOFF_RECOVERY, async (_, input) => {
    const parsed = parseRecoveryHandoffInput(input)
    if (!parsed || !prepareRecoveryHandoff) return INVALID_REQUEST
    return invoke(async () => {
      await assertIdle?.(parsed.sessionId)
      return prepareRecoveryHandoff(parsed)
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.INSPECT, async (_, input) => {
    const sessionId = parseInspectInput(input)
    return sessionId ? invoke(() => module.inspect(sessionId)) : INVALID_REQUEST
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.PREFLIGHT, async (_, input) => {
    const parsed = parsePreflightInput(input)
    if (!parsed || !module.preflight) return INVALID_REQUEST
    return invoke(() => module.preflight!(parsed.sessionId, parsed.expectedRevision))
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.BIND, async (_, input) => {
    const parsed = parseBindInput(input)
    if (!parsed) return INVALID_REQUEST
    return invoke(async () => {
      const target = await module.bind(parsed.sessionId, parsed.choice)
      persistTarget?.(
        parsed.sessionId,
        target.checkout.kind === 'isolated'
          ? { kind: 'isolated', checkoutId: target.checkout.id }
          : { kind: 'local' },
      )
      return target
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.CONFIRM_ITERATION, async (_, input) => {
    const parsed = parseConfirmIterationInput(input)
    if (!parsed || !confirmIteration) return INVALID_REQUEST
    return invoke(async () => {
      // confirmIteration 必须在捕获 session activity epoch 后自行执行 idle 检查，
      // 否则普通消息可能插入 assertIdle 与一次性 token 签发之间。
      const result = await confirmIteration(parsed)
      persistTarget?.(parsed.sessionId, { kind: 'isolated', checkoutId: result.target.checkout.id })
      return result
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE, async (_, input) => {
    const parsed = parseOperateInput(input)
    if (!parsed) return INVALID_REQUEST
    return invoke(async () => {
      await assertIdle?.(parsed.sessionId)
      return module.operate(parsed)
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.LIST_MANAGED, async (_, input) => {
    const parsed = parseListManagedInput(input)
    if (!parsed || !module.listManagedWorktrees) return INVALID_REQUEST
    return invoke(async () => {
      const items = parsed.includeDiagnostics === true && module.inspectManagedWorktreeCleanup
        ? await module.inspectManagedWorktreeCleanup(parsed)
        : await module.listManagedWorktrees!(parsed)
      if (!getActiveManagedSessions) return items
      return Promise.all(items.map(async (item) => ({
        ...item,
        activeSessionIds: await getActiveManagedSessions(item.ownerSessionId),
      })))
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.BULK_CLEANUP_MANAGED, async (_, input) => {
    const parsed = parseBulkCleanupManagedInput(input)
    if (!parsed || !module.bulkCleanupManagedWorktrees) return INVALID_REQUEST
    return invoke(() => module.bulkCleanupManagedWorktrees!(parsed.candidates))
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.MANAGE, async (_, input) => {    const parsed = parseManageInput(input)
    if (!parsed || !module.manageManagedWorktree) return INVALID_REQUEST
    return invoke(async () => {
      if (parsed.action === 'discard') {
        const owner = (await module.listManagedWorktrees?.({ checkoutId: parsed.checkoutId }))?.[0]
        if (!owner) throw Object.assign(new Error('Worktree 记录不存在'), { code: 'checkout_missing' })
        await prepareManagedDiscard?.(owner.ownerSessionId)
      }
      return module.manageManagedWorktree!(parsed)
    })
  })

  ipc.handle(SESSION_CHECKOUT_IPC_CHANNELS.REVEAL_MANAGED, async (_, input) => {
    const parsed = parseRevealManagedInput(input)
    if (!parsed || !module.resolveManagedRootForReveal) return INVALID_REQUEST
    return invoke(async () => {
      const root = await module.resolveManagedRootForReveal!(parsed.checkoutId)
      await revealManagedRoot?.(root)
    })
  })
}
