import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  ManagedWorktreeSummaryView,
  BulkCleanupManagedWorktreeCandidate,
  BulkCleanupManagedWorktreesResult,
  SessionCheckoutErrorCode,
  SessionCheckoutOperation,
  SessionCheckoutOperationErrorResult,
  SessionCheckoutOperationResult,
  SessionTargetBindChoice,
  SessionTargetCurrentView,
  SessionTargetView,
  WorktreeCollaboratorStatus,
  WorktreeCollaboratorView,
  WorktreeCleanupReason,
  ManagedWorktreeCleanupView,
  WorktreeRetentionMode,
  WorktreeApplyPreflightView,
  WorktreeApplyPreflightBlockedReason,
  WorktreeDeliveryProofView,
  WorktreeCheckpointView,
} from '@domi/shared'
import { SessionCheckoutError } from './index.ts'
import { collectSessionProjectArtifactPaths } from '../session-project-artifacts.ts'
import { createManagedWorktreePathCandidates } from './managed-worktree-path.ts'
import type {
  CheckoutLease,
  ListManagedWorktreesInput,
  ManageManagedWorktreeInput,
  MarkReadyForReviewInput,
  SessionCheckoutModule,
  SessionCheckoutReconcileSummary,
  SessionCheckoutReleaseIntent,
  VerifiedIsolatedBindProof,
} from './index.ts'
import type {
  DirectoryIdentity,
  GitCheckoutSnapshot,
  ManagedCheckoutRecord,
  ManagedPreviewReceipt,
  ManagedWorktreeCheckpointRecord,
  ManagedWorktreePreviousReviewRecord,
  ManagedWorktreeReviewRecord,
  SessionBindingRecord,
  SessionCheckoutDependencies,
  SessionCheckoutProjectRecord,
  SessionCheckoutSessionRecord,
} from './ports.ts'

interface ResolvedSessionProject {
  session: SessionCheckoutSessionRecord
  project: SessionCheckoutProjectRecord
}

const UNVERSIONED_OID = 'unversioned'
const UNVERSIONED_REF = 'WORKING_TREE'
const RETENTION_24H_MS = 24 * 60 * 60 * 1000
const RETENTION_3D_MS = 3 * RETENTION_24H_MS
const CLEANUP_IDENTITY_CHANGED_MESSAGE = 'Worktree 的 Git 身份或路径已变化，未执行清理。'
const CLEANUP_RESIDUE_MESSAGE = 'Git Worktree 已解除注册，仅剩物理目录残余；可重试清理环境。'
const TRANSIENT_CLEANUP_RETRY_DELAYS_MS = [100, 300, 800]

/**
 * 单个 checkout 清理/维护操作的启动收敛超时。
 * Windows 上 Worktree 被外部进程（如残留 Agent 运行）占用时，git/fs 操作可能无限期挂起；
 * 启动收敛必须在有限时间内继续，不能因为一个损坏记录卡住整个应用启动。
 */
const CHECKOUT_CLEANUP_TIMEOUT_MS = 30_000

async function withCleanupTimeout<T>(
  checkoutId: string,
  operation: () => Promise<T>,
): Promise<T | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.warn(`[session-checkout] ${checkoutId.slice(0, 8)} 清理超时（${CHECKOUT_CLEANUP_TIMEOUT_MS}ms），已跳过本次收敛`)  
          resolve(null)
        }, CHECKOUT_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function cleanupReasonForMessage(message: string): WorktreeCleanupReason {
  if (message.includes('协作会话')) return 'collaborator_active'
  if (message.includes('提交后出现了新修改')) return 'modified_after_finalize'
  if (message.includes('解除注册') || message.includes('目录残余')) return 'detached_residue'
  if (message.includes('quarantine')) return 'quarantine_busy'
  if (message.includes('身份') || message.includes('记录') || message.includes('Local index')) return 'identity_changed'
  return 'directory_busy'
}

function isTransientCleanupError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return /^(EBUSY|EPERM|EACCES|ENOTEMPTY)$/i.test(code)
    || /EBUSY|EPERM|EACCES|ENOTEMPTY|being used|access is denied|permission denied/i.test(message)
}

async function retryTransientCleanup<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= TRANSIENT_CLEANUP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientCleanupError(error) || attempt === TRANSIENT_CLEANUP_RETRY_DELAYS_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_CLEANUP_RETRY_DELAYS_MS[attempt] ?? 0))
    }
  }
  throw lastError
}

function retentionExpiresAt(mode: Exclude<WorktreeRetentionMode, 'cleanup'>, retainedAt: number): number | null {
  if (mode === 'retain_24h') return retainedAt + RETENTION_24H_MS
  if (mode === 'retain_3d') return retainedAt + RETENTION_3D_MS
  return null
}

function pathForIdentity(path: string): string {
  try {
    return realpathSync.native(resolve(path)).replace(/\\/g, '/')
  } catch {
    return resolve(path).replace(/\\/g, '/')
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = pathForIdentity(left)
  const normalizedRight = pathForIdentity(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

/** canonical 路径与 registry 原始路径比较时不得再次 realpath，否则 Junction 会冒充原目录。 */
function resolvedPathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/\\/g, '/')
  const normalizedRight = resolve(right).replace(/\\/g, '/')
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export function createSessionCheckoutModule(
  dependencies: SessionCheckoutDependencies,
): SessionCheckoutModule {
  function emitTiming(event: Parameters<NonNullable<SessionCheckoutDependencies['onTimingEvent']>>[0]): void {
    if (!dependencies.onTimingEvent) return
    try {
      void Promise.resolve(dependencies.onTimingEvent(event)).catch(() => undefined)
    } catch {
      // Timing is strictly best-effort and cannot affect checkout lifecycle.
    }
  }

  function requireSession(sessionId: string): SessionCheckoutSessionRecord {
    const session = dependencies.lookup.getSession(sessionId)
    if (!session) throw new SessionCheckoutError('session_not_found', `会话不存在: ${sessionId}`)
    return session
  }

  async function resolveSessionProject(sessionId: string): Promise<ResolvedSessionProject> {
    const session = requireSession(sessionId)
    if (!session.projectId) throw new SessionCheckoutError('project_not_found', '会话尚未关联项目')
    const project = dependencies.lookup.getProject(session.projectId)
    if (!project) throw new SessionCheckoutError('project_not_found', `项目不存在: ${session.projectId}`)
    if (!dependencies.files.exists(project.root)) {
      throw new SessionCheckoutError('project_root_missing', `项目根目录不存在: ${project.name}`)
    }
    return { session, project }
  }

  async function inspectLocal(binding: SessionBindingRecord): Promise<SessionTargetView> {
    const project = dependencies.lookup.getProject(binding.projectId)
    if (!project || !dependencies.files.exists(project.root)) return recoveryView(binding)

    const snapshot = await dependencies.git.inspect(project.root)
    const current: SessionTargetCurrentView = snapshot
      ? { branch: snapshot.branch, oid: snapshot.headOid }
      : { branch: null, oid: UNVERSIONED_OID }
    const status = snapshot ? await dependencies.git.status(project.root) : { dirty: false }
    return {
      project: { id: binding.projectId, name: project.name },
      checkout: {
        id: `local:${binding.projectId}`,
        kind: 'local',
        label: 'Local Checkout',
        phase: 'ready',
      },
      source: { ref: binding.sourceRef, oid: binding.sourceOid },
      current,
      ownership: binding.inheritedFromSessionId ? 'inherited' : 'owner',
      dirty: status.dirty,
      revision: binding.revision,
    }
  }

  function projectPreviousReview(review: ManagedWorktreeReviewRecord): ManagedWorktreePreviousReviewRecord {
    return {
      reviewId: review.reviewId,
      iteration: review.iteration,
      summary: review.summary,
      suggestedCommitMessage: review.suggestedCommitMessage,
      changedFiles: review.changedFiles.slice(0, 50),
      ...(review.reviewBaseOid ? { reviewBaseOid: review.reviewBaseOid } : {}),
      ...(review.reviewBaseStrategy ? { reviewBaseStrategy: review.reviewBaseStrategy } : {}),
      ...(review.reviewLocalHeadOid ? { reviewLocalHeadOid: review.reviewLocalHeadOid } : {}),
    }
  }

  function projectCheckpoint(checkpoint: ManagedWorktreeCheckpointRecord): WorktreeCheckpointView {
    return {
      checkpointId: checkpoint.checkpointId,
      sequence: checkpoint.sequence,
      reviewId: checkpoint.reviewId,
      createdAt: checkpoint.createdAt,
      summary: checkpoint.summary,
      validationStatus: checkpoint.validationStatus,
      changedFiles: [...checkpoint.changedFiles],
    }
  }

  function projectDelivery(
    record: ManagedCheckoutRecord,
    commitInLocalHistory: boolean | null = null,
  ): SessionTargetView['delivery'] {
    const delivery = record.delivery
    // Discard 是未交付任务的终态。旧 review 仅保留在会话历史与 registry 审计记录中，
    // 不能继续投影为可操作 delivery，否则会重新产生待验收状态和 Work Activity。
    if (record.phase === 'discarded' && delivery.state !== 'delivered') return undefined
    const projectProof = (proof: { localBranch: string | null; localHeadBefore: string; localHeadAfter: string; changedFiles: string[] } | undefined): WorktreeDeliveryProofView | undefined => proof
      ? {
          localBranch: proof.localBranch,
          localHeadBefore: proof.localHeadBefore,
          localHeadAfter: proof.localHeadAfter,
          changedFiles: [...proof.changedFiles],
          commitInLocalHistory,
        }
      : undefined
    if (delivery.state === 'working') return delivery
    if (delivery.state === 'ready_for_review') return { state: delivery.state, review: delivery.review }
    if (delivery.state === 'preview_active') {
      return { state: delivery.state, review: delivery.review, previewedAt: delivery.preview.previewedAt }
    }
    if (delivery.state === 'preview_detached') {
      return {
        state: delivery.state,
        review: delivery.review,
        previewedAt: delivery.preview.previewedAt,
        detachedAt: delivery.detachedAt,
        reason: delivery.reason,
        attemptedAction: delivery.attemptedAction,
      }
    }
    if (delivery.state === 'finalized') {
      return {
        state: delivery.state,
        review: delivery.review,
        commitOid: delivery.commitOid,
        ...(projectProof(delivery.proof) ? { proof: projectProof(delivery.proof) } : {}),
        cleanup: delivery.cleanup,
        ...(delivery.cleanupMessage ? { cleanupMessage: delivery.cleanupMessage } : {}),
      }
    }
    if (delivery.state === 'retained') {
      return {
        state: delivery.state,
        review: delivery.review,
        commitOid: delivery.commitOid,
        ...(projectProof(delivery.proof) ? { proof: projectProof(delivery.proof) } : {}),
        retention: delivery.retention,
        retainedAt: delivery.retainedAt,
        expiresAt: delivery.expiresAt,
        cleanup: delivery.cleanup,
        ...(delivery.cleanupMessage ? { cleanupMessage: delivery.cleanupMessage } : {}),
      }
    }
    if (delivery.state === 'delivered') {
      const deliveredProof = projectProof(delivery.proof)
      return {
        state: delivery.state,
        iteration: delivery.iteration,
        commitOid: delivery.commitOid,
        deliveredAt: delivery.deliveredAt,
        ...(deliveredProof ? { proof: deliveredProof } : {}),
      }
    }
    return delivery
  }

  function normalizeCollaboratorStatus(status: unknown): WorktreeCollaboratorStatus {
    if (
      status === 'running'
      || status === 'completed'
      || status === 'failed'
      || status === 'cancelled'
      || status === 'interrupted'
    ) return status
    return 'unknown'
  }

  function isTerminalCollaboratorStatus(status: unknown): boolean {
    return status === 'completed'
      || status === 'failed'
      || status === 'cancelled'
      || status === 'interrupted'
  }

  function projectCollaborators(record: ManagedCheckoutRecord): WorktreeCollaboratorView[] {
    return Object.values(dependencies.registry.read().sessionBindings)
      .filter((candidate) => (
        candidate.sessionId !== record.ownerSessionId
        && candidate.target.kind === 'isolated'
        && candidate.target.checkoutId === record.checkoutId
      ))
      .map((candidate) => {
        const session = dependencies.lookup.getSession(candidate.sessionId)
        const rawStatus: unknown = session?.delegationStatus
        const active = dependencies.lookup.isSessionActive(candidate.sessionId)
        const kind = session?.sourceDelegationId
          ? 'delegation' as const
          : session?.parentSessionId
            ? 'fork' as const
            : 'unknown' as const
        const status = active
          ? 'running' as const
          : kind === 'fork'
            ? 'idle' as const
            : normalizeCollaboratorStatus(rawStatus)
        return {
          sessionId: candidate.sessionId,
          title: session?.title?.trim() || '未知协作会话',
          kind,
          status,
          canRelease: !active && (
            kind === 'fork'
            || (kind === 'delegation'
              && (session?.delegationCheckoutReleasedAt !== undefined || isTerminalCollaboratorStatus(rawStatus)))
          ),
        }
      })
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
  }

  function bindingForManagedRecord(record: ManagedCheckoutRecord): SessionBindingRecord {
    const persisted = dependencies.registry.read().sessionBindings[record.ownerSessionId]
    if (persisted?.target.kind === 'isolated' && persisted.target.checkoutId === record.checkoutId) return persisted
    return {
      sessionId: record.ownerSessionId,
      projectId: record.projectId,
      projectName: record.projectName,
      target: { kind: 'isolated', checkoutId: record.checkoutId },
      ownerSessionId: record.ownerSessionId,
      sourceRef: record.sourceRef,
      sourceOid: record.baseOid,
      revision: record.revision,
    }
  }

  function collaboratorStatusLabel(status: WorktreeCollaboratorStatus): string {
    if (status === 'running') return '运行中'
    if (status === 'idle') return '已停止'
    if (status === 'completed') return '已完成'
    if (status === 'failed') return '失败'
    if (status === 'cancelled') return '已取消'
    if (status === 'interrupted') return '已中断'
    return '状态未知'
  }

  function collaboratorBlockMessage(collaborators: WorktreeCollaboratorView[]): string {
    const labels = collaborators.map((collaborator) => `${collaborator.title}（${collaboratorStatusLabel(collaborator.status)}）`)
    return `Checkout 仍被协作会话使用，请先结束并释放占用：${labels.join('、')}`
  }

  function recoveryView(
    binding: SessionBindingRecord,
    record?: ManagedCheckoutRecord,
    dirty = false,
  ): SessionTargetView {
    const phase = record?.phase === 'discarded' ? 'discarded' : 'recovery_required'
    return {
      project: { id: binding.projectId, name: binding.projectName },
      checkout: {
        id: record?.checkoutId ?? (binding.target.kind === 'isolated' ? binding.target.checkoutId : `local:${binding.projectId}`),
        kind: binding.target.kind === 'isolated' ? 'isolated' : 'local',
        label: binding.target.kind === 'isolated' ? 'Isolated Checkout' : 'Local Checkout',
        phase,
        ...(record ? { iteration: managedIteration(record) } : {}),
      },
      source: { ref: binding.sourceRef, oid: binding.sourceOid },
      current: { branch: null, oid: binding.sourceOid },
      ownership: binding.inheritedFromSessionId ? 'inherited' : 'owner',
      dirty,
      revision: record?.revision ?? binding.revision,
      ...(record ? { delivery: projectDelivery(record) } : {}),
      ...((record?.checkpoints?.length ?? 0) > 0 ? { checkpoints: record!.checkpoints!.map(projectCheckpoint) } : {}),
    }
  }

  async function validateCommittedLocalCheckout(
    binding: SessionBindingRecord,
    record: ManagedCheckoutRecord,
  ): Promise<{ canonicalLocalRoot: string; snapshot: GitCheckoutSnapshot } | undefined> {
    if (
      binding.target.kind !== 'isolated'
      || binding.target.checkoutId !== record.checkoutId
      || binding.projectId !== record.projectId
      || binding.ownerSessionId !== record.ownerSessionId
    ) return undefined
    try {
      const project = dependencies.lookup.getProject(record.projectId)
      if (!project || !dependencies.files.exists(project.root) || !dependencies.files.exists(record.localRoot)) return undefined
      const canonicalProjectRoot = await dependencies.files.canonicalize(project.root)
      const canonicalLocalRoot = await dependencies.files.canonicalize(record.localRoot)
      if (!pathsEqual(canonicalProjectRoot, canonicalLocalRoot)) return undefined
      const snapshot = await dependencies.git.inspect(canonicalLocalRoot)
      if (!snapshot || !pathsEqual(snapshot.commonDir, record.gitCommonDir)) return undefined
      return { canonicalLocalRoot, snapshot }
    } catch {
      return undefined
    }
  }

  async function committedFollowupView(
    binding: SessionBindingRecord,
    record: ManagedCheckoutRecord,
  ): Promise<SessionTargetView> {
    if (
      record.delivery.state !== 'finalized'
      && record.delivery.state !== 'retained'
      && record.delivery.state !== 'delivered'
    ) return recoveryView(binding, record, true)
    const local = await validateCommittedLocalCheckout(binding, record)
    if (!local) return recoveryView(binding, record, true)
    const localSnapshot = local.snapshot
    let commitInLocalHistory: boolean | null = null
    if (record.delivery.commitOid) {
      try {
        commitInLocalHistory = await dependencies.git.isAncestor(
          local.canonicalLocalRoot,
          record.delivery.commitOid,
          localSnapshot.headOid,
        )
      } catch {
        commitInLocalHistory = null
      }
    }
    const delivery = projectDelivery(record, commitInLocalHistory)
    if (!delivery || (delivery.state !== 'finalized' && delivery.state !== 'retained' && delivery.state !== 'delivered')) {
      return recoveryView(binding, record, true)
    }
    const collaborators = binding.sessionId === record.ownerSessionId ? projectCollaborators(record) : []
    return {
      project: { id: record.projectId, name: record.projectName },
      checkout: {
        id: record.checkoutId,
        kind: 'isolated',
        label: 'Isolated Checkout',
        // Commit 已是权威交付事实；残余环境异常只能影响 cleanup，不能降级整个会话。
        phase: delivery.state === 'retained' ? 'retained' : delivery.state === 'delivered' ? 'discarded' : 'finalized',
        iteration: managedIteration(record),
      },
      source: { ref: record.sourceRef, oid: record.baseOid },
      current: {
        branch: localSnapshot.branch,
        oid: localSnapshot.headOid,
      },
      ownership: binding.inheritedFromSessionId ? 'inherited' : 'owner',
      dirty: true,
      revision: record.revision,
      delivery,
      ...(collaborators.length > 0 ? { collaborators } : {}),
    }
  }

  async function discardedFollowupView(
    binding: SessionBindingRecord,
    record: ManagedCheckoutRecord,
  ): Promise<SessionTargetView> {
    const local = await validateCommittedLocalCheckout(binding, record)
    if (!local) return recoveryView(binding, record, true)
    const collaborators = binding.sessionId === record.ownerSessionId ? projectCollaborators(record) : []
    return {
      project: { id: record.projectId, name: record.projectName },
      checkout: {
        id: record.checkoutId,
        kind: 'isolated',
        label: 'Isolated Checkout',
        phase: 'discarded',
        iteration: managedIteration(record),
      },
      source: { ref: record.sourceRef, oid: record.baseOid },
      current: {
        branch: local.snapshot.branch,
        oid: local.snapshot.headOid,
      },
      ownership: binding.inheritedFromSessionId ? 'inherited' : 'owner',
      dirty: true,
      revision: record.revision,
      ...(collaborators.length > 0 ? { collaborators } : {}),
    }
  }

  function markRecoveryRequired(record: ManagedCheckoutRecord): ManagedCheckoutRecord {
    if (record.phase === 'recovery_required' || record.phase === 'discarded') return record
    const registry = dependencies.registry.read()
    const current = registry.managedCheckouts[record.checkoutId]
    if (!current) return record
    if (current.revision !== record.revision || current.phase !== record.phase) return current
    const recovered = {
      ...current,
      phase: 'recovery_required' as const,
      revision: current.revision + 1,
    }
    registry.managedCheckouts[record.checkoutId] = recovered
    registry.revision += 1
    dependencies.registry.write(registry)
    return recovered
  }

  interface ValidatedManagedCheckout {
    canonicalManagedRoot: string
    canonicalManagedGitRoot: string
    snapshot: GitCheckoutSnapshot
    status: { dirty: boolean }
  }

  type ManagedCheckoutValidationResult =
    | { status: 'valid'; checkout: ValidatedManagedCheckout }
    | { status: 'invalid' }
    | { status: 'unavailable' }

  async function checkpointHeadInvariantHolds(
    record: ManagedCheckoutRecord,
    managedRoot: string,
    headOid: string,
  ): Promise<boolean> {
    const checkpoints = record.checkpoints ?? []
    if (checkpoints.length === 0) return true
    const seen = new Set<string>()
    for (let index = 0; index < checkpoints.length; index += 1) {
      const checkpoint = checkpoints[index]!
      if (checkpoint.sequence !== index + 1 || seen.has(checkpoint.checkpointId)) return false
      seen.add(checkpoint.checkpointId)
      if (!(await dependencies.git.isAncestor(managedRoot, checkpoint.parentOid, checkpoint.commitOid))) return false
      if (
        index > 0
        && !(await dependencies.git.isAncestor(managedRoot, checkpoints[index - 1]!.commitOid, checkpoint.parentOid))
      ) return false
    }
    // 保存阶段之间和最后阶段之后都允许继续产生 commit/merge，但不能改写掉任何 checkpoint。
    return dependencies.git.isAncestor(managedRoot, checkpoints[checkpoints.length - 1]!.commitOid, headOid)
  }

  async function validateManagedCheckoutDetailed(
    binding: SessionBindingRecord,
    record: ManagedCheckoutRecord,
    requireCreateBase: boolean,
  ): Promise<ManagedCheckoutValidationResult> {
    if (
      binding.target.kind !== 'isolated'
      || binding.target.checkoutId !== record.checkoutId
      || binding.projectId !== record.projectId
      || binding.ownerSessionId !== record.ownerSessionId
      || !dependencies.files.exists(record.managedRoot)
    ) return { status: 'invalid' }

    try {
      const canonicalManagedRoot = await dependencies.files.canonicalize(record.managedRoot)
      const canonicalManagedGitRoot = await dependencies.files.canonicalize(record.managedGitRoot)
      const canonicalLocalRoot = await dependencies.files.canonicalize(record.localRoot)
      const project = dependencies.lookup.getProject(record.projectId)
      if (project) {
        if (!dependencies.files.exists(project.root)) return { status: 'invalid' }
        const canonicalProjectRoot = await dependencies.files.canonicalize(project.root)
        if (!pathsEqual(canonicalProjectRoot, canonicalLocalRoot)) return { status: 'invalid' }
      }
      const snapshot = await dependencies.git.inspect(canonicalManagedRoot)
      const localSnapshot = await dependencies.git.inspect(canonicalLocalRoot)
      if (!snapshot || !localSnapshot) return { status: 'invalid' }

      const projectRelativePath = relative(localSnapshot.root, canonicalLocalRoot)
      if (
        projectRelativePath.startsWith('..')
        || isAbsolute(projectRelativePath)
        || !resolvedPathsEqual(canonicalManagedRoot, record.managedRoot)
        || !resolvedPathsEqual(canonicalManagedGitRoot, record.managedGitRoot)
        || !resolvedPathsEqual(canonicalLocalRoot, record.localRoot)
        || !pathsEqual(snapshot.root, canonicalManagedGitRoot)
        || !pathsEqual(snapshot.commonDir, record.gitCommonDir)
        || !pathsEqual(localSnapshot.commonDir, record.gitCommonDir)
        || !pathsEqual(resolve(snapshot.root, projectRelativePath), canonicalManagedRoot)
        || (!requireCreateBase && !pathsEqual(snapshot.gitDir, record.gitDir))
        || (requireCreateBase && snapshot.headOid !== record.baseOid)
        || (!requireCreateBase && !(await checkpointHeadInvariantHolds(record, canonicalManagedRoot, snapshot.headOid)))
      ) return { status: 'invalid' }

      const status = await dependencies.git.status(canonicalManagedRoot)
      return {
        status: 'valid',
        checkout: { canonicalManagedRoot, canonicalManagedGitRoot, snapshot, status },
      }
    } catch {
      // Git 子进程超时、杀毒软件占用等瞬时 I/O 故障不能永久污染健康 Worktree。
      return { status: 'unavailable' }
    }
  }

  async function validateManagedCheckout(
    binding: SessionBindingRecord,
    record: ManagedCheckoutRecord,
    requireCreateBase: boolean,
  ): Promise<ValidatedManagedCheckout | undefined> {
    const result = await validateManagedCheckoutDetailed(binding, record, requireCreateBase)
    return result.status === 'valid' ? result.checkout : undefined
  }

  interface ValidatedCleanupResidue {
    canonicalManagedGitRoot: string
    directoryIdentity: DirectoryIdentity
  }

  function directoryIdentitiesEqual(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
    return left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs
  }

  function hasCleanupRemovalReceipt(record: ManagedCheckoutRecord): boolean {
    return record.journal?.operation === 'cleanup'
      && record.journal.step === 'removing_worktree'
      && record.journal.managedDirectoryIdentity !== undefined
  }

  function hasLegacyCleanupResidueEvidence(record: ManagedCheckoutRecord): boolean {
    if (record.journal !== null) return false
    if (record.delivery.state !== 'finalized' && record.delivery.state !== 'retained') return false
    if (record.delivery.cleanup !== 'blocked') return false
    if (record.delivery.cleanupMessage !== CLEANUP_IDENTITY_CHANGED_MESSAGE) return false
    const checkoutIdentity = record.checkoutId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
    return checkoutIdentity.length > 0 && basename(record.managedGitRoot).endsWith(`--${checkoutIdentity}`)
  }

  async function validateCleanupLocalIdentity(record: ManagedCheckoutRecord): Promise<GitCheckoutSnapshot | undefined> {
    if (!dependencies.files.exists(record.localRoot)) return undefined
    const project = dependencies.lookup.getProject(record.projectId)
    if (!project || !dependencies.files.exists(project.root)) return undefined
    try {
      const canonicalLocalRoot = await dependencies.files.canonicalize(record.localRoot)
      const canonicalProjectRoot = await dependencies.files.canonicalize(project.root)
      if (!resolvedPathsEqual(canonicalLocalRoot, record.localRoot) || !pathsEqual(canonicalProjectRoot, canonicalLocalRoot)) return undefined
      const localSnapshot = await dependencies.git.inspect(canonicalLocalRoot)
      if (!localSnapshot || !pathsEqual(localSnapshot.commonDir, record.gitCommonDir)) return undefined
      const projectRelativePath = relative(localSnapshot.root, canonicalLocalRoot)
      if (projectRelativePath.startsWith('..') || isAbsolute(projectRelativePath)) return undefined
      return localSnapshot
    } catch {
      return undefined
    }
  }

  async function validateDetachedCleanupResidue(
    record: ManagedCheckoutRecord,
    allowLegacyResidue = false,
  ): Promise<ValidatedCleanupResidue | undefined> {
    if (record.delivery.state !== 'finalized' && record.delivery.state !== 'retained') return undefined
    const receipt = hasCleanupRemovalReceipt(record)
    const legacy = allowLegacyResidue && hasLegacyCleanupResidueEvidence(record)
    if (!receipt && !legacy) return undefined
    if (!dependencies.files.exists(record.managedGitRoot) || dependencies.files.exists(record.gitDir)) return undefined

    try {
      const localSnapshot = await validateCleanupLocalIdentity(record)
      if (!localSnapshot) return undefined
      const canonicalManagedGitRoot = await dependencies.files.canonicalize(record.managedGitRoot)
      if (!resolvedPathsEqual(canonicalManagedGitRoot, record.managedGitRoot)) return undefined

      const projectRelativePath = relative(localSnapshot.root, record.localRoot)
      const expectedManagedRoot = resolve(canonicalManagedGitRoot, projectRelativePath)
      if (!pathsEqual(expectedManagedRoot, record.managedRoot)) return undefined
      if (dependencies.files.exists(record.managedRoot)) {
        const canonicalManagedRoot = await dependencies.files.canonicalize(record.managedRoot)
        if (!resolvedPathsEqual(canonicalManagedRoot, record.managedRoot) || !pathsEqual(canonicalManagedRoot, expectedManagedRoot)) return undefined
      }

      const managedSnapshot = await dependencies.git.inspect(canonicalManagedGitRoot)
      if (managedSnapshot) return undefined
      const containingWorktreeRoot = await dependencies.git.findContainingWorktreeRoot(canonicalManagedGitRoot)
      if (containingWorktreeRoot) return undefined
      const directoryIdentity = await dependencies.files.inspectDirectoryIdentity(canonicalManagedGitRoot)
      if (!directoryIdentity) return undefined
      const expectedIdentity = record.journal?.operation === 'cleanup'
        ? record.journal.managedDirectoryIdentity
        : undefined
      if (expectedIdentity && !directoryIdentitiesEqual(directoryIdentity, expectedIdentity)) return undefined
      return { canonicalManagedGitRoot, directoryIdentity }
    } catch {
      return undefined
    }
  }

  async function validateCleanupQuarantine(record: ManagedCheckoutRecord): Promise<string | undefined> {
    const journal = record.journal?.operation === 'cleanup' ? record.journal : undefined
    const quarantinePath = journal?.cleanupQuarantinePath
    const expectedIdentity = journal?.managedDirectoryIdentity
    if (!quarantinePath || !expectedIdentity || !dependencies.files.exists(quarantinePath)) return undefined
    const expectedName = `.domi-cleanup--${record.checkoutId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}--${journal.operationId}`
    if (!resolvedPathsEqual(dirname(quarantinePath), dirname(record.managedGitRoot)) || basename(quarantinePath) !== expectedName) return undefined
    try {
      if (!await validateCleanupLocalIdentity(record)) return undefined
      const canonicalQuarantinePath = await dependencies.files.canonicalize(quarantinePath)
      if (!resolvedPathsEqual(canonicalQuarantinePath, quarantinePath)) return undefined
      const identity = await dependencies.files.inspectDirectoryIdentity(canonicalQuarantinePath)
      if (!identity || !directoryIdentitiesEqual(identity, expectedIdentity)) return undefined
      return canonicalQuarantinePath
    } catch {
      return undefined
    }
  }

  async function inspectIsolated(binding: SessionBindingRecord, persistRecovery = true): Promise<SessionTargetView> {
    if (binding.target.kind !== 'isolated') return recoveryView(binding)
    const registry = dependencies.registry.read()
    let record = registry.managedCheckouts[binding.target.checkoutId]
    if (!record) return recoveryView(binding)
    if (
      record.projectId !== binding.projectId
      || record.ownerSessionId !== binding.ownerSessionId
    ) {
      if (persistRecovery) record = markRecoveryRequired(record)
      return recoveryView(binding, record)
    }
    if (record.phase === 'discarded') {
      if (record.delivery.state === 'delivered') return committedFollowupView(binding, record)
      return discardedFollowupView(binding, record)
    }

    let prefetchedValidation: ValidatedManagedCheckout | undefined
    if (
      record.phase === 'recovery_required'
      && record.journal === null
      && dependencies.files.exists(record.managedRoot)
    ) {
      const recoveryValidation = await validateManagedCheckoutDetailed(binding, record, false)
      if (recoveryValidation.status === 'valid' && persistRecovery) {
        const restored = updateManagedCheckout(record.checkoutId, (current) => ({
          ...current,
          managedRoot: recoveryValidation.checkout.canonicalManagedRoot,
          managedGitRoot: recoveryValidation.checkout.canonicalManagedGitRoot,
          gitDir: recoveryValidation.checkout.snapshot.gitDir,
          phase: 'ready',
          // recovery 期间无法继续信任旧验收 fingerprint；保留文件与 checkpoint，要求重新准备验收。
          ...(current.delivery.state === 'ready_for_review' ? { previousReview: projectPreviousReview(current.delivery.review) } : {}),
          delivery: current.delivery.state === 'ready_for_review'
            ? { state: 'working', iteration: current.delivery.review.iteration }
            : current.delivery,
          revision: current.revision + 1,
        }))
        if (restored) {
          record = restored
          prefetchedValidation = recoveryValidation.checkout
        }
      }
    }

    if ((record.phase !== 'ready' && record.phase !== 'finalized' && record.phase !== 'retained') || !dependencies.files.exists(record.managedRoot)) {
      if (record.delivery.state === 'finalized' || record.delivery.state === 'retained') {
        return committedFollowupView(binding, record)
      }
      if (persistRecovery) record = markRecoveryRequired(record)
      let dirty = false
      if (dependencies.files.exists(record.managedRoot)) {
        try {
          dirty = (await dependencies.git.status(record.managedRoot)).dirty
        } catch {
          dirty = true
        }
      }
      return recoveryView(binding, record, dirty)
    }

    const validation = prefetchedValidation
      ? { status: 'valid' as const, checkout: prefetchedValidation }
      : await validateManagedCheckoutDetailed(binding, record, false)
    if (validation.status !== 'valid') {
      if (record.delivery.state === 'finalized' || record.delivery.state === 'retained') {
        return committedFollowupView(binding, record)
      }
      // 只有确定的身份/路径不匹配才持久进入 recovery；瞬时 Git/I/O 故障允许下一次 inspect 直接重试。
      if (persistRecovery && validation.status === 'invalid') record = markRecoveryRequired(record)
      return recoveryView(binding, record)
    }
    const { snapshot, status } = validation.checkout

    // 兼容旧版 Checkpoint：旧实现会在 Commit 成功后把 delivery 降级为 working，
    // 导致历史验收卡失去同步入口。只有 Worktree 仍 clean、HEAD 精确等于最后一个
    // Checkpoint 且轮次一致时，才能证明该验收快照没有继续变化并安全恢复。
    const latestCheckpoint = record.checkpoints?.at(-1)
    if (
      persistRecovery
      && record.phase === 'ready'
      && record.delivery.state === 'working'
      && latestCheckpoint?.iteration === record.delivery.iteration
      && latestCheckpoint.commitOid === snapshot.headOid
      && !status.dirty
    ) {
      const reviewSnapshot = await dependencies.applyEngine.inspectReview({
        baseOid: record.applyBaseOid ?? record.baseOid,
        isolatedPath: record.managedRoot,
        localPath: record.localRoot,
      })
      if (
        reviewSnapshot.status === 'ready'
        && reviewSnapshot.isolatedHeadOid === latestCheckpoint.commitOid
      ) {
        const restored = updateManagedCheckout(record.checkoutId, (current) => {
          const currentCheckpoint = current.checkpoints?.at(-1)
          if (
            current.phase !== 'ready'
            || current.delivery.state !== 'working'
            || currentCheckpoint?.checkpointId !== latestCheckpoint.checkpointId
            || currentCheckpoint.commitOid !== reviewSnapshot.isolatedHeadOid
          ) return current
          return {
            ...current,
            delivery: {
              state: 'ready_for_review',
              review: {
                reviewId: currentCheckpoint.reviewId,
                iteration: currentCheckpoint.iteration,
                preparedAt: currentCheckpoint.createdAt,
                summary: currentCheckpoint.summary,
                validationStatus: currentCheckpoint.validationStatus,
                tests: [],
                changedFiles: [...reviewSnapshot.changedFiles],
                suggestedCommitMessage: currentCheckpoint.commitMessage,
                isolatedFingerprint: reviewSnapshot.isolatedFingerprint,
                isolatedHeadOid: reviewSnapshot.isolatedHeadOid,
                reviewBaseOid: reviewSnapshot.effectiveBaseOid,
                reviewBaseStrategy: reviewSnapshot.baseStrategy,
                reviewLocalHeadOid: reviewSnapshot.localHeadOid,
              },
            },
            revision: current.revision + 1,
          }
        })
        if (restored?.delivery.state === 'ready_for_review') record = restored
      }
    }

    const delivery = projectDelivery(record)
    const collaborators = binding.sessionId === record.ownerSessionId ? projectCollaborators(record) : []
    const activePreview = delivery?.state === 'ready_for_review'
      ? Object.values(registry.managedCheckouts).find((candidate) => (
          candidate.checkoutId !== record.checkoutId
          && candidate.phase !== 'discarded'
          && pathsEqual(candidate.localRoot, record.localRoot)
          && holdsProjectAcceptanceSlot(candidate)
        ))
      : undefined
    return {
      project: { id: record.projectId, name: record.projectName },
      checkout: {
        id: record.checkoutId,
        kind: 'isolated',
        label: 'Isolated Checkout',
        phase: record.phase,
        iteration: managedIteration(record),
      },
      source: { ref: record.sourceRef, oid: record.baseOid },
      current: { branch: snapshot.branch, oid: snapshot.headOid },
      ownership: binding.inheritedFromSessionId ? 'inherited' : 'owner',
      dirty: status.dirty,
      revision: record.revision,
      delivery,
      ...((record.checkpoints?.length ?? 0) > 0
        ? { checkpoints: record.checkpoints!.map(projectCheckpoint) }
        : {}),
      ...(delivery?.state === 'ready_for_review'
        ? {
            reviewSlot: activePreview ? 'waiting' as const : 'available' as const,
            ...(activePreview ? { reviewSlotOwnerSessionId: activePreview.ownerSessionId } : {}),
          }
        : {}),
      ...(collaborators.length > 0 ? { collaborators } : {}),
    }
  }

  function getPersistedBinding(sessionId: string): SessionBindingRecord | undefined {
    return dependencies.registry.read().sessionBindings[sessionId]
  }

  async function createLegacyLocalBinding(sessionId: string): Promise<SessionBindingRecord | undefined> {
    const resolved = await resolveSessionProject(sessionId)
    if (dependencies.lookup.getUnboundTargetPolicy(resolved.session) !== 'local') return undefined
    const snapshot = await dependencies.git.inspect(resolved.project.root)
    return {
      sessionId,
      projectId: resolved.project.id,
      projectName: resolved.project.name,
      target: { kind: 'local' },
      ownerSessionId: sessionId,
      sourceRef: snapshot?.headRef ?? UNVERSIONED_REF,
      sourceOid: snapshot?.headOid ?? UNVERSIONED_OID,
      revision: 0,
    }
  }

  async function resolveBinding(sessionId: string): Promise<SessionBindingRecord> {
    const session = requireSession(sessionId)
    const persisted = getPersistedBinding(sessionId)
    if (persisted) {
      if (session.projectId !== persisted.projectId) {
        throw new SessionCheckoutError(
          'project_mismatch',
          '会话当前项目与已绑定 Session Target 不一致，已停止访问 checkout',
        )
      }
      return persisted
    }
    const legacy = await createLegacyLocalBinding(sessionId)
    if (legacy) return legacy
    throw new SessionCheckoutError('target_unselected', '会话尚未选择 Session Target')
  }

  type BindingOperationMode = 'exclusive' | 'maintenance'

  interface BindingOperationScope {
    sessionIds: ReadonlySet<string>
    targetKeys: ReadonlySet<string>
  }

  interface BindingLockOptions {
    allowConcurrentInspect?: boolean
    sessionIds?: readonly string[]
    targetKeys?: readonly string[]
  }

  interface ConcurrentInspect {
    sessionId: string
    targetKey?: string
    done: Promise<void>
    finish(): void
  }

  let bindingQueue: Promise<void> = Promise.resolve()
  let activeBindingOperation: BindingOperationMode | null = null
  let activeBindingOperationScope: BindingOperationScope | null = null
  let activeBindingOperationDone: Promise<void> = Promise.resolve()
  let pendingMaintenanceOperations = 0
  let maintenanceReady: Promise<void> | undefined
  let signalMaintenanceReady = (): void => undefined
  const activeConcurrentInspects = new Set<ConcurrentInspect>()

  function prepareMaintenanceReadySignal(): void {
    maintenanceReady = new Promise<void>((resolveReady) => { signalMaintenanceReady = resolveReady })
  }

  function targetKeyForBinding(binding: SessionBindingRecord | undefined): string | undefined {
    if (!binding) return undefined
    return binding.target.kind === 'isolated'
      ? `isolated:${binding.target.checkoutId}`
      : `local:${binding.projectId}`
  }

  function createBindingOperationScope(options: BindingLockOptions): BindingOperationScope | null {
    const sessionIds = options.sessionIds ?? []
    const targetKeys = options.targetKeys ?? []
    if (sessionIds.length === 0 && targetKeys.length === 0) return null
    const registry = dependencies.registry.read()
    return {
      sessionIds: new Set(sessionIds),
      targetKeys: new Set([
        ...targetKeys,
        ...sessionIds.flatMap((sessionId) => {
          const targetKey = targetKeyForBinding(registry.sessionBindings[sessionId])
          return targetKey ? [targetKey] : []
        }),
      ]),
    }
  }

  function inspectConflictsWithActiveOperation(sessionId: string): boolean {
    const scope = activeBindingOperationScope
    if (!scope) return true
    if (scope.sessionIds.has(sessionId)) return true
    const binding = dependencies.registry.read().sessionBindings[sessionId]
    const targetKey = targetKeyForBinding(binding)
    return targetKey !== undefined && scope.targetKeys.has(targetKey)
  }

  function beginConcurrentInspect(sessionId: string): ConcurrentInspect {
    const binding = dependencies.registry.read().sessionBindings[sessionId]
    const targetKey = targetKeyForBinding(binding)
    let signalDone = (): void => undefined
    const inspect: ConcurrentInspect = {
      sessionId,
      ...(targetKey ? { targetKey } : {}),
      done: new Promise<void>((resolveDone) => { signalDone = resolveDone }),
      finish: () => {
        activeConcurrentInspects.delete(inspect)
        signalDone()
      },
    }
    activeConcurrentInspects.add(inspect)
    return inspect
  }

  function concurrentInspectConflicts(
    inspect: ConcurrentInspect,
    operationScope: BindingOperationScope | null,
  ): boolean {
    if (!operationScope) return true
    if (operationScope.sessionIds.has(inspect.sessionId)) return true
    return inspect.targetKey !== undefined && operationScope.targetKeys.has(inspect.targetKey)
  }

  async function waitForConflictingInspects(operationScope: BindingOperationScope | null): Promise<void> {
    const blockers = [...activeConcurrentInspects]
      .filter((inspect) => concurrentInspectConflicts(inspect, operationScope))
      .map((inspect) => inspect.done)
    if (blockers.length > 0) await Promise.all(blockers)
  }

  async function withBindingLock<T>(
    operation: () => Promise<T>,
    options: BindingLockOptions = {},
  ): Promise<T> {
    const maintenance = options.allowConcurrentInspect === true
    if (maintenance) {
      pendingMaintenanceOperations += 1
      if (pendingMaintenanceOperations === 1) prepareMaintenanceReadySignal()
    }

    const previous = bindingQueue
    let release = (): void => undefined
    bindingQueue = new Promise<void>((resolveLock) => { release = resolveLock })
    await previous.catch(() => undefined)

    let signalOperationDone = (): void => undefined
    activeBindingOperationDone = new Promise<void>((resolveDone) => { signalOperationDone = resolveDone })
    activeBindingOperationScope = createBindingOperationScope(options)
    activeBindingOperation = maintenance ? 'maintenance' : 'exclusive'
    if (maintenance) signalMaintenanceReady()
    // 先公布即将执行的作用域，阻止新的冲突 inspect；只等待此前已启动且真正冲突的读取。
    await waitForConflictingInspects(activeBindingOperationScope)

    try {
      return await operation()
    } finally {
      if (maintenance) {
        pendingMaintenanceOperations -= 1
        if (pendingMaintenanceOperations > 0) prepareMaintenanceReadySignal()
        else maintenanceReady = undefined
      }
      activeBindingOperationScope = null
      activeBindingOperation = null
      signalOperationDone()
      release()
    }
  }

  async function inspectTarget(sessionId: string, persistRecovery = true): Promise<SessionTargetView> {
    const binding = await resolveBinding(sessionId)
    if (binding.target.kind === 'local') return inspectLocal(binding)
    return inspectIsolated(binding, persistRecovery)
  }

  async function inspectConcurrently(sessionId: string): Promise<SessionTargetView> {
    const inspect = beginConcurrentInspect(sessionId)
    try {
      // 并发 inspect 只读取 registry/Git 权威快照，不持久化恢复状态，避免与 mutation 交叉写入。
      return await inspectTarget(sessionId, false)
    } finally {
      inspect.finish()
    }
  }

  async function inspectAvailable(sessionId: string): Promise<SessionTargetView> {
    while (true) {
      if (activeBindingOperation === 'maintenance') return inspectConcurrently(sessionId)
      if (
        activeBindingOperation === 'exclusive'
        && !inspectConflictsWithActiveOperation(sessionId)
      ) return inspectConcurrently(sessionId)
      if (activeBindingOperation !== null) {
        const operationDone = activeBindingOperationDone
        await operationDone.catch(() => undefined)
        continue
      }
      if (pendingMaintenanceOperations > 0 && maintenanceReady) {
        // maintenance 可能排在当前交互操作之后；等它取得锁并公布并发读取边界。
        await maintenanceReady
        continue
      }
      return withBindingLock(() => inspectTarget(sessionId, true), { sessionIds: [sessionId] })
    }
  }

  function readSessionDeliveries(sessionIds: readonly string[]): Map<string, NonNullable<SessionTargetView['delivery']>> {
    const registry = dependencies.registry.read()
    const deliveries = new Map<string, NonNullable<SessionTargetView['delivery']>>()
    for (const sessionId of sessionIds) {
      const binding = registry.sessionBindings[sessionId]
      if (!binding || binding.target.kind !== 'isolated') continue
      const record = registry.managedCheckouts[binding.target.checkoutId]
      if (
        !record
        || record.projectId !== binding.projectId
        || record.ownerSessionId !== binding.ownerSessionId
      ) continue
      const delivery = projectDelivery(record)
      if (delivery) deliveries.set(sessionId, delivery)
    }
    return deliveries
  }

  function readSessionChangedFiles(sessionId: string): string[] {
    const registry = dependencies.registry.read()
    const binding = registry.sessionBindings[sessionId]
    const boundCheckoutIds = binding?.target.kind === 'isolated'
      ? new Set([binding.target.checkoutId])
      : undefined
    return collectSessionProjectArtifactPaths({
      sessionId,
      checkoutRecords: Object.values(registry.managedCheckouts),
      boundCheckoutIds,
      checkpointPaths: [],
      currentChangedPaths: [],
      deletedPaths: [],
    })
  }

  async function assertReleaseSession(
    sessionId: string,
    intent: SessionCheckoutReleaseIntent,
  ): Promise<SessionBindingRecord | undefined> {
    const session = requireSession(sessionId)
    const registry = dependencies.registry.read()
    const binding = registry.sessionBindings[sessionId]
    if (!binding) {
      if (
        intent === 'move'
        && dependencies.lookup.getUnboundTargetPolicy(session) === 'local'
      ) {
        throw new SessionCheckoutError(
          'target_already_bound',
          '历史 Pi 会话已绑定 Local Checkout，不能移动项目',
        )
      }
      return undefined
    }
    if (session.projectId !== binding.projectId) {
      throw new SessionCheckoutError(
        'project_mismatch',
        '会话当前项目与已绑定 Session Target 不一致，已停止生命周期操作',
      )
    }
    if (intent === 'move') {
      const targetLabel = binding.target.kind === 'isolated' ? 'Isolated' : 'Local'
      throw new SessionCheckoutError(
        'target_already_bound',
        `已绑定 ${targetLabel} Checkout 的 Pi 会话不能移动项目`,
      )
    }

    if (binding.inheritedFromSessionId || binding.target.kind === 'local') return binding
    if (binding.target.kind !== 'isolated') {
      throw new SessionCheckoutError('registry_corrupt', 'Session binding 的目标类型无效')
    }
    const record = registry.managedCheckouts[binding.target.checkoutId]
    if (!record) {
      throw new SessionCheckoutError(
        'checkout_missing',
        'Isolated Checkout 记录不存在，无法安全删除 owner 会话',
      )
    }
    if (record.phase === 'retained' && record.delivery.state === 'retained') return binding
    if (record.phase !== 'discarded') {
      let dirty = true
      if (dependencies.files.exists(record.managedRoot)) {
        try {
          dirty = (await dependencies.git.status(record.managedRoot)).dirty
        } catch {
          dirty = true
        }
      }
      const dirtyHint = dirty ? '且仍含未处理修改，' : ''
      throw new SessionCheckoutError(
        'operation_not_allowed',
        `Owner 的 Isolated Checkout 尚未 Discard${dirtyHint}请先 Apply/Discard`,
      )
    }
    return binding
  }

  async function releaseSession(
    sessionId: string,
    intent: SessionCheckoutReleaseIntent,
  ): Promise<void> {
    const binding = await assertReleaseSession(sessionId, intent)
    if (!binding) return
    const registry = dependencies.registry.read()
    if (!registry.sessionBindings[sessionId]) return
    delete registry.sessionBindings[sessionId]
    registry.revision += 1
    dependencies.registry.write(registry)
  }

  async function reconcile(): Promise<SessionCheckoutReconcileSummary> {
    const registry = dependencies.registry.read()
    const recoveryRequiredCheckoutIds: string[] = []
    const orphanedCheckoutIds: string[] = []
    const dirtyOrphanedCheckoutIds: string[] = []
    let changed = false

    for (const [checkoutId, current] of Object.entries(registry.managedCheckouts)) {
      if (current.phase === 'discarded') continue
      let record = current
      if (current.delivery.state === 'finalized') {
        // Commit 已完成的 checkout 只保留事实，不在启动 reconcile 中做物理清理。
        // Windows 文件占用会让单项清理等待 30 秒；多个残余串行执行会长期占用全局 binding lock，
        // 导致新会话的 Session Target bind 排队并在 Renderer 侧超时。用户可在 Worktree 管理中重试清理。
        continue
      }
      if (
        current.phase === 'mutating'
        && (current.journal?.operation === 'finalize_preview' || current.journal?.operation === 'finish')
        && current.journal.step === 'updating_ref'
        && typeof current.journal.commitOid === 'string'
        && current.delivery.state === 'preview_active'
      ) {
        const local = await dependencies.git.inspect(current.localRoot)
        if (local?.headOid === current.journal.commitOid) {
          const retention = current.journal.retention ?? 'cleanup'
          const recoveredAt = Date.now()
          record = retention === 'cleanup'
            ? {
                ...current,
                phase: 'finalized',
                delivery: {
                  state: 'finalized',
                  review: current.delivery.review,
                  commitOid: current.journal.commitOid,
                  proof: {
                    localBranch: current.delivery.preview.localHeadRef?.startsWith('refs/heads/')
                      ? current.delivery.preview.localHeadRef.slice('refs/heads/'.length)
                      : null,
                    localHeadBefore: current.delivery.preview.localHeadOid,
                    localHeadAfter: current.journal.commitOid,
                    changedFiles: [...current.delivery.preview.changedFiles],
                  },
                  isolatedFingerprint: current.delivery.preview.isolatedFingerprint,
                  finalizedAt: recoveredAt,
                  cleanup: 'blocked',
                  cleanupMessage: 'Commit 已创建，但进程在 Local index 完成前中断；请确认 Local 状态后再处理 Worktree。',
                },
                journal: null,
                revision: current.revision + 1,
              }
            : {
                ...current,
                phase: 'retained',
                delivery: {
                  state: 'retained',
                  review: current.delivery.review,
                  commitOid: current.journal.commitOid,
                  proof: {
                    localBranch: current.delivery.preview.localHeadRef?.startsWith('refs/heads/')
                      ? current.delivery.preview.localHeadRef.slice('refs/heads/'.length)
                      : null,
                    localHeadBefore: current.delivery.preview.localHeadOid,
                    localHeadAfter: current.journal.commitOid,
                    changedFiles: [...current.delivery.preview.changedFiles],
                  },
                  isolatedFingerprint: current.delivery.preview.isolatedFingerprint,
                  retention,
                  retainedAt: recoveredAt,
                  expiresAt: retentionExpiresAt(retention, recoveredAt),
                  cleanup: 'blocked',
                  cleanupMessage: 'Commit 已创建并保留 Worktree，但进程在 Local index 完成前中断；请确认 Local 状态。',
                },
                journal: null,
                revision: current.revision + 1,
              }
        } else {
          record = {
            ...current,
            phase: 'ready',
            journal: null,
            revision: current.revision + 1,
          }
        }
        registry.managedCheckouts[checkoutId] = record
        registry.revision += 1
        changed = true
      } else if (
        current.phase === 'mutating'
        && current.journal?.operation === 'checkpoint'
        && current.delivery.state === 'ready_for_review'
      ) {
        const journal = current.journal
        if (journal.step === 'planning') {
          record = { ...current, phase: 'ready', journal: null, revision: current.revision + 1 }
        } else if (
          journal.step === 'updating_ref'
          && typeof journal.commitOid === 'string'
          && typeof journal.parentOid === 'string'
          && typeof journal.checkpointId === 'string'
          && typeof journal.checkpointSequence === 'number'
          && typeof journal.checkpointMessage === 'string'
          && typeof journal.checkpointIndexTreeOid === 'string'
          && Array.isArray(journal.changedFiles)
        ) {
          const recovered = await dependencies.applyEngine.recoverCheckpoint({
            isolatedPath: current.managedRoot,
            commitOid: journal.commitOid,
            parentOid: journal.parentOid,
            expectedIndexTreeOid: journal.checkpointIndexTreeOid,
          })
          if (recovered.status === 'checkpoint_aborted') {
            try {
              await dependencies.git.releaseInternalArtifacts(current.localRoot, current.checkoutId, `checkpoints/${journal.checkpointId}`)
            } catch {
              console.warn('[session-checkout] 清理未生效 Checkpoint ref 失败，已保守保留不可见引用')
            }
            record = { ...current, phase: 'ready', journal: null, revision: current.revision + 1 }
          } else if (recovered.status === 'checkpoint_recovered') {
            const review = current.delivery.review
            const checkpoint: ManagedWorktreeCheckpointRecord = {
              checkpointId: journal.checkpointId,
              sequence: journal.checkpointSequence,
              reviewId: review.reviewId,
              iteration: review.iteration,
              createdAt: Date.now(),
              commitOid: journal.commitOid,
              parentOid: journal.parentOid,
              summary: review.summary,
              commitMessage: journal.checkpointMessage,
              validationStatus: review.validationStatus,
              changedFiles: [...journal.changedFiles],
            }
            record = {
              ...current,
              phase: 'ready',
              checkpoints: [...(current.checkpoints ?? []), checkpoint],
              delivery: {
                state: 'ready_for_review',
                review: {
                  ...review,
                  isolatedFingerprint: recovered.isolatedFingerprint,
                  isolatedHeadOid: journal.commitOid,
                },
              },
              journal: null,
              revision: current.revision + 1,
            }
          } else {
            record = { ...current, phase: 'recovery_required', revision: current.revision + 1 }
            recoveryRequiredCheckoutIds.push(checkoutId)
          }
        } else {
          record = { ...current, phase: 'recovery_required', revision: current.revision + 1 }
          recoveryRequiredCheckoutIds.push(checkoutId)
        }
        registry.managedCheckouts[checkoutId] = record
        registry.revision += 1
        changed = true
      } else if (
        current.phase === 'mutating'
        && current.journal?.operation === 'preview'
        && (
          current.journal.step === 'planning'
          || (current.journal.step === 'writing_local' && current.delivery.state === 'ready_for_review')
        )
      ) {
        // Preview receipt 尚未保留，apply patch 也尚未执行；可证明 Local 未被触碰。
        record = {
          ...current,
          phase: 'ready',
          journal: null,
          revision: current.revision + 1,
        }
        registry.managedCheckouts[checkoutId] = record
        registry.revision += 1
        changed = true
      } else if (
        current.phase === 'mutating'
        && (current.journal?.operation === 'finalize_preview' || current.journal?.operation === 'finish')
        && current.journal.step === 'planning'
      ) {
        // Finalize 的 branch/index 写入发生在 updating_ref 之后；planning 中断可安全重试。
        record = {
          ...current,
          phase: 'ready',
          journal: null,
          revision: current.revision + 1,
        }
        registry.managedCheckouts[checkoutId] = record
        registry.revision += 1
        changed = true
      } else if (
        current.phase === 'mutating'
        && (current.journal?.operation === 'preview' || current.journal?.operation === 'finish')
        && current.journal.step === 'artifacts_retained'
        && current.delivery.state === 'preview_active'
      ) {
        record = {
          ...current,
          phase: 'ready',
          journal: null,
          revision: current.revision + 1,
        }
        registry.managedCheckouts[checkoutId] = record
        registry.revision += 1
        changed = true
      } else if (current.phase === 'preparing' || current.phase === 'mutating') {
        record = {
          ...current,
          phase: 'recovery_required',
          revision: current.revision + 1,
        }
        registry.managedCheckouts[checkoutId] = record
        registry.revision += 1
        recoveryRequiredCheckoutIds.push(checkoutId)
        changed = true
      } else if (current.phase === 'recovery_required') {
        recoveryRequiredCheckoutIds.push(checkoutId)
      }

      if (dependencies.lookup.getSession(record.ownerSessionId)) continue
      orphanedCheckoutIds.push(checkoutId)
      let dirty = true
      if (dependencies.files.exists(record.managedRoot)) {
        try {
          dirty = (await dependencies.git.status(record.managedRoot)).dirty
        } catch {
          dirty = true
        }
      }
      if (dirty) dirtyOrphanedCheckoutIds.push(checkoutId)
    }

    if (changed) dependencies.registry.write(registry)
    // 启动路径只恢复 registry 状态。finalized 残余交给显式管理，到期 retained 交给定时维护，
    // 避免多个 30 秒清理超时在同一全局 binding lock 内串行阻塞 Session Target。
    const currentRegistry = dependencies.registry.read()
    return {
      recoveryRequiredCheckoutIds,
      orphanedCheckoutIds,
      dirtyOrphanedCheckoutIds,
      retainedCheckoutCount: Object.values(currentRegistry.managedCheckouts)
        .filter((record) => record.phase !== 'discarded')
        .length,
    }
  }

  function operationError(
    code: SessionCheckoutErrorCode,
    message: string,
    target?: SessionTargetView,
  ): SessionCheckoutOperationErrorResult {
    return { status: 'error', code, message, ...(target ? { target } : {}) }
  }

  function updateManagedCheckout(
    checkoutId: string,
    update: (record: ManagedCheckoutRecord) => ManagedCheckoutRecord,
  ): ManagedCheckoutRecord | undefined {
    const registry = dependencies.registry.read()
    const current = registry.managedCheckouts[checkoutId]
    if (!current) return undefined
    const next = update(current)
    registry.managedCheckouts[checkoutId] = next
    registry.revision += 1
    dependencies.registry.write(registry)
    return next
  }

  async function markReadyForReviewTarget(
    sessionId: string,
    input: MarkReadyForReviewInput,
  ): Promise<SessionTargetView> {
    const binding = await resolveBinding(sessionId)
    if (binding.ownerSessionId !== sessionId || binding.target.kind !== 'isolated') {
      throw new SessionCheckoutError('not_owner', '只有 owner Isolated 会话可以准备验收')
    }
    const summary = input.summary.trim()
    const suggestedCommitMessage = input.suggestedCommitMessage.trim()
    if (!summary || !suggestedCommitMessage || input.tests.length > 20) {
      throw new SessionCheckoutError('invalid_input', '验收摘要、提交信息或验证项目无效')
    }
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) throw new SessionCheckoutError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.phase !== 'ready' || record.delivery.state === 'preview_active' || record.delivery.state === 'preview_detached') {
      throw new SessionCheckoutError('operation_not_allowed', `当前 ${record.phase}/${record.delivery.state} 状态不能准备验收`)
    }
    const inspected = await inspectIsolated(binding)
    if (inspected.checkout.phase !== 'ready') {
      throw new SessionCheckoutError('recovery_required', 'Isolated Checkout 身份无法确认，需要恢复')
    }
    const snapshot = await dependencies.applyEngine.inspectReview({
      baseOid: record.applyBaseOid ?? record.baseOid,
      isolatedPath: record.managedRoot,
      localPath: record.localRoot,
    })
    if (snapshot.status === 'error') {
      throw new SessionCheckoutError(snapshot.error.code, snapshot.error.message)
    }
    if (snapshot.changedFiles.length === 0) {
      throw new SessionCheckoutError('operation_not_allowed', '当前 Worktree 没有可交付变更，无需生成验收卡')
    }
    const reviewId = dependencies.createCheckoutId()
    const iteration = record.delivery.state === 'working'
      ? record.delivery.iteration
      : record.delivery.state === 'delivered'
        ? record.delivery.iteration + 1
        : record.delivery.review.iteration
    const review = {
      reviewId,
      iteration,
      preparedAt: Date.now(),
      ...(input.detailsMarkdown?.trim() ? { detailsMarkdown: input.detailsMarkdown.trim() } : {}),
      summary,
      validationStatus: input.validationStatus,
      ...(input.validationSummary?.trim() ? { validationSummary: input.validationSummary.trim() } : {}),
      tests: input.tests.map((test) => ({
        command: test.command.trim(),
        status: test.status,
        ...(test.summary?.trim() ? { summary: test.summary.trim() } : {}),
      })),
      changedFiles: [...snapshot.changedFiles],
      suggestedCommitMessage,
      isolatedFingerprint: snapshot.isolatedFingerprint,
      isolatedHeadOid: snapshot.isolatedHeadOid,
      reviewBaseOid: snapshot.effectiveBaseOid,
      reviewBaseStrategy: snapshot.baseStrategy,
      reviewLocalHeadOid: snapshot.localHeadOid,
    }
    updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      previousReview: projectPreviousReview(review),
      delivery: { state: 'ready_for_review', review },
      revision: current.revision + 1,
    }))
    return inspectIsolated(binding)
  }

  async function operateCheckpoint(
    input: Extract<SessionCheckoutOperation, { action: 'checkpoint' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以保存阶段')
    }
    const commitMessage = input.commitMessage.trim()
    if (!commitMessage) return operationError('invalid_input', '阶段 Commit Message 不能为空')

    let record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    if (record.phase !== 'ready' || (record.delivery.state !== 'ready_for_review' && record.delivery.state !== 'preview_active')) {
      return operationError('operation_not_allowed', `当前 ${record.phase}/${record.delivery.state} 状态不能保存阶段`, await inspectIsolated(binding))
    }
    const collaborators = projectCollaborators(record)
    if (collaborators.length > 0) {
      return operationError('collaborator_active', collaboratorBlockMessage(collaborators), await inspectIsolated(binding))
    }

    if (record.delivery.state === 'preview_active') {
      const { preview, review } = record.delivery
      const rollbackOperationId = dependencies.createCheckoutId()
      updateManagedCheckout(record.checkoutId, (current) => ({
        ...current,
        phase: 'mutating',
        journal: {
          operation: 'rollback_preview',
          operationId: rollbackOperationId,
          step: 'planning',
          startedAt: Date.now(),
          previewId: preview.previewId,
          reviewId: review.reviewId,
          resumeRevision: false,
        },
        revision: current.revision + 1,
      }))
      const rollback = await dependencies.applyEngine.rollback({ localPath: record.localRoot, receipt: preview })
      if (rollback.status === 'error') {
        if (rollback.error.code === 'stale_local' || rollback.error.code === 'preview_modified') {
          return detachPreviewAfterLocalDrift(record, binding, rollback.error.code, 'rollback_preview')
        }
        updateManagedCheckout(record.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
        return operationError(rollback.error.code, rollback.error.message, await inspectIsolated(binding))
      }
      if (rollback.status === 'preview_committed') {
        const finalized = finalizeCommittedPreview(record, rollback.commitOid)
        if (!finalized) throw new SessionCheckoutError('stale_target', 'Preview 状态已变化，请刷新后重试')
        const cleanup = await cleanupFinalized(finalized)
        return {
          status: 'finished',
          target: await inspectIsolated(binding),
          changedFiles: rollback.changedFiles,
          commitOid: rollback.commitOid,
          cleanup: cleanup.cleaned ? 'discarded' : 'pending',
          ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
          ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),
        }
      }
      const restored = updateManagedCheckout(record.checkoutId, (current) => ({
        ...current,
        phase: 'ready',
        delivery: { state: 'ready_for_review', review },
        journal: null,
        revision: current.revision + 1,
      }))
      if (!restored) return operationError('checkout_missing', 'Preview 已撤回，但 Checkout 记录丢失')
      await releasePreviewArtifactsBestEffort(record, preview.previewId)
      record = restored
    }

    if (record.delivery.state !== 'ready_for_review') {
      return operationError('operation_not_allowed', '当前没有可保存的验收阶段', await inspectIsolated(binding))
    }
    const review = record.delivery.review
    const checkpointId = dependencies.createCheckoutId()
    const checkpointSequence = (record.checkpoints?.length ?? 0) + 1
    const operationId = dependencies.createCheckoutId()
    const startedAt = Date.now()
    const mutating = updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      journal: {
        operation: 'checkpoint',
        operationId,
        step: 'planning',
        startedAt,
        reviewId: review.reviewId,
        checkpointId,
        checkpointSequence,
        checkpointMessage: commitMessage,
        isolatedFingerprint: review.isolatedFingerprint,
        isolatedHeadOid: review.isolatedHeadOid,
      },
      revision: current.revision + 1,
    }))
    if (!mutating) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')

    const result = await dependencies.applyEngine.checkpoint({
      isolatedPath: mutating.managedRoot,
      expectedFingerprint: review.isolatedFingerprint,
      expectedHeadOid: review.isolatedHeadOid,
      commitMessage,
      beforeCommit: async (prepared) => {
        await dependencies.git.retainInternalArtifact(mutating.localRoot, mutating.checkoutId, `checkpoints/${checkpointId}`, prepared.commitOid)
        updateManagedCheckout(mutating.checkoutId, (current) => ({
          ...current,
          journal: current.journal?.operation === 'checkpoint'
            ? {
                ...current.journal,
                step: 'updating_ref',
                commitOid: prepared.commitOid,
                parentOid: prepared.parentOid,
                checkpointIndexTreeOid: prepared.indexTreeOid,
                changedFiles: [...prepared.changedFiles],
              }
            : current.journal,
          revision: current.revision + 1,
        }))
      },
    })
    if (result.status === 'error') {
      const current = dependencies.registry.read().managedCheckouts[mutating.checkoutId]
      const commitPrepared = current?.journal?.operation === 'checkpoint' && typeof current.journal.commitOid === 'string'
      if (!commitPrepared) {
        updateManagedCheckout(mutating.checkoutId, (checkout) => ({
          ...checkout,
          phase: 'ready',
          ...(result.error.code === 'stale_isolated' ? { previousReview: projectPreviousReview(review) } : {}),
          delivery: result.error.code === 'stale_isolated'
            ? { state: 'working', iteration: review.iteration }
            : { state: 'ready_for_review', review },
          journal: null,
          revision: checkout.revision + 1,
        }))
      } else {
        updateManagedCheckout(mutating.checkoutId, (checkout) => ({ ...checkout, phase: 'recovery_required', revision: checkout.revision + 1 }))
      }
      return operationError(result.error.code, result.error.message, await inspectIsolated(binding, false))
    }

    const checkpoint: ManagedWorktreeCheckpointRecord = {
      checkpointId,
      sequence: checkpointSequence,
      reviewId: review.reviewId,
      iteration: review.iteration,
      createdAt: Date.now(),
      commitOid: result.commitOid,
      parentOid: result.parentOid,
      summary: review.summary,
      commitMessage,
      validationStatus: review.validationStatus,
      changedFiles: [...result.changedFiles],
    }
    const completed = updateManagedCheckout(mutating.checkoutId, (current) => ({
      ...current,
      phase: 'ready',
      checkpoints: [...(current.checkpoints ?? []), checkpoint],
      delivery: {
        state: 'ready_for_review',
        review: {
          ...review,
          isolatedFingerprint: result.isolatedFingerprint,
          isolatedHeadOid: result.commitOid,
        },
      },
      journal: null,
      revision: current.revision + 1,
    }))
    if (!completed) return operationError('checkout_missing', 'Checkpoint 已创建，但 Checkout 记录丢失')
    return {
      status: 'checkpointed',
      target: await inspectIsolated(binding),
      checkpoint: projectCheckpoint(checkpoint),
      changedFiles: [...checkpoint.changedFiles],
    }
  }

  async function operateApply(
    input: Extract<SessionCheckoutOperation, { action: 'apply' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId) {
      return operationError('not_owner', '继承 Session Target 的会话不能执行 Apply')
    }
    if (binding.target.kind !== 'isolated') {
      return operationError('operation_not_allowed', 'Local Checkout 不支持 Apply')
    }

    let record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    if (record.phase !== 'ready' || record.delivery.state === 'preview_active' || record.delivery.state === 'preview_detached') {
      return operationError('operation_not_allowed', `当前 ${record.phase}/${record.delivery.state} 状态不能 Apply`, await inspectIsolated(binding))
    }
    const holder = findProjectAcceptanceHolder(record)
    if (holder) {
      return operationError(
        'project_acceptance_busy',
        `同一项目已有验收任务正在占用 Local：${holder.projectName}`,
        await inspectIsolated(binding),
      )
    }

    const inspected = await inspectIsolated(binding)
    if (inspected.checkout.phase !== 'ready') {
      return operationError('recovery_required', 'Isolated Checkout 身份无法确认，需要恢复', inspected)
    }
    record = dependencies.registry.read().managedCheckouts[record.checkoutId]
    if (!record || record.phase !== 'ready') {
      return operationError('recovery_required', 'Isolated Checkout 状态已变化，需要恢复')
    }

    const startedAt = Date.now()
    const operationId = dependencies.createCheckoutId()
    const previewId = dependencies.createCheckoutId()
    const applyBaseOid = record.applyBaseOid ?? record.baseOid
    const applying = updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      journal: { operation: 'preview', operationId, step: 'planning', startedAt, baseOid: applyBaseOid, previewId },
      revision: current.revision + 1,
    }))
    if (!applying) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')

    const planResult = await dependencies.applyEngine.plan({
      baseOid: applyBaseOid,
      isolatedPath: applying.managedRoot,
      localPath: applying.localRoot,
    })
    if (planResult.status === 'conflict') {
      updateManagedCheckout(applying.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      return {
        status: 'conflict',
        code: 'apply_conflict',
        reason: 'content_conflict',
        target: await inspectIsolated(binding),
        baseStrategy: planResult.baseStrategy,
        effectiveBaseOid: planResult.effectiveBaseOid,
        localHeadOid: planResult.localHeadOid,
        isolatedHeadOid: planResult.isolatedHeadOid,
        canRetryAfterRefresh: false,
        conflictingFiles: planResult.conflictingFiles,
      }
    }
    if (planResult.status === 'error') {
      updateManagedCheckout(applying.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      return operationError(planResult.error.code, planResult.error.message, await inspectIsolated(binding))
    }
    if (
      applying.delivery.state === 'ready_for_review'
      && planResult.plan.isolatedFingerprint !== applying.delivery.review.isolatedFingerprint
    ) {
      updateManagedCheckout(applying.checkoutId, (current) => ({
        ...current,
        phase: 'ready',
        ...(applying.delivery.state === 'ready_for_review' ? { previousReview: projectPreviousReview(applying.delivery.review) } : {}),
        delivery: { state: 'working', iteration: applying.delivery.state === 'ready_for_review' ? applying.delivery.review.iteration : 1 },
        journal: null,
        revision: current.revision + 1,
      }))
      return operationError('stale_isolated', 'Worktree 在标记可验收后又发生变化，请重新准备验收', await inspectIsolated(binding))
    }
    if (planResult.plan.changedFiles.length === 0) {
      updateManagedCheckout(applying.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      return { status: 'applied', target: await inspectIsolated(binding), changedFiles: [] }
    }

    const iteration = applying.delivery.state === 'working'
      ? applying.delivery.iteration
      : applying.delivery.state === 'delivered'
        ? applying.delivery.iteration + 1
        : applying.delivery.review.iteration
    const review = applying.delivery.state === 'ready_for_review'
      ? applying.delivery.review
      : {
          reviewId: operationId,
          iteration,
          preparedAt: startedAt,
          summary: 'Worktree 修改已通过 ApplyWorktree 同步到 Local 验收',
          validationStatus: 'not_run' as const,
          tests: [],
          changedFiles: [...planResult.plan.changedFiles],
          suggestedCommitMessage: 'chore: 提交 Worktree 修改',
          isolatedFingerprint: planResult.plan.isolatedFingerprint,
          isolatedHeadOid: planResult.plan.isolatedHeadOid,
        }

    updateManagedCheckout(applying.checkoutId, (current) => ({
      ...current,
      delivery: { state: 'ready_for_review', review },
      journal: {
        operation: 'preview',
        operationId,
        step: 'writing_local',
        startedAt,
        baseOid: applyBaseOid,
        previewId,
        reviewId: review.reviewId,
        planRevision: planResult.plan.revision,
        localFingerprint: planResult.plan.localFingerprint,
        isolatedFingerprint: planResult.plan.isolatedFingerprint,
        effectiveBaseOid: planResult.plan.effectiveBaseOid,
        baseStrategy: planResult.plan.baseStrategy,
        localHeadOid: planResult.plan.localHeadOid,
        isolatedHeadOid: planResult.plan.isolatedHeadOid,
        changedFiles: [...planResult.plan.changedFiles],
      },
      revision: current.revision + 1,
    }))

    const previewResult = await dependencies.applyEngine.preview(planResult.plan, {
      previewId,
      reviewId: review.reviewId,
      iteration: review.iteration,
      beforeWrite: async (receipt) => {
        await retainPreviewArtifacts(applying, receipt)
        updateManagedCheckout(applying.checkoutId, (current) => ({
          ...current,
          delivery: { state: 'preview_active', review, preview: receipt },
          journal: current.journal?.operation === 'preview'
            ? { ...current.journal, step: 'artifacts_retained' }
            : current.journal,
          revision: current.revision + 1,
        }))
      },
    })
    if (previewResult.status === 'error') {
      const current = dependencies.registry.read().managedCheckouts[applying.checkoutId]
      const definitelyUnchanged = previewResult.error.code === 'stale_local'
        || previewResult.error.code === 'stale_isolated'
        || previewResult.error.code === 'invalid_plan'
        || previewResult.error.code === 'invalid_input'
        || current?.journal?.step === 'writing_local'
      if (definitelyUnchanged || current?.journal?.step === 'artifacts_retained') {
        updateManagedCheckout(applying.checkoutId, (checkout) => ({ ...checkout, phase: 'ready', journal: null, revision: checkout.revision + 1 }))
      }
      return operationError(previewResult.error.code, previewResult.error.message, await inspectIsolated(binding))
    }

    updateManagedCheckout(applying.checkoutId, (current) => ({
      ...current,
      phase: 'ready',
      delivery: { state: 'preview_active', review, preview: previewResult.receipt },
      journal: null,
      revision: current.revision + 1,
    }))
    return { status: 'previewed', target: await inspectIsolated(binding), changedFiles: previewResult.changedFiles }
  }

  function holdsProjectAcceptanceSlot(record: ManagedCheckoutRecord): boolean {
    return record.delivery.state === 'preview_active'
      || record.journal?.operation === 'preview'
      || record.journal?.operation === 'rollback_preview'
      || record.journal?.operation === 'finalize_preview'
      || record.journal?.operation === 'finish'
  }

  function findProjectAcceptanceHolder(record: ManagedCheckoutRecord): ManagedCheckoutRecord | undefined {
    return Object.values(dependencies.registry.read().managedCheckouts).find((candidate) => (
      candidate.checkoutId !== record.checkoutId
      && candidate.phase !== 'discarded'
      && pathsEqual(candidate.localRoot, record.localRoot)
      && holdsProjectAcceptanceSlot(candidate)
    ))
  }

  async function retainPreviewArtifacts(record: ManagedCheckoutRecord, receipt: ManagedPreviewReceipt): Promise<void> {
    const prefix = `previews/${receipt.previewId}`
    await dependencies.git.retainInternalArtifact(record.localRoot, record.checkoutId, `${prefix}/local-working`, receipt.localWorkingTreeOid)
    await dependencies.git.retainInternalArtifact(record.localRoot, record.checkoutId, `${prefix}/local-index`, receipt.localIndexTreeOid)
    await dependencies.git.retainInternalArtifact(record.localRoot, record.checkoutId, `${prefix}/preview-working`, receipt.previewWorkingTreeOid)
    await dependencies.git.retainInternalArtifact(record.localRoot, record.checkoutId, `${prefix}/isolated-snapshot`, receipt.isolatedSnapshotOid)
  }

  async function releasePreviewArtifactsBestEffort(record: ManagedCheckoutRecord, previewId: string): Promise<void> {
    try {
      await dependencies.git.releaseInternalArtifacts(record.localRoot, record.checkoutId, `previews/${previewId}`)
    } catch {
      console.warn('[session-checkout] 清理 Preview refs 失败，已保守保留不可见引用')
    }
  }

  function blockedPreflight(
    record: ManagedCheckoutRecord | undefined,
    reason: WorktreeApplyPreflightBlockedReason,
    message: string,
  ): WorktreeApplyPreflightView {
    return {
      status: 'blocked',
      localModified: false,
      checkoutId: record?.checkoutId ?? '',
      reviewId: record?.delivery.state === 'ready_for_review' ? record.delivery.review.reviewId : null,
      revision: record?.revision ?? 0,
      reason,
      message,
    }
  }

  async function preflightTarget(sessionId: string, expectedRevision: number): Promise<WorktreeApplyPreflightView> {
    const binding = await resolveBinding(sessionId)
    if (binding.ownerSessionId !== sessionId || binding.target.kind !== 'isolated') {
      return blockedPreflight(undefined, 'not_owner', '只有 owner Isolated 会话可以执行同步预检')
    }
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return blockedPreflight(undefined, 'checkout_unavailable', 'Isolated Checkout 记录不存在')
    if (record.revision !== expectedRevision) {
      return blockedPreflight(record, 'stale_target', 'Session Target 已变化，请刷新后重新预检')
    }
    if (record.phase !== 'ready' || record.delivery.state !== 'ready_for_review') {
      return blockedPreflight(record, 'not_ready_for_review', '当前 Worktree 尚未处于可验收状态')
    }
    if (findProjectAcceptanceHolder(record)) {
      return blockedPreflight(record, 'project_acceptance_busy', '另一个任务正在占用该项目的 Local 验收槽位')
    }
    const validated = await validateManagedCheckoutDetailed(binding, record, false)
    if (validated.status !== 'valid') {
      return blockedPreflight(record, 'checkout_unavailable', 'Worktree 身份、路径或 Git 状态暂时无法确认')
    }
    const review = record.delivery.review
    const result = await dependencies.applyEngine.preflight({
      baseOid: record.applyBaseOid ?? record.baseOid,
      isolatedPath: validated.checkout.canonicalManagedRoot,
      localPath: record.localRoot,
    })
    const current = dependencies.registry.read().managedCheckouts[record.checkoutId]
    if (
      !current
      || current.revision !== expectedRevision
      || current.delivery.state !== 'ready_for_review'
      || current.delivery.review.reviewId !== review.reviewId
    ) return blockedPreflight(current, 'stale_target', 'Session Target 在预检期间发生变化，请刷新后重试')
    if (result.status === 'error') {
      return blockedPreflight(current, result.error.code === 'stale_isolated' ? 'stale_isolated' : 'git_error', result.error.message)
    }
    const isolatedFingerprint = result.status === 'ready'
      ? result.plan.isolatedFingerprint
      : result.isolatedFingerprint
    if (isolatedFingerprint !== review.isolatedFingerprint) {
      return blockedPreflight(current, 'stale_isolated', 'Worktree 在准备验收后发生变化，请重新生成验收结果')
    }
    const localBranch = result.status === 'ready' && result.plan.localHeadRef?.startsWith('refs/heads/')
      ? result.plan.localHeadRef.slice('refs/heads/'.length)
      : validated.checkout.snapshot.branch
    const common = {
      localModified: false as const,
      checkoutId: record.checkoutId,
      reviewId: review.reviewId,
      revision: expectedRevision,
      configuredBaseOid: record.baseOid,
      effectiveBaseOid: result.status === 'ready' ? result.plan.effectiveBaseOid : result.effectiveBaseOid,
      baseStrategy: result.status === 'ready' ? result.plan.baseStrategy : result.baseStrategy,
      localBranch,
      localHeadOid: result.status === 'ready' ? result.plan.localHeadOid : result.localHeadOid,
      isolatedHeadOid: result.status === 'ready' ? result.plan.isolatedHeadOid : result.isolatedHeadOid,
      changedFiles: result.status === 'ready' ? [...result.plan.changedFiles] : [...review.changedFiles],
    }
    if (result.status === 'conflict') {
      return { ...common, status: 'conflict', conflictingFiles: [...result.conflictingFiles] }
    }
    const status = result.plan.changedFiles.length === 0
      ? 'already_in_local' as const
      : result.plan.localHeadOid !== record.baseOid
        ? 'local_advanced' as const
        : 'ready' as const
    return { ...common, status }
  }

  async function operatePreview(
    input: Extract<SessionCheckoutOperation, { action: 'preview' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以同步验收')
    }
    let record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    if (record.phase !== 'ready' || record.delivery.state !== 'ready_for_review') {
      return operationError('operation_not_allowed', '当前 Worktree 尚未处于可验收状态', await inspectIsolated(binding))
    }
    const holder = findProjectAcceptanceHolder(record)
    if (holder) {
      return operationError(
        'project_acceptance_busy',
        `同一项目已有验收任务正在占用 Local：${holder.projectName}`,
        await inspectIsolated(binding),
      )
    }
    const inspected = await inspectIsolated(binding)
    if (inspected.checkout.phase !== 'ready') {
      return operationError('recovery_required', 'Isolated Checkout 身份无法确认，需要恢复', inspected)
    }
    record = dependencies.registry.read().managedCheckouts[record.checkoutId]
    if (!record || record.delivery.state !== 'ready_for_review') {
      return operationError('stale_target', '验收状态已变化，请刷新后重试')
    }
    const review = record.delivery.review
    const operationId = dependencies.createCheckoutId()
    const previewId = dependencies.createCheckoutId()
    const startedAt = Date.now()
    const applyBaseOid = record.applyBaseOid ?? record.baseOid
    const mutating = updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      journal: {
        operation: 'preview',
        operationId,
        step: 'planning',
        startedAt,
        baseOid: applyBaseOid,
        previewId,
        reviewId: review.reviewId,
      },
      revision: current.revision + 1,
    }))
    if (!mutating) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')

    const planResult = await dependencies.applyEngine.plan({
      baseOid: applyBaseOid,
      isolatedPath: mutating.managedRoot,
      localPath: mutating.localRoot,
    })
    if (planResult.status === 'conflict') {
      updateManagedCheckout(mutating.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      return {
        status: 'conflict',
        code: 'apply_conflict',
        reason: 'content_conflict',
        target: await inspectIsolated(binding),
        baseStrategy: planResult.baseStrategy,
        effectiveBaseOid: planResult.effectiveBaseOid,
        localHeadOid: planResult.localHeadOid,
        isolatedHeadOid: planResult.isolatedHeadOid,
        canRetryAfterRefresh: false,
        conflictingFiles: planResult.conflictingFiles,
      }
    }
    if (planResult.status === 'error') {
      updateManagedCheckout(mutating.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      return operationError(planResult.error.code, planResult.error.message, await inspectIsolated(binding))
    }
    if (planResult.plan.isolatedFingerprint !== review.isolatedFingerprint) {
      updateManagedCheckout(mutating.checkoutId, (current) => ({
        ...current,
        phase: 'ready',
        previousReview: projectPreviousReview(review),
        delivery: { state: 'working', iteration: review.iteration },
        journal: null,
        revision: current.revision + 1,
      }))
      return operationError('stale_isolated', 'Worktree 在标记可验收后又发生变化，请重新准备验收', await inspectIsolated(binding))
    }
    updateManagedCheckout(mutating.checkoutId, (current) => ({
      ...current,
      journal: {
        operation: 'preview',
        operationId,
        step: 'writing_local',
        startedAt,
        baseOid: applyBaseOid,
        previewId,
        reviewId: review.reviewId,
        planRevision: planResult.plan.revision,
        localFingerprint: planResult.plan.localFingerprint,
        isolatedFingerprint: planResult.plan.isolatedFingerprint,
        effectiveBaseOid: planResult.plan.effectiveBaseOid,
        baseStrategy: planResult.plan.baseStrategy,
        localHeadOid: planResult.plan.localHeadOid,
        isolatedHeadOid: planResult.plan.isolatedHeadOid,
        changedFiles: [...planResult.plan.changedFiles],
      },
      revision: current.revision + 1,
    }))
    const previewResult = await dependencies.applyEngine.preview(planResult.plan, {
      previewId,
      reviewId: review.reviewId,
      iteration: review.iteration,
      beforeWrite: async (receipt) => {
        await retainPreviewArtifacts(mutating, receipt)
        updateManagedCheckout(mutating.checkoutId, (current) => ({
          ...current,
          delivery: { state: 'preview_active', review, preview: receipt },
          journal: current.journal?.operation === 'preview'
            ? { ...current.journal, step: 'artifacts_retained' }
            : current.journal,
          revision: current.revision + 1,
        }))
      },
    })
    if (previewResult.status === 'error') {
      const current = dependencies.registry.read().managedCheckouts[mutating.checkoutId]
      const definitelyUnchanged = previewResult.error.code === 'stale_local'
        || previewResult.error.code === 'stale_isolated'
        || previewResult.error.code === 'invalid_plan'
        || previewResult.error.code === 'invalid_input'
        || current?.journal?.step === 'writing_local'
      if (definitelyUnchanged || current?.journal?.step === 'artifacts_retained') {
        updateManagedCheckout(mutating.checkoutId, (checkout) => ({ ...checkout, phase: 'ready', journal: null, revision: checkout.revision + 1 }))
      }
      return operationError(previewResult.error.code, previewResult.error.message, await inspectIsolated(binding))
    }
    const receipt: ManagedPreviewReceipt = previewResult.receipt
    updateManagedCheckout(mutating.checkoutId, (current) => ({
      ...current,
      phase: 'ready',
      delivery: { state: 'preview_active', review, preview: receipt },
      journal: null,
      revision: current.revision + 1,
    }))
    return { status: 'previewed', target: await inspectIsolated(binding), changedFiles: previewResult.changedFiles }
  }

  async function detachPreviewAfterLocalDrift(
    record: ManagedCheckoutRecord,
    binding: SessionBindingRecord,
    reason: 'stale_local' | 'preview_modified',
    attemptedAction: 'rollback_preview' | 'finalize_preview' | 'discard',
  ): Promise<SessionCheckoutOperationResult> {
    if (record.delivery.state !== 'preview_active') {
      return operationError('preview_not_active', '当前没有可解除的 Local Preview', await inspectIsolated(binding))
    }
    const { review, preview } = record.delivery
    const detached = updateManagedCheckout(record.checkoutId, (current) => {
      if (current.delivery.state !== 'preview_active') return current
      return {
        ...current,
        phase: 'ready',
        delivery: {
          state: 'preview_detached',
          review: current.delivery.review,
          preview: current.delivery.preview,
          detachedAt: Date.now(),
          reason,
          attemptedAction,
        },
        journal: null,
        revision: current.revision + 1,
      }
    })
    if (!detached || detached.delivery.state !== 'preview_detached') {
      return operationError('stale_target', 'Preview 状态已变化，请刷新后重试', await inspectIsolated(binding))
    }
    return {
      status: 'preview_detached',
      target: await inspectIsolated(binding),
      changedFiles: [...preview.changedFiles],
      reason,
      attemptedAction,
    }
  }

  function finalizeCommittedPreview(record: ManagedCheckoutRecord, commitOid: string): ManagedCheckoutRecord | undefined {
    if (record.delivery.state !== 'preview_active' && record.delivery.state !== 'preview_detached') return undefined
    const { preview, review } = record.delivery
    return updateManagedCheckout(record.checkoutId, (current) => {
      if (current.delivery.state !== 'preview_active' && current.delivery.state !== 'preview_detached') return current
      return {
        ...current,
        phase: 'finalized',
        delivery: {
          state: 'finalized' as const,
          review,
          commitOid,
          proof: {
            localBranch: preview.localHeadRef?.startsWith('refs/heads/')
              ? preview.localHeadRef.slice('refs/heads/'.length)
              : null,
            localHeadBefore: preview.localHeadOid,
            localHeadAfter: commitOid,
            changedFiles: [...preview.changedFiles],
          },
          isolatedFingerprint: preview.isolatedFingerprint,
          finalizedAt: Date.now(),
          cleanup: 'pending' as const,
        },
        journal: null,
        revision: current.revision + 1,
      }
    })
  }

  async function operateRollbackPreview(
    input: Extract<SessionCheckoutOperation, { action: 'rollback_preview' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以撤回验收')
    }
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    const retryingRecovery = record.phase === 'recovery_required'
      && record.delivery.state === 'preview_active'
      && record.journal?.operation === 'rollback_preview'
    if (
      (record.phase !== 'ready' && !retryingRecovery)
      || (record.delivery.state !== 'preview_active' && record.delivery.state !== 'preview_detached')
    ) {
      return operationError('preview_not_active', '当前没有可撤回的 Local Preview', await inspectIsolated(binding))
    }
    const retryingDetached = record.delivery.state === 'preview_detached'
    const resumeRevision = input.resumeRevision ?? (
      retryingRecovery && record.journal?.operation === 'rollback_preview'
        ? record.journal.resumeRevision ?? false
        : false
    )
    const { preview, review } = record.delivery
    const operationId = dependencies.createCheckoutId()
    const startedAt = Date.now()
    updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      journal: {
        operation: 'rollback_preview',
        operationId,
        step: 'planning',
        startedAt,
        previewId: preview.previewId,
        reviewId: review.reviewId,
        resumeRevision,
      },
      revision: current.revision + 1,
    }))
    const result = await dependencies.applyEngine.rollback({ localPath: record.localRoot, receipt: preview })
    if (result.status === 'error') {
      if (result.error.code === 'stale_local' || result.error.code === 'preview_modified') {
        if (!retryingDetached) {
          return detachPreviewAfterLocalDrift(record, binding, result.error.code, 'rollback_preview')
        }
        updateManagedCheckout(record.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      } else if (result.error.code === 'invalid_input') {
        updateManagedCheckout(record.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      }
      return operationError(result.error.code, result.error.message, await inspectIsolated(binding))
    }
    if (result.status === 'preview_committed') {
      const finalized = finalizeCommittedPreview(record, result.commitOid)
      if (!finalized) return operationError('stale_target', 'Preview 状态已变化，请刷新后重试', await inspectIsolated(binding))
      const cleanup = await cleanupFinalized(finalized)
      return {
        status: 'finished',
        target: await inspectIsolated(binding),
        changedFiles: result.changedFiles,
        commitOid: result.commitOid,
        cleanup: cleanup.cleaned ? 'discarded' : 'pending',
        ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
        ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),
      }
    }
    updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'ready',
      ...(resumeRevision ? { previousReview: projectPreviousReview(review) } : {}),
      delivery: resumeRevision
        ? { state: 'working', iteration: review.iteration }
        : { state: 'ready_for_review', review },
      journal: null,
      revision: current.revision + 1,
    }))
    await releasePreviewArtifactsBestEffort(record, preview.previewId)
    return { status: 'preview_rolled_back', target: await inspectIsolated(binding), changedFiles: result.changedFiles }
  }

  function retainFinalized(
    record: ManagedCheckoutRecord,
    retention: Exclude<WorktreeRetentionMode, 'cleanup'>,
  ): ManagedCheckoutRecord | undefined {
    if (record.delivery.state !== 'finalized') return undefined
    const retainedAt = Date.now()
    return updateManagedCheckout(record.checkoutId, (current) => {
      if (current.delivery.state !== 'finalized') return current
      return {
        ...current,
        phase: 'retained',
        delivery: {
          state: 'retained',
          review: current.delivery.review,
          commitOid: current.delivery.commitOid,
          ...(current.delivery.proof ? { proof: current.delivery.proof } : {}),
          isolatedFingerprint: current.delivery.isolatedFingerprint,
          retention,
          retainedAt,
          expiresAt: retentionExpiresAt(retention, retainedAt),
          cleanup: 'scheduled',
        },
        journal: null,
        revision: current.revision + 1,
      }
    })
  }

  async function cleanupFinalized(
    record: ManagedCheckoutRecord,
    options: { allowLegacyResidue?: boolean } = {},
  ): Promise<{ cleaned: boolean; message?: string; reason?: WorktreeCleanupReason }> {
    const block = (message: string, reason = cleanupReasonForMessage(message)): { cleaned: false; message: string; reason: WorktreeCleanupReason } => {
      updateManagedCheckout(record.checkoutId, (current) => {
        const journal = current.journal?.operation === 'cleanup' ? current.journal : null
        if (current.delivery.state === 'finalized') {
          return {
            ...current,
            phase: 'finalized',
            delivery: { ...current.delivery, cleanup: 'blocked', cleanupMessage: message },
            journal,
            revision: current.revision + 1,
          }
        }
        if (current.delivery.state === 'retained') {
          return {
            ...current,
            phase: 'retained',
            delivery: { ...current.delivery, cleanup: 'blocked', cleanupMessage: message },
            journal,
            revision: current.revision + 1,
          }
        }
        return current
      })
      return { cleaned: false, message, reason }
    }
    if (record.delivery.state !== 'finalized' && record.delivery.state !== 'retained') {
      return block('Worktree 交付状态不完整，未执行清理。')
    }
    if (
      (record.delivery.state === 'finalized' || record.delivery.state === 'retained')
      && record.delivery.cleanup === 'blocked'
      && record.delivery.cleanupMessage?.includes('Local index')
    ) {
      return block(record.delivery.cleanupMessage)
    }
    if (hasLegacyCleanupResidueEvidence(record) && !options.allowLegacyResidue && dependencies.files.exists(record.managedGitRoot)) {
      return { cleaned: false, message: CLEANUP_RESIDUE_MESSAGE, reason: 'detached_residue' }
    }
    const registry = dependencies.registry.read()
    const persistedBinding = registry.sessionBindings[record.ownerSessionId]
    const binding: SessionBindingRecord = persistedBinding?.target.kind === 'isolated'
      && persistedBinding.target.checkoutId === record.checkoutId
      ? persistedBinding
      : bindingForManagedRecord(record)
    const collaborators = Object.values(registry.sessionBindings).filter((candidate) => (
      candidate.sessionId !== record.ownerSessionId
      && candidate.target.kind === 'isolated'
      && candidate.target.checkoutId === record.checkoutId
    ))
    if (collaborators.length > 0) return block('Worktree 仍被协作会话使用，未执行清理。')

    const beginRemoval = (
      currentRecord: ManagedCheckoutRecord,
      managedDirectoryIdentity: DirectoryIdentity,
    ): ManagedCheckoutRecord | undefined => {
      if (hasCleanupRemovalReceipt(currentRecord)) return currentRecord
      return updateManagedCheckout(currentRecord.checkoutId, (current) => ({
        ...current,
        journal: {
          operation: 'cleanup',
          operationId: dependencies.createCheckoutId(),
          step: 'removing_worktree',
          startedAt: Date.now(),
          commitOid: current.delivery.state === 'finalized' || current.delivery.state === 'retained'
            ? current.delivery.commitOid ?? undefined
            : undefined,
          isolatedFingerprint: current.delivery.state === 'finalized' || current.delivery.state === 'retained'
            ? current.delivery.isolatedFingerprint
            : undefined,
          managedDirectoryIdentity,
        },
        revision: current.revision + 1,
      }))
    }

    const quarantineAndRemove = async (
      currentRecord: ManagedCheckoutRecord,
      residue: ValidatedCleanupResidue,
    ): Promise<void> => {
      const journal = currentRecord.journal?.operation === 'cleanup' ? currentRecord.journal : undefined
      if (!journal?.managedDirectoryIdentity) throw new SessionCheckoutError('checkout_mismatch', 'Worktree cleanup receipt 不完整')
      const quarantinePath = journal.cleanupQuarantinePath ?? join(
        dirname(currentRecord.managedGitRoot),
        `.domi-cleanup--${currentRecord.checkoutId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}--${journal.operationId}`,
      )
      const quarantining = journal.cleanupQuarantinePath
        ? currentRecord
        : updateManagedCheckout(currentRecord.checkoutId, (current) => ({
            ...current,
            journal: current.journal?.operation === 'cleanup'
              ? { ...current.journal, cleanupQuarantinePath: quarantinePath }
              : current.journal,
            revision: current.revision + 1,
          }))
      if (!quarantining) throw new SessionCheckoutError('checkout_missing', 'Worktree 记录在 quarantine 前丢失')
      if (!dependencies.files.exists(quarantinePath)) {
        await retryTransientCleanup(() => dependencies.files.quarantineDirectoryTree(
          residue.canonicalManagedGitRoot,
          residue.directoryIdentity,
          quarantinePath,
        ))
      }
      const validatedQuarantine = await validateCleanupQuarantine(quarantining)
      if (!validatedQuarantine) throw new SessionCheckoutError('checkout_mismatch', 'Worktree quarantine 身份无法验证')
      await retryTransientCleanup(() => dependencies.files.removeDirectoryTree(validatedQuarantine))
    }

    try {
      const existingQuarantine = await validateCleanupQuarantine(record)
      if (existingQuarantine) {
        await retryTransientCleanup(() => dependencies.files.removeDirectoryTree(existingQuarantine))
      } else if (record.journal?.operation === 'cleanup' && record.journal.cleanupQuarantinePath && dependencies.files.exists(record.journal.cleanupQuarantinePath)) {
        return block(CLEANUP_IDENTITY_CHANGED_MESSAGE)
      } else if (dependencies.files.exists(record.managedGitRoot)) {
        const validated = dependencies.files.exists(record.managedRoot)
          ? await validateManagedCheckout(binding, record, false)
          : undefined
        if (validated) {
          const snapshot = await dependencies.applyEngine.inspectReview({
            baseOid: record.applyBaseOid ?? record.baseOid,
            isolatedPath: record.managedRoot,
            localPath: record.localRoot,
          })
          if (snapshot.status !== 'ready' || snapshot.isolatedFingerprint !== record.delivery.isolatedFingerprint) {
            return block('Worktree 在提交后出现了新修改，未执行清理。')
          }
          const directoryIdentity = await dependencies.files.inspectDirectoryIdentity(validated.canonicalManagedGitRoot)
          if (!directoryIdentity) return block(CLEANUP_IDENTITY_CHANGED_MESSAGE)
          const removing = beginRemoval(record, directoryIdentity)
          if (!removing) return block('Worktree 记录在清理前丢失，未执行清理。')
          await retryTransientCleanup(() => dependencies.git.removeWorktree(removing.localRoot, removing.managedGitRoot))
          if (dependencies.files.exists(removing.managedGitRoot)) {
            const residue = await validateDetachedCleanupResidue(removing)
            if (!residue) return block(CLEANUP_IDENTITY_CHANGED_MESSAGE)
            await quarantineAndRemove(removing, residue)
          }
        } else {
          const residue = await validateDetachedCleanupResidue(record, options.allowLegacyResidue === true)
          if (!residue) return block(CLEANUP_IDENTITY_CHANGED_MESSAGE)
          const removing = beginRemoval(record, residue.directoryIdentity)
          if (!removing) return block('Worktree 记录在清理前丢失，未执行清理。')
          const revalidatedResidue = await validateDetachedCleanupResidue(removing)
          if (!revalidatedResidue) return block(CLEANUP_IDENTITY_CHANGED_MESSAGE)
          await quarantineAndRemove(removing, revalidatedResidue)
        }
      }
      await releaseApplyBaseBestEffort(record)
      updateManagedCheckout(record.checkoutId, (current) => {
        if (current.delivery.state !== 'finalized' && current.delivery.state !== 'retained') return current
        return {
          ...current,
          phase: 'discarded',
          delivery: {
            state: 'delivered',
            iteration: current.delivery.review.iteration,
            commitOid: current.delivery.commitOid,
            ...(current.delivery.proof ? { proof: current.delivery.proof } : {}),
            deliveredAt: Date.now(),
          },
          journal: null,
          revision: current.revision + 1,
        }
      })
      return { cleaned: true }
    } catch (error) {
      console.warn('[session-checkout] finalized Worktree cleanup failed:', error)
      const failureRecord = dependencies.registry.read().managedCheckouts[record.checkoutId] ?? record
      const quarantineBusy = failureRecord.journal?.operation === 'cleanup' && Boolean(failureRecord.journal.cleanupQuarantinePath)
      const reason: WorktreeCleanupReason = quarantineBusy ? 'quarantine_busy' : 'directory_busy'
      const message = quarantineBusy
        ? 'Worktree 已安全移入 Domi quarantine，但目录仍被进程占用；Domi 会在同一清理授权内有限重试。'
        : 'Worktree 目录仍被进程占用或 Windows 暂时拒绝删除；Domi 已完成有限重试，可稍后重试清理。'
      updateManagedCheckout(record.checkoutId, (current) => {
        const journal = current.journal?.operation === 'cleanup' ? current.journal : null
        if (current.delivery.state === 'finalized') {
          return { ...current, phase: 'finalized', delivery: { ...current.delivery, cleanup: 'pending', cleanupMessage: message }, journal, revision: current.revision + 1 }
        }
        if (current.delivery.state === 'retained') {
          return { ...current, phase: 'retained', delivery: { ...current.delivery, cleanup: 'blocked', cleanupMessage: message }, journal, revision: current.revision + 1 }
        }
        return current
      })
      return { cleaned: false, message, reason }
    }
  }

  async function cloneIsolatedTarget(
    sourceSessionId: string,
    childSessionId: string,
    expectedSourceRevision: number,
  ): Promise<SessionTargetView> {
    requireSession(childSessionId)
    if (getPersistedBinding(childSessionId)) {
      throw new SessionCheckoutError('target_already_bound', 'Fork 子会话已经绑定 Session Target')
    }
    if (dependencies.lookup.isSessionActive(sourceSessionId)) {
      throw new SessionCheckoutError('collaborator_active', '源会话仍在运行，请停止后再复制当前 Worktree')
    }
    const sourceBinding = await resolveBinding(sourceSessionId)
    if (sourceBinding.target.kind !== 'isolated') {
      throw new SessionCheckoutError('operation_not_allowed', '只有 Isolated 会话可以复制当前 Worktree')
    }
    const registry = dependencies.registry.read()
    const sourceRecord = registry.managedCheckouts[sourceBinding.target.checkoutId]
    if (!sourceRecord) {
      throw new SessionCheckoutError('checkout_missing', '源 Isolated Checkout 记录不存在')
    }
    if (sourceRecord.revision !== expectedSourceRevision) {
      throw new SessionCheckoutError('stale_target', '源 Worktree 状态已变化，请重新发起 Fork')
    }
    if (sourceRecord.phase !== 'ready') {
      throw new SessionCheckoutError('recovery_required', '源 Worktree 当前不处于可复制状态')
    }
    const activeCollaborator = projectCollaborators(sourceRecord).find((collaborator) => (
      collaborator.sessionId !== sourceSessionId
      && (collaborator.status === 'running' || dependencies.lookup.isSessionActive(collaborator.sessionId))
    ))
    if (activeCollaborator) {
      throw new SessionCheckoutError(
        'collaborator_active',
        `${activeCollaborator.title}仍在使用源 Worktree，请先停止后再 Fork`,
      )
    }
    if (
      sourceRecord.delivery.state === 'preview_active'
      || sourceRecord.delivery.state === 'preview_detached'
      || sourceRecord.delivery.state === 'finalized'
      || sourceRecord.delivery.state === 'retained'
      || sourceRecord.delivery.state === 'delivered'
    ) {
      throw new SessionCheckoutError('operation_not_allowed', '源 Worktree 当前交付状态不能复制')
    }
    const validated = await validateManagedCheckout(sourceBinding, sourceRecord, true)
    if (!validated) {
      throw new SessionCheckoutError('recovery_required', '源 Worktree 身份无法确认')
    }
    if (!dependencies.applyEngine.captureHandoffSnapshot) {
      throw new SessionCheckoutError('operation_not_allowed', '当前 Apply engine 不支持复制 Fork snapshot')
    }
    const captured = await dependencies.applyEngine.captureHandoffSnapshot({
      isolatedPath: sourceRecord.managedRoot,
      baseOid: sourceRecord.applyBaseOid ?? sourceRecord.baseOid,
    })
    if (captured.status === 'error') {
      throw new SessionCheckoutError(
        captured.error.code as SessionCheckoutErrorCode,
        captured.error.message,
      )
    }
    const local = await dependencies.git.inspect(sourceRecord.localRoot)
    if (!local) throw new SessionCheckoutError('not_git_repository', '源 Worktree 的 Local Checkout 不可用')
    const artifactPrefix = `forks/${createHash('sha256')
      .update([sourceSessionId, childSessionId, captured.isolatedFingerprint].join('\0'))
      .digest('hex')
      .slice(0, 24)}`
    try {
      await dependencies.git.retainInternalArtifact(
        sourceRecord.localRoot,
        sourceRecord.checkoutId,
        `${artifactPrefix}/index`,
        captured.indexTreeOid,
      )
      await dependencies.git.retainInternalArtifact(
        sourceRecord.localRoot,
        sourceRecord.checkoutId,
        `${artifactPrefix}/working`,
        captured.treeOid,
      )
      return await bindTarget(childSessionId, { kind: 'isolated' }, {
        expectedCurrentOid: local.headOid,
        dirtyConfirmed: true,
        seedSnapshot: {
          headOid: captured.isolatedHeadOid,
          indexTreeOid: captured.indexTreeOid,
          treeOid: captured.treeOid,
          fingerprint: captured.isolatedFingerprint,
          baseOid: sourceRecord.baseOid,
          ...(sourceRecord.applyBaseOid ? { applyBaseOid: sourceRecord.applyBaseOid } : {}),
          sourceRef: sourceRecord.sourceRef,
        },
      }, 0, Date.now())
    } finally {
      await dependencies.git.releaseInternalArtifacts(
        sourceRecord.localRoot,
        sourceRecord.checkoutId,
        artifactPrefix,
      )
    }
  }

  async function captureSessionHandoff(
    sessionId: string,
    expectedRevision: number,
  ): Promise<import('./index.ts').SessionHandoffSnapshot> {
    const binding = await resolveBinding(sessionId)
    if (binding.target.kind === 'unselected') {
      throw new SessionCheckoutError('target_unselected', '当前会话尚未选择 Session Target')
    }
    if (binding.target.kind === 'local' && binding.revision !== expectedRevision) {
      throw new SessionCheckoutError('stale_target', 'Session Target 已变化，请刷新后重试')
    }
    const sessionProject = binding.target.kind === 'local' ? await resolveSessionProject(sessionId) : undefined
    if (sessionProject && sessionProject.project.id !== binding.projectId) {
      throw new SessionCheckoutError('stale_target', '来源会话的项目与 Session Target 已不一致，请刷新后重试')
    }
    const localRoot = sessionProject?.project.root
      ?? dependencies.registry.read().managedCheckouts[binding.target.kind === 'isolated' ? binding.target.checkoutId : '']?.localRoot
      ?? ''
    const local = await dependencies.git.inspect(localRoot)
    const session = dependencies.lookup.getSession(sessionId)
    if (binding.target.kind === 'local') {
      const localDirty = local ? (await dependencies.git.status(local.root)).dirty : false
      return {
        originSessionId: sessionId,
        originTargetOwnerSessionId: binding.ownerSessionId,
        originTargetKind: 'local',
        originCheckoutId: `local:${binding.projectId}`,
        originRevision: binding.revision,
        projectId: binding.projectId,
        projectName: binding.projectName,
        localHeadOid: local?.headOid ?? binding.sourceOid,
        localHeadRef: local?.branch ? `refs/heads/${local.branch}` : null,
        localDirty,
        changedFiles: [],
        summary: session?.title ?? '继续当前 Agent 会话',
        validationStatus: 'not_run',
        tests: [],
      }
    }

    if (!local) throw new SessionCheckoutError('not_git_repository', 'Local Checkout 当前不可用')
    const localStatus = await dependencies.git.status(local.root)
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) throw new SessionCheckoutError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (
      record.ownerSessionId !== binding.ownerSessionId
      || record.checkoutId !== binding.target.checkoutId
      || record.projectId !== binding.projectId
    ) {
      throw new SessionCheckoutError('stale_target', '继承会话的 Session Target 身份已变化，请刷新后重试')
    }
    if (record.revision !== expectedRevision) {
      throw new SessionCheckoutError('stale_target', 'Session Target 已变化，请刷新后重试')
    }
    if (record.phase !== 'ready' && record.phase !== 'recovery_required') {
      throw new SessionCheckoutError('operation_not_allowed', '当前 Worktree 状态不能安全交接')
    }
    const delivery = record.delivery
    const review = delivery.state === 'ready_for_review'
      || delivery.state === 'preview_active'
      || delivery.state === 'preview_detached'
      ? delivery.review
      : undefined
    const preview = delivery.state === 'preview_active' || delivery.state === 'preview_detached'
      ? delivery.preview
      : undefined
    let isolatedSnapshotOid = preview?.isolatedSnapshotOid
    let isolatedHeadOid = preview?.isolatedHeadOid
    let changedFiles = preview ? [...preview.changedFiles] : review ? [...review.changedFiles] : []
    if (!isolatedSnapshotOid) {
      if (!dependencies.applyEngine.captureHandoffSnapshot) {
        throw new SessionCheckoutError('operation_not_allowed', '当前 Apply engine 不支持稳定 Session handoff snapshot')
      }
      const captured = await dependencies.applyEngine.captureHandoffSnapshot({
        isolatedPath: record.managedRoot,
        baseOid: record.applyBaseOid ?? record.baseOid,
      })
      if (captured.status === 'error') {
        throw new SessionCheckoutError(captured.error.code as import('@domi/shared').SessionCheckoutErrorCode, captured.error.message)
      }
      isolatedSnapshotOid = captured.treeOid
      isolatedHeadOid = captured.isolatedHeadOid
      changedFiles = [...captured.changedFiles]
      const artifactId = createHash('sha256')
        .update([sessionId, String(record.revision), local.headOid, captured.treeOid].join('\0'))
        .digest('hex')
        .slice(0, 24)
      await dependencies.git.retainInternalArtifact(record.localRoot, record.checkoutId, `handoffs/${artifactId}/isolated-snapshot`, captured.treeOid)
    }
    return {
      originSessionId: sessionId,
      originTargetOwnerSessionId: record.ownerSessionId,
      originTargetKind: 'isolated',
      originCheckoutId: record.checkoutId,
      originRevision: record.revision,
      projectId: record.projectId,
      projectName: record.projectName,
      localHeadOid: local.headOid,
      localHeadRef: local.branch ? `refs/heads/${local.branch}` : null,
      localDirty: localStatus.dirty,
      changedFiles,
      summary: review?.summary ?? session?.title ?? '继续当前 Worktree 会话',
      ...(review?.detailsMarkdown ? { detailsMarkdown: review.detailsMarkdown } : {}),
      validationStatus: review?.validationStatus ?? 'not_run',
      ...(review?.validationSummary ? { validationSummary: review.validationSummary } : {}),
      tests: review?.tests.map((test) => ({ ...test })) ?? [],
      iteration: review?.iteration ?? (delivery.state === 'working' || delivery.state === 'delivered' ? delivery.iteration : undefined),
      ...(review ? { reviewId: review.reviewId } : {}),
      ...(preview ? { previewId: preview.previewId } : {}),
      ...(delivery.state === 'preview_detached' ? {
        detachedReason: delivery.reason,
        attemptedAction: delivery.attemptedAction,
      } : {}),
      configuredBaseOid: preview?.configuredBaseOid ?? record.baseOid,
      effectiveBaseOid: preview?.effectiveBaseOid ?? record.applyBaseOid ?? record.baseOid,
      isolatedHeadOid,
      isolatedSnapshotOid,
      ...(preview ? { previewWorkingTreeOid: preview.previewWorkingTreeOid } : {}),
    }
  }

  async function captureRecoveryHandoff(
    sessionId: string,
    expectedRevision: number,
  ): Promise<import('./index.ts').WorktreeRecoveryHandoffSnapshot> {
    const binding = await resolveBinding(sessionId)
    if (binding.ownerSessionId !== sessionId || binding.target.kind !== 'isolated') {
      throw new SessionCheckoutError('not_owner', '只有 owner Isolated 会话可以发起 Preview recovery handoff')
    }
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) throw new SessionCheckoutError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== expectedRevision) {
      throw new SessionCheckoutError('stale_target', 'Session Target 已变化，请刷新后重试')
    }
    if (record.phase !== 'ready' || record.delivery.state !== 'preview_detached') {
      throw new SessionCheckoutError('operation_not_allowed', '只有无法自动收口的 detached Preview 可以交接到新 Worktree')
    }
    const local = await dependencies.git.inspect(record.localRoot)
    if (!local) throw new SessionCheckoutError('not_git_repository', 'Local Checkout 当前不可用')
    if (local.headRef !== record.delivery.preview.localHeadRef && local.headRef !== null) {
      throw new SessionCheckoutError('stale_local', 'Local 已切换分支，不能猜测 recovery handoff 的目标分支')
    }
    const localStatus = await dependencies.git.status(record.localRoot)
    const { preview, review } = record.delivery
    return {
      originSessionId: sessionId,
      originTargetOwnerSessionId: record.ownerSessionId,
      originTargetKind: 'isolated',
      originCheckoutId: record.checkoutId,
      originRevision: record.revision,
      projectId: record.projectId,
      projectName: record.projectName,
      iteration: review.iteration,
      reviewId: review.reviewId,
      previewId: preview.previewId,
      detachedReason: record.delivery.reason,
      attemptedAction: record.delivery.attemptedAction,
      localHeadOid: local.headOid,
      localHeadRef: local.branch ? `refs/heads/${local.branch}` : null,
      localDirty: localStatus.dirty,
      configuredBaseOid: preview.configuredBaseOid,
      effectiveBaseOid: preview.effectiveBaseOid,
      isolatedHeadOid: preview.isolatedHeadOid,
      isolatedSnapshotOid: preview.isolatedSnapshotOid,
      previewWorkingTreeOid: preview.previewWorkingTreeOid,
      changedFiles: [...preview.changedFiles],
      summary: review.summary,
      ...(review.detailsMarkdown ? { detailsMarkdown: review.detailsMarkdown } : {}),
      validationStatus: review.validationStatus,
      ...(review.validationSummary ? { validationSummary: review.validationSummary } : {}),
      tests: review.tests.map((test) => ({ ...test })),
    }
  }

  async function operateFinalizePreview(
    input: Extract<SessionCheckoutOperation, { action: 'finalize_preview' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以完成验收提交')
    }
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    if (
      record.phase !== 'ready'
      || (record.delivery.state !== 'preview_active' && record.delivery.state !== 'preview_detached')
    ) {
      return operationError('preview_not_active', '当前没有可提交的 Local Preview', await inspectIsolated(binding))
    }
    const collaborators = projectCollaborators(record)
    if (collaborators.length > 0) {
      return operationError('collaborator_active', collaboratorBlockMessage(collaborators), await inspectIsolated(binding))
    }
    const { preview, review } = record.delivery
    const operationId = dependencies.createCheckoutId()
    const startedAt = Date.now()
    updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      journal: { operation: 'finalize_preview', operationId, step: 'planning', startedAt, previewId: preview.previewId, reviewId: review.reviewId, retention: input.retention ?? 'cleanup' },
      revision: current.revision + 1,
    }))
    const result = await dependencies.applyEngine.finalize({
      localPath: record.localRoot,
      receipt: preview,
      commitMessage: input.commitMessage,
      beforeCommit: async (commitOid) => {
        updateManagedCheckout(record.checkoutId, (current) => ({
          ...current,
          journal: current.journal?.operation === 'finalize_preview'
            ? { ...current.journal, step: 'updating_ref', commitOid }
            : current.journal,
          revision: current.revision + 1,
        }))
      },
    })
    if (result.status === 'error') {
      if (result.error.code === 'stale_local' || result.error.code === 'preview_modified') {
        if (record.delivery.state === 'preview_active') {
          return detachPreviewAfterLocalDrift(record, binding, result.error.code, 'finalize_preview')
        }
        updateManagedCheckout(record.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      }
      if (result.error.code === 'commit_isolation_conflict') {
        if (record.delivery.state === 'preview_active') {
          return detachPreviewAfterLocalDrift(record, binding, 'preview_modified', 'finalize_preview')
        }
        updateManagedCheckout(record.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      }
      if (result.error.code === 'operation_not_allowed' || result.error.code === 'invalid_input') {
        updateManagedCheckout(record.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      }
      return operationError(result.error.code, result.error.message, await inspectIsolated(binding))
    }
    const finalized = updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'finalized',
      delivery: {
        state: 'finalized',
        review,
        commitOid: result.commitOid,
        proof: {
          localBranch: preview.localHeadRef?.startsWith('refs/heads/')
            ? preview.localHeadRef.slice('refs/heads/'.length)
            : null,
          localHeadBefore: result.localHeadBefore ?? preview.localHeadOid,
          localHeadAfter: result.commitOid ?? result.localHeadBefore ?? preview.localHeadOid,
          changedFiles: [...result.changedFiles],
        },
        isolatedFingerprint: preview.isolatedFingerprint,
        finalizedAt: Date.now(),
        cleanup: 'pending',
      },
      journal: null,
      revision: current.revision + 1,
    }))
    if (!finalized) return operationError('checkout_missing', '提交已创建，但 Checkout 记录丢失')
    const retention = input.retention ?? 'cleanup'
    if (retention !== 'cleanup') {
      const retained = retainFinalized(finalized, retention)
      if (!retained) return operationError('checkout_missing', '提交已创建，但保留 Worktree 状态写入失败')
      return {
        status: 'finished',
        target: await inspectIsolated(binding),
        changedFiles: result.changedFiles,
        commitOid: result.commitOid,
        cleanup: 'retained',
      }
    }
    const cleanup = await cleanupFinalized(finalized)
    return {
      status: 'finished',
      target: await inspectIsolated(binding),
      changedFiles: result.changedFiles,
      commitOid: result.commitOid,
      cleanup: cleanup.cleaned ? 'discarded' : 'pending',
      ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
      ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),
    }
  }

  async function operateRetryCleanup(
    input: Extract<SessionCheckoutOperation, { action: 'retry_cleanup' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以重试清理')
    }
    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    if (record.delivery.state !== 'finalized' && record.delivery.state !== 'retained') {
      return operationError('operation_not_allowed', '当前没有待重试的 Worktree 清理', await inspectIsolated(binding))
    }
    const cleanup = await cleanupFinalized(record, { allowLegacyResidue: true })
    return {
      status: 'finished',
      target: await inspectIsolated(binding),
      changedFiles: [...record.delivery.review.changedFiles],
      commitOid: record.delivery.commitOid,
      cleanup: cleanup.cleaned ? 'discarded' : 'pending',
      ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
      ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),
    }
  }

  async function operateFinish(
    input: Extract<SessionCheckoutOperation, { action: 'finish' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId) {
      return operationError('not_owner', '继承 Session Target 的会话不能执行 Finish')
    }
    if (binding.target.kind !== 'isolated') {
      return operationError('operation_not_allowed', 'Local Checkout 不支持 Finish')
    }

    let record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    const holder = findProjectAcceptanceHolder(record)
    if (holder) {
      return operationError(
        'project_acceptance_busy',
        `同一项目已有验收任务正在占用 Local：${holder.projectName}`,
        await inspectIsolated(binding),
      )
    }
    if (record.phase === 'ready' && (record.delivery.state === 'preview_active' || record.delivery.state === 'preview_detached')) {
      return operateFinalizePreview({
        action: 'finalize_preview',
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        commitMessage: input.commitMessage,
        ...(input.retention ? { retention: input.retention } : {}),
      }, binding)
    }
    if (record.phase !== 'ready') {
      return operationError('operation_not_allowed', `当前 ${record.phase}/${record.delivery.state} 状态不能直接 Finish`, await inspectIsolated(binding))
    }

    const inspected = await inspectIsolated(binding)
    if (inspected.checkout.phase !== 'ready') {
      return operationError('recovery_required', 'Isolated Checkout 身份无法确认，需要恢复', inspected)
    }
    record = dependencies.registry.read().managedCheckouts[record.checkoutId]
    if (!record || record.phase !== 'ready') {
      return operationError('recovery_required', 'Isolated Checkout 状态已变化，需要恢复')
    }
    const collaborators = projectCollaborators(record)
    if (collaborators.length > 0) {
      return operationError(
        'collaborator_active',
        collaboratorBlockMessage(collaborators),
        inspected,
      )
    }

    const startedAt = Date.now()
    const operationId = dependencies.createCheckoutId()
    const applyBaseOid = record.applyBaseOid ?? record.baseOid
    const applying = updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      journal: {
        operation: 'finish',
        operationId,
        step: 'planning',
        startedAt,
        baseOid: applyBaseOid,
      },
      revision: current.revision + 1,
    }))
    if (!applying) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')

    const planResult = await dependencies.applyEngine.plan({
      baseOid: applyBaseOid,
      isolatedPath: applying.managedRoot,
      localPath: applying.localRoot,
    })
    if (planResult.status === 'conflict') {
      updateManagedCheckout(applying.checkoutId, (current) => ({
        ...current,
        phase: 'ready',
        journal: null,
        revision: current.revision + 1,
      }))
      return {
        status: 'conflict',
        code: 'apply_conflict',
        reason: 'content_conflict',
        target: await inspectIsolated(binding),
        baseStrategy: planResult.baseStrategy,
        effectiveBaseOid: planResult.effectiveBaseOid,
        localHeadOid: planResult.localHeadOid,
        isolatedHeadOid: planResult.isolatedHeadOid,
        canRetryAfterRefresh: false,
        conflictingFiles: planResult.conflictingFiles,
      }
    }
    if (planResult.status === 'error') {
      updateManagedCheckout(applying.checkoutId, (current) => ({
        ...current,
        phase: 'ready',
        journal: null,
        revision: current.revision + 1,
      }))
      return operationError(planResult.error.code, planResult.error.message, await inspectIsolated(binding))
    }

    const iteration = applying.delivery.state === 'working'
      ? applying.delivery.iteration
      : applying.delivery.state === 'delivered'
        ? applying.delivery.iteration + 1
        : applying.delivery.review.iteration
    const review = applying.delivery.state === 'ready_for_review'
      ? applying.delivery.review
      : {
          reviewId: operationId,
          iteration,
          preparedAt: startedAt,
          summary: '跳过 Local 验收并直接提交',
          validationStatus: 'not_run' as const,
          tests: [],
          changedFiles: [...planResult.plan.changedFiles],
          suggestedCommitMessage: input.commitMessage,
          isolatedFingerprint: planResult.plan.isolatedFingerprint,
          isolatedHeadOid: planResult.plan.isolatedHeadOid,
        }
    const previewId = dependencies.createCheckoutId()
    updateManagedCheckout(applying.checkoutId, (current) => ({
      ...current,
      delivery: { state: 'ready_for_review', review },
      journal: {
        operation: 'finish',
        operationId,
        step: 'writing_local',
        startedAt,
        baseOid: applyBaseOid,
        planRevision: planResult.plan.revision,
        localFingerprint: planResult.plan.localFingerprint,
        isolatedFingerprint: planResult.plan.isolatedFingerprint,
        effectiveBaseOid: planResult.plan.effectiveBaseOid,
        baseStrategy: planResult.plan.baseStrategy,
        localHeadOid: planResult.plan.localHeadOid,
        isolatedHeadOid: planResult.plan.isolatedHeadOid,
        changedFiles: [...planResult.plan.changedFiles],
      },
      revision: current.revision + 1,
    }))
    const previewResult = await dependencies.applyEngine.preview(planResult.plan, {
      previewId,
      reviewId: review.reviewId,
      iteration: review.iteration,
      beforeWrite: async (receipt) => {
        await retainPreviewArtifacts(applying, receipt)
        updateManagedCheckout(applying.checkoutId, (current) => ({
          ...current,
          delivery: { state: 'preview_active', review, preview: receipt },
          journal: current.journal?.operation === 'finish'
            ? { ...current.journal, step: 'artifacts_retained', previewId, reviewId: review.reviewId }
            : current.journal,
          revision: current.revision + 1,
        }))
      },
    })
    if (previewResult.status === 'error') {
      const current = dependencies.registry.read().managedCheckouts[applying.checkoutId]
      if (current?.journal?.step === 'writing_local') {
        updateManagedCheckout(applying.checkoutId, (checkout) => ({ ...checkout, phase: 'ready', journal: null, revision: checkout.revision + 1 }))
      }
      return operationError(previewResult.error.code, previewResult.error.message, await inspectIsolated(binding))
    }
    const receipt = previewResult.receipt
    updateManagedCheckout(applying.checkoutId, (current) => ({
      ...current,
      phase: 'mutating',
      delivery: { state: 'preview_active', review, preview: receipt },
      journal: {
        operation: 'finish',
        operationId,
        step: 'planning',
        startedAt,
        previewId,
        reviewId: review.reviewId,
        isolatedFingerprint: receipt.isolatedFingerprint,
        retention: input.retention ?? 'cleanup',
        changedFiles: [...receipt.changedFiles],
      },
      revision: current.revision + 1,
    }))
    const finishResult = await dependencies.applyEngine.finalize({
      localPath: applying.localRoot,
      receipt,
      commitMessage: input.commitMessage,
      beforeCommit: async (commitOid) => {
        updateManagedCheckout(applying.checkoutId, (current) => ({
          ...current,
          journal: current.journal?.operation === 'finish'
            ? { ...current.journal, step: 'updating_ref', commitOid }
            : current.journal,
          revision: current.revision + 1,
        }))
      },
    })
    if (finishResult.status === 'error') {
      const safePreview = finishResult.error.code === 'stale_local'
        || finishResult.error.code === 'preview_modified'
        || finishResult.error.code === 'invalid_input'
        || finishResult.error.code === 'commit_isolation_conflict'
        || finishResult.error.code === 'operation_not_allowed'
      if (safePreview) {
        updateManagedCheckout(applying.checkoutId, (current) => ({ ...current, phase: 'ready', journal: null, revision: current.revision + 1 }))
      }
      return operationError(finishResult.error.code, finishResult.error.message, await inspectIsolated(binding))
    }

    const finalized = updateManagedCheckout(applying.checkoutId, (current) => ({
      ...current,
      phase: 'finalized',
      delivery: {
        state: 'finalized' as const,
        review,
        commitOid: finishResult.commitOid,
        proof: {
          localBranch: receipt.localHeadRef?.startsWith('refs/heads/')
            ? receipt.localHeadRef.slice('refs/heads/'.length)
            : null,
          localHeadBefore: finishResult.localHeadBefore ?? receipt.localHeadOid,
          localHeadAfter: finishResult.commitOid ?? finishResult.localHeadBefore ?? receipt.localHeadOid,
          changedFiles: [...finishResult.changedFiles],
        },
        isolatedFingerprint: receipt.isolatedFingerprint,
        finalizedAt: Date.now(),
        cleanup: 'pending' as const,
      },
      journal: null,
      revision: current.revision + 1,
    }))
    if (!finalized) {
      return operationError('checkout_missing', '任务提交已创建，但 Checkout 记录丢失，需要人工检查')
    }
    const retention = input.retention ?? 'cleanup'
    if (retention !== 'cleanup') {
      const retained = retainFinalized(finalized, retention)
      if (!retained) return operationError('checkout_missing', '任务提交已创建，但保留 Worktree 状态写入失败')
      return {
        status: 'finished',
        target: await inspectIsolated(binding),
        changedFiles: finishResult.changedFiles,
        commitOid: finishResult.commitOid,
        cleanup: 'retained',
      }
    }
    const cleanup = await cleanupFinalized(finalized)
    return {
      status: 'finished',
      target: await inspectIsolated(binding),
      changedFiles: finishResult.changedFiles,
      commitOid: finishResult.commitOid,
      cleanup: cleanup.cleaned ? 'discarded' : 'pending',
      ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
      ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),
    }
  }

  async function releaseApplyBaseBestEffort(record: ManagedCheckoutRecord): Promise<void> {
    try {
      await dependencies.git.releaseApplyBase(record.localRoot, record.checkoutId)
      await dependencies.git.releaseInternalArtifacts(record.localRoot, record.checkoutId)
    } catch {
      // checkout 删除优先；内部无 ref artifact 的清理失败不能阻止 owner 明确收口。
      console.warn('[session-checkout] 清理内部 Session Checkout refs 失败，已保守保留不可见引用')
    }
  }

  async function operateDiscard(
    input: Extract<SessionCheckoutOperation, { action: 'discard' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId) {
      return operationError('not_owner', '继承 Session Target 的会话不能执行 Discard')
    }
    if (binding.target.kind !== 'isolated') {
      return operationError('operation_not_allowed', 'Local Checkout 不支持 Discard')
    }

    let record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    const detachedPreviewId = record.delivery.state === 'preview_detached' ? record.delivery.preview.previewId : undefined
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    if (record.delivery.state === 'preview_active') {
      const inspection = await dependencies.applyEngine.inspectPreview({
        localPath: record.localRoot,
        receipt: record.delivery.preview,
      })
      if (inspection.status === 'error') {
        if (inspection.error.code === 'stale_local' || inspection.error.code === 'preview_modified') {
          return detachPreviewAfterLocalDrift(record, binding, inspection.error.code, 'discard')
        }
        return operationError(inspection.error.code, inspection.error.message, await inspectIsolated(binding))
      }
      if (inspection.status === 'preview_active') {
        return operationError(
          'operation_not_allowed',
          'Local Preview 仍未结算。放弃任务不会自动撤回 Local；请先单独撤回本次预览或提交 Preview。',
          await inspectIsolated(binding),
        )
      }
      const finalized = finalizeCommittedPreview(record, inspection.commitOid)
      if (!finalized) return operationError('stale_target', 'Preview 状态已变化，请刷新后重试', await inspectIsolated(binding))
      const cleanup = await cleanupFinalized(finalized)
      if (!cleanup.cleaned) {
        return {
          status: 'finished',
          target: await inspectIsolated(binding),
          changedFiles: inspection.changedFiles,
          commitOid: inspection.commitOid,
          cleanup: 'pending',
          ...(cleanup.message ? { cleanupMessage: cleanup.message } : {}),
          ...(cleanup.reason ? { cleanupReason: cleanup.reason } : {}),
        }
      }
      return { status: 'discarded', target: await inspectIsolated(binding) }
    }
    const collaborators = projectCollaborators(record)
    if (collaborators.length > 0) {
      return operationError(
        'operation_not_allowed',
        collaboratorBlockMessage(collaborators),
        await inspectIsolated(binding),
      )
    }
    if (record.phase === 'recovery_required' && !dependencies.files.exists(record.managedRoot)) {
      await releaseApplyBaseBestEffort(record)
      updateManagedCheckout(record.checkoutId, (current) => ({
        ...current,
        phase: 'discarded',
        journal: null,
        revision: current.revision + 1,
      }))
      return { status: 'discarded', target: await inspectIsolated(binding) }
    }
    if (record.phase !== 'ready' && record.phase !== 'recovery_required') {
      return operationError('operation_not_allowed', `当前 ${record.phase} 状态不能 Discard`, await inspectIsolated(binding))
    }

    let inspected: SessionTargetView
    let dirty = true
    if (record.phase === 'ready') {
      inspected = await inspectIsolated(binding)
      if (inspected.checkout.phase !== 'ready') {
        return operationError('recovery_required', 'Isolated Checkout 身份无法确认，需要恢复', inspected)
      }
      record = dependencies.registry.read().managedCheckouts[record.checkoutId]
      if (!record || record.phase !== 'ready') {
        return operationError('recovery_required', 'Isolated Checkout 状态已变化，需要恢复')
      }
      dirty = (await dependencies.git.status(record.managedRoot)).dirty || (record.checkpoints?.length ?? 0) > 0
    } else {
      try {
        dirty = (await dependencies.git.status(record.managedRoot)).dirty || (record.checkpoints?.length ?? 0) > 0
      } catch {
        dirty = true
      }
      inspected = recoveryView(binding, record, dirty)
    }
    if (dirty && !input.confirmDirty) {
      return operationError('dirty_confirmation_required', 'Isolated Checkout 含未提交修改或状态无法确认，需要明确确认', inspected)
    }

    try {
      await dependencies.git.removeWorktree(record.localRoot, record.managedGitRoot)
    } catch {
      return operationError('git_operation_failed', '删除 managed checkout 失败', await inspectIsolated(binding))
    }
    if (detachedPreviewId) await releasePreviewArtifactsBestEffort(record, detachedPreviewId)
    await releaseApplyBaseBestEffort(record)
    updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      phase: 'discarded',
      journal: null,
      revision: current.revision + 1,
    }))
    return { status: 'discarded', target: await inspectIsolated(binding) }
  }

  async function operateReleaseCollaborator(
    input: Extract<SessionCheckoutOperation, { action: 'release_collaborator' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以释放协作占用')
    }
    const registry = dependencies.registry.read()
    const record = registry.managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    const collaboratorBinding = registry.sessionBindings[input.collaboratorSessionId]
    if (
      !collaboratorBinding
      || collaboratorBinding.sessionId === input.sessionId
      || collaboratorBinding.target.kind !== 'isolated'
      || collaboratorBinding.target.checkoutId !== record.checkoutId
      || collaboratorBinding.ownerSessionId !== input.sessionId
      || !collaboratorBinding.inheritedFromSessionId
    ) {
      return operationError('invalid_input', '指定会话没有占用当前 Worktree', await inspectIsolated(binding))
    }
    const collaborator = dependencies.lookup.getSession(input.collaboratorSessionId)
    const isDelegation = !!collaborator?.sourceDelegationId
    const isFork = !!collaborator?.parentSessionId && !!collaboratorBinding.inheritedFromSessionId
    if (!isDelegation && !isFork) {
      return operationError('operation_not_allowed', '只能显式释放来源明确的协作或 Fork 会话', await inspectIsolated(binding))
    }
    const rawStatus: unknown = collaborator?.delegationStatus
    if (dependencies.lookup.isSessionActive(input.collaboratorSessionId) || rawStatus === 'running') {
      return operationError('collaborator_active', `${collaborator?.title || '协作会话'}仍在运行，请先停止后再释放`, await inspectIsolated(binding))
    }
    if (isDelegation && collaborator?.delegationCheckoutReleasedAt === undefined && !isTerminalCollaboratorStatus(rawStatus)) {
      return operationError('operation_not_allowed', '协作会话不是可释放的已结束状态，未释放 Worktree 占用', await inspectIsolated(binding))
    }

    try {
      if (isDelegation && collaborator?.delegationCheckoutReleasedAt === undefined) {
        dependencies.lookup.markDelegationCheckoutReleased(input.collaboratorSessionId, Date.now())
      } else if (isFork) {
        dependencies.lookup.markInheritedCheckoutReleased(input.collaboratorSessionId)
      }
    } catch {
      return operationError('operation_not_allowed', '无法持久化会话释放状态，未释放 Worktree 占用', await inspectIsolated(binding))
    }

    const latest = dependencies.registry.read()
    const latestRecord = latest.managedCheckouts[record.checkoutId]
    const latestBinding = latest.sessionBindings[input.collaboratorSessionId]
    if (
      !latestRecord
      || latestRecord.revision !== input.expectedRevision
      || !latestBinding
      || latestBinding.target.kind !== 'isolated'
      || latestBinding.target.checkoutId !== record.checkoutId
      || latestBinding.ownerSessionId !== input.sessionId
    ) {
      return operationError('stale_target', '协作占用状态已变化，请刷新后重试', await inspectIsolated(binding))
    }
    delete latest.sessionBindings[input.collaboratorSessionId]
    latest.managedCheckouts[record.checkoutId] = {
      ...latestRecord,
      revision: latestRecord.revision + 1,
    }
    latest.revision += 1
    dependencies.registry.write(latest)
    return {
      status: 'collaborator_released',
      collaboratorSessionId: input.collaboratorSessionId,
      target: await inspectIsolated(binding),
    }
  }

  async function operateReleaseCollaborators(
    input: Extract<SessionCheckoutOperation, { action: 'release_collaborators' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId || binding.target.kind !== 'isolated') {
      return operationError('not_owner', '只有 owner Isolated 会话可以批量释放协作占用')
    }
    const registry = dependencies.registry.read()
    const record = registry.managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    const collaborators = projectCollaborators(record)
    if (collaborators.length === 0) {
      return { status: 'collaborators_released', collaboratorSessionIds: [], target: await inspectIsolated(binding) }
    }
    const unsafe = collaborators.filter((collaborator) => !collaborator.canRelease)
    if (unsafe.length > 0) {
      return operationError('collaborator_active', collaboratorBlockMessage(unsafe), await inspectIsolated(binding))
    }
    const collaboratorSessionIds = collaborators.map((collaborator) => collaborator.sessionId).sort()
    const releasedAt = Date.now()
    for (const collaboratorSessionId of collaboratorSessionIds) {
      const collaborator = dependencies.lookup.getSession(collaboratorSessionId)
      const collaboratorBinding = registry.sessionBindings[collaboratorSessionId]
      const isDelegation = !!collaborator?.sourceDelegationId
      const isFork = !!collaborator?.parentSessionId && !!collaboratorBinding?.inheritedFromSessionId
      if (!isDelegation && !isFork) {
        return operationError('operation_not_allowed', '协作会话来源无法确认，未批量释放任何占用', await inspectIsolated(binding))
      }
      if (
        dependencies.lookup.isSessionActive(collaboratorSessionId)
        || (isDelegation
          && collaborator?.delegationCheckoutReleasedAt === undefined
          && !isTerminalCollaboratorStatus(collaborator.delegationStatus))
      ) {
        return operationError('collaborator_active', `${collaborator?.title || '协作会话'}尚未结束，未批量释放任何占用`, await inspectIsolated(binding))
      }
    }
    for (const collaboratorSessionId of collaboratorSessionIds) {
      const collaborator = dependencies.lookup.getSession(collaboratorSessionId)
      try {
        if (collaborator?.sourceDelegationId && collaborator.delegationCheckoutReleasedAt === undefined) {
          dependencies.lookup.markDelegationCheckoutReleased(collaboratorSessionId, releasedAt)
        } else if (collaborator?.parentSessionId) {
          dependencies.lookup.markInheritedCheckoutReleased(collaboratorSessionId)
        }
      } catch {
        return operationError('operation_not_allowed', '无法持久化全部协作会话结束状态，未修改 Worktree binding', await inspectIsolated(binding))
      }
    }
    const latest = dependencies.registry.read()
    const latestRecord = latest.managedCheckouts[record.checkoutId]
    if (!latestRecord || latestRecord.revision !== input.expectedRevision) {
      return operationError('stale_target', '协作占用状态已变化，请刷新后重试', await inspectIsolated(binding))
    }
    for (const collaboratorSessionId of collaboratorSessionIds) {
      const latestBinding = latest.sessionBindings[collaboratorSessionId]
      if (
        !latestBinding
        || latestBinding.target.kind !== 'isolated'
        || latestBinding.target.checkoutId !== record.checkoutId
        || latestBinding.ownerSessionId !== input.sessionId
        || !latestBinding.inheritedFromSessionId
      ) return operationError('stale_target', '协作占用身份已变化，请刷新后重试', await inspectIsolated(binding))
    }
    for (const collaboratorSessionId of collaboratorSessionIds) delete latest.sessionBindings[collaboratorSessionId]
    latest.managedCheckouts[record.checkoutId] = { ...latestRecord, revision: latestRecord.revision + 1 }
    latest.revision += 1
    dependencies.registry.write(latest)
    return {
      status: 'collaborators_released',
      collaboratorSessionIds,
      target: await inspectIsolated(binding),
    }
  }

  async function operateRecover(
    input: Extract<SessionCheckoutOperation, { action: 'recover' }>,
    binding: SessionBindingRecord,
  ): Promise<SessionCheckoutOperationResult> {
    if (binding.ownerSessionId !== input.sessionId) {
      return operationError('not_owner', '继承 Session Target 的会话不能执行 Recover')
    }
    if (binding.target.kind !== 'isolated') {
      return operationError('operation_not_allowed', 'Local Checkout 不支持 Recover')
    }

    const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
    if (!record) return operationError('checkout_missing', 'Isolated Checkout 记录不存在')
    if (record.revision !== input.expectedRevision) {
      return operationError('stale_target', 'Session Target 已变化，请刷新后重试', await inspectIsolated(binding))
    }
    const recoverCreate = record.journal?.operation === 'create'
    if ((record.journal !== null && !recoverCreate) || record.phase === 'mutating') {
      return operationError(
        'recovery_unsafe',
        'Apply 是否已修改 Local 无法安全确认；不会自动重试或猜测成功',
        await inspectIsolated(binding),
      )
    }
    if (!dependencies.files.exists(record.managedRoot)) {
      return operationError('recovery_required', 'Isolated Checkout 缺失，只能由 owner 明确 Discard 收口')
    }

    const validated = await validateManagedCheckout(binding, record, recoverCreate)
    if (!validated) {
      return operationError('recovery_unsafe', 'Isolated Checkout 的路径、Git 身份、项目、HEAD 或状态无法完整确认')
    }

    updateManagedCheckout(record.checkoutId, (current) => ({
      ...current,
      managedRoot: validated.canonicalManagedRoot,
      managedGitRoot: validated.canonicalManagedGitRoot,
      gitDir: validated.snapshot.gitDir,
      phase: 'ready',
      ...(current.delivery.state === 'ready_for_review' ? { previousReview: projectPreviousReview(current.delivery.review) } : {}),
      delivery: current.delivery.state === 'ready_for_review'
        ? { state: 'working', iteration: current.delivery.review.iteration }
        : current.delivery,
      journal: null,
      revision: current.revision + 1,
    }))
    return { status: 'recovered', target: await inspectIsolated(binding) }
  }

  async function operateTarget(input: SessionCheckoutOperation): Promise<SessionCheckoutOperationResult> {
    try {
      const binding = await resolveBinding(input.sessionId)
      if (input.action === 'apply') return await operateApply(input, binding)
      if (input.action === 'finish') return await operateFinish(input, binding)
      if (input.action === 'preview') return await operatePreview(input, binding)
      if (input.action === 'checkpoint') return await operateCheckpoint(input, binding)
      if (input.action === 'rollback_preview') return await operateRollbackPreview(input, binding)
      if (input.action === 'finalize_preview') return await operateFinalizePreview(input, binding)
      if (input.action === 'retry_cleanup') return await operateRetryCleanup(input, binding)
      if (input.action === 'discard') return await operateDiscard(input, binding)
      if (input.action === 'release_collaborator') return await operateReleaseCollaborator(input, binding)
      if (input.action === 'release_collaborators') return await operateReleaseCollaborators(input, binding)
      if (input.action === 'recover') return await operateRecover(input, binding)
      const exhaustive: never = input
      return exhaustive
    } catch (error) {
      if (error instanceof SessionCheckoutError) return operationError(error.code, error.message)
      throw error
    }
  }

  function managedIteration(record: ManagedCheckoutRecord): number {
    if (record.delivery.state === 'working' || record.delivery.state === 'delivered') return record.delivery.iteration
    return record.delivery.review.iteration
  }

  function managedUpdatedAt(record: ManagedCheckoutRecord): number {
    if (record.delivery.state === 'working') return record.journal?.startedAt ?? 0
    if (record.delivery.state === 'ready_for_review') return record.delivery.review.preparedAt
    if (record.delivery.state === 'preview_active') return record.delivery.preview.previewedAt
    if (record.delivery.state === 'preview_detached') return record.delivery.detachedAt
    if (record.delivery.state === 'finalized') return record.delivery.finalizedAt
    if (record.delivery.state === 'retained') return record.delivery.retainedAt
    return record.delivery.deliveredAt
  }

  async function summarizeManagedWorktree(
    record: ManagedCheckoutRecord,
    includeDiagnostics = false,
  ): Promise<ManagedWorktreeSummaryView> {
    // 快速列表必须保守且不扫描 Git/磁盘；只有后台单项诊断完成后才开放清理。
    let dirty = true
    let cleanupResidue = false
    let approximateBytes: number | null = null
    if (includeDiagnostics) {
      if (record.delivery.state === 'finalized' || record.delivery.state === 'retained') {
        const quarantine = await validateCleanupQuarantine(record)
        const residue = quarantine ? undefined : await validateDetachedCleanupResidue(record, true)
        if (quarantine || residue) {
          cleanupResidue = true
          dirty = false
        } else if (dependencies.files.exists(record.managedRoot)) {
          try {
            const snapshot = await dependencies.applyEngine.inspectReview({
              baseOid: record.applyBaseOid ?? record.baseOid,
              isolatedPath: record.managedRoot,
              localPath: record.localRoot,
            })
            dirty = snapshot.status !== 'ready' || snapshot.isolatedFingerprint !== record.delivery.isolatedFingerprint
          } catch { dirty = true }
        }
      } else if (dependencies.files.exists(record.managedRoot)) {
        try { dirty = (await dependencies.git.status(record.managedRoot)).dirty } catch { dirty = true }
      }
      const physicalRoot = record.journal?.operation === 'cleanup' && record.journal.cleanupQuarantinePath
        ? record.journal.cleanupQuarantinePath
        : record.managedGitRoot
      if (dependencies.files.exists(physicalRoot)) {
        try { approximateBytes = await dependencies.files.measureDirectoryBytes(physicalRoot) } catch { approximateBytes = null }
      }
    }
    const delivery = record.delivery
    const state: ManagedWorktreeSummaryView['state'] = record.phase === 'recovery_required'
      ? 'needs_attention'
      : delivery.state === 'retained'
        ? delivery.cleanup === 'blocked' ? 'needs_attention' : 'retained'
        : delivery.state === 'finalized'
          ? delivery.cleanup === 'blocked' ? 'needs_attention' : 'cleanup_pending'
          : delivery.state === 'preview_active'
            ? 'preview_active'
            : delivery.state === 'preview_detached'
              ? 'needs_attention'
              : delivery.state === 'ready_for_review'
                ? 'ready_for_review'
              : delivery.state === 'delivered'
                ? 'delivered'
                : 'working'
    const commitOid = delivery.state === 'finalized' || delivery.state === 'retained' || delivery.state === 'delivered'
      ? delivery.commitOid
      : null
    const cleanupMessage = cleanupResidue
      ? CLEANUP_RESIDUE_MESSAGE
      : delivery.state === 'preview_detached'
        ? 'Local 在验收后被其他 Domi 任务、Git 操作或文件修改推进；撤回尚未完成，Preview 修改仍留在 Local，旧验收占用已解除。请先检查 Local 与 Worktree 再决定重试撤回或放弃。'
        : delivery.state === 'finalized' || delivery.state === 'retained'
          ? delivery.cleanupMessage
          : undefined
    const cleanupReason = cleanupMessage ? cleanupReasonForMessage(cleanupMessage) : undefined
    return {
      checkoutId: record.checkoutId,
      revision: record.revision,
      ownerSessionId: record.ownerSessionId,
      ownerSessionTitle: dependencies.lookup.getSession(record.ownerSessionId)?.title?.trim() || '已删除的 Agent 会话',
      project: { id: record.projectId, name: record.projectName },
      iteration: managedIteration(record),
      state,
      phase: record.phase,
      dirty,
      commitOid,
      ...(delivery.state === 'retained' ? {
        retention: delivery.retention,
        retainedAt: delivery.retainedAt,
        expiresAt: delivery.expiresAt,
      } : {}),
      ...(cleanupMessage ? { cleanupMessage } : {}),
      ...(cleanupReason ? { cleanupReason } : {}),
      approximateBytes,
      updatedAt: managedUpdatedAt(record),
      canReveal: dependencies.files.exists(record.managedRoot),
      canCleanup: includeDiagnostics && (delivery.state === 'retained' || delivery.state === 'finalized') && !dirty,
    }
  }

  function cleanupBlocked(reason: ManagedWorktreeCleanupView['reason'], message: string, revision: number): ManagedWorktreeCleanupView {
    return { eligibility: 'blocked', reason, message, inspectedRevision: revision }
  }

  async function inspectCleanupForRecord(record: ManagedCheckoutRecord): Promise<ManagedWorktreeCleanupView> {
    if (record.delivery.state === 'working') return cleanupBlocked('working', '当前轮次仍在修改，尚未形成可清理的交付环境。', record.revision)
    if (record.delivery.state === 'ready_for_review') return cleanupBlocked('review_pending', '当前轮次正在等待验收，不能清理。', record.revision)
    if (record.delivery.state === 'preview_active' || record.delivery.state === 'preview_detached') {
      return cleanupBlocked('preview_active', 'Local Preview 尚未完成安全收口，不能清理。', record.revision)
    }
    if (record.delivery.state === 'delivered' || record.phase === 'discarded') {
      return cleanupBlocked('unknown', 'Worktree 已交付并解除管理，无需再次清理。', record.revision)
    }
    if (record.delivery.commitOid && record.delivery.proof) {
      const local = await validateCommittedLocalCheckout(bindingForManagedRecord(record), record)
      if (!local) return cleanupBlocked('identity_mismatch', 'Local checkout identity 无法验证，不能证明本轮交付仍存在。', record.revision)
      try {
        const delivered = await dependencies.git.isAncestor(local.canonicalLocalRoot, record.delivery.commitOid, local.snapshot.headOid)
        if (!delivered) return cleanupBlocked('identity_mismatch', '本轮交付 commit 已不在 Local 历史中，不能清理环境。', record.revision)
      } catch {
        return cleanupBlocked('unknown', '无法验证本轮交付 commit 是否仍在 Local 历史中。', record.revision)
      }
    }
    const registry = dependencies.registry.read()
    const collaborators = Object.values(registry.sessionBindings).filter((candidate) => (
      candidate.sessionId !== record.ownerSessionId
      && candidate.target.kind === 'isolated'
      && candidate.target.checkoutId === record.checkoutId
    ))
    if (collaborators.length > 0) return cleanupBlocked('collaborator_active', 'Worktree 仍被协作会话占用。', record.revision)
    const quarantine = await validateCleanupQuarantine(record)
    const residue = quarantine ? undefined : await validateDetachedCleanupResidue(record, true)
    if (record.journal?.operation === 'cleanup' && record.journal.cleanupQuarantinePath && !quarantine) {
      return cleanupBlocked('identity_mismatch', '清理目录身份无法重新验证，已保留环境。', record.revision)
    }
    if (!quarantine && !residue && dependencies.files.exists(record.managedRoot)) {
      const binding = bindingForManagedRecord(record)
      const validated = await validateManagedCheckout(binding, record, false)
      if (!validated) return cleanupBlocked('identity_mismatch', 'Worktree checkout identity 无法验证，已保留环境。', record.revision)
      try {
        const snapshot = await dependencies.applyEngine.inspectReview({
          baseOid: record.applyBaseOid ?? record.baseOid,
          isolatedPath: record.managedRoot,
          localPath: record.localRoot,
        })
        if (snapshot.status !== 'ready' || snapshot.isolatedFingerprint !== record.delivery.isolatedFingerprint) {
          return cleanupBlocked('uncommitted_changes', '提交或保留后检测到新增修改，不能批量清理。', record.revision)
        }
      } catch {
        return cleanupBlocked('unknown', '无法证明 Worktree 当前状态安全，已保留环境。', record.revision)
      }
    }
    if (record.delivery.cleanup === 'blocked' || record.delivery.cleanup === 'pending') {
      const cleanupMessage = record.delivery.cleanupMessage ?? '上次清理未完成，可重新校验后重试。'
      if (cleanupReasonForMessage(cleanupMessage) === 'identity_changed') return cleanupBlocked('identity_mismatch', cleanupMessage, record.revision)
      if (cleanupReasonForMessage(cleanupMessage) === 'modified_after_finalize') return cleanupBlocked('uncommitted_changes', cleanupMessage, record.revision)
    }
    if (
      record.delivery.state === 'retained'
      && (record.delivery.retention === 'retain_manual' || record.delivery.expiresAt === null || record.delivery.expiresAt > Date.now())
    ) {
      return { eligibility: 'retained', reason: 'retention_active', message: record.delivery.retention === 'retain_manual' ? '按用户选择手动保留。' : '保留期限尚未到期。', inspectedRevision: record.revision }
    }
    return { eligibility: 'safe', reason: 'cleanup_failed', message: record.delivery.cleanupMessage ?? '已通过只读安全巡检，可以清理。', inspectedRevision: record.revision }
  }

  async function inspectManagedWorktreeCleanup(input: ListManagedWorktreesInput = {}): Promise<ManagedWorktreeSummaryView[]> {
    const records = Object.values(dependencies.registry.read().managedCheckouts)
      .filter((record) => record.phase !== 'discarded')
      .filter((record) => !input.projectId || record.projectId === input.projectId)
      .filter((record) => !input.checkoutId || record.checkoutId === input.checkoutId)
    const summaries = await Promise.all(records.map(async (record) => ({
      ...(await summarizeManagedWorktree(record, true)),
      cleanup: await inspectCleanupForRecord(record),
    })))
    return summaries
      .filter((summary) => !input.needsAttention || summary.cleanup?.eligibility === 'blocked')
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async function bulkCleanupManagedWorktrees(
    candidates: BulkCleanupManagedWorktreeCandidate[],
  ): Promise<BulkCleanupManagedWorktreesResult> {
    const cleaned: BulkCleanupManagedWorktreesResult['cleaned'] = []
    const retained: BulkCleanupManagedWorktreesResult['retained'] = []
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.checkoutId, candidate])).values()]
      .sort((left, right) => left.checkoutId.localeCompare(right.checkoutId))
    for (const candidate of uniqueCandidates) {
      const record = dependencies.registry.read().managedCheckouts[candidate.checkoutId]
      if (!record || record.phase === 'discarded') continue
      if (record.revision !== candidate.expectedRevision) {
        retained.push({
          checkoutId: record.checkoutId,
          iteration: managedIteration(record),
          cleanup: cleanupBlocked('unknown', 'Worktree revision 已变化，未执行清理。', record.revision),
        })
        continue
      }
      const inspection = await inspectCleanupForRecord(record)
      if (inspection.eligibility !== 'safe') {
        retained.push({ checkoutId: record.checkoutId, iteration: managedIteration(record), cleanup: inspection })
        continue
      }
      const latest = dependencies.registry.read().managedCheckouts[candidate.checkoutId]
      if (!latest || latest.revision !== candidate.expectedRevision) {
        retained.push({
          checkoutId: record.checkoutId,
          iteration: managedIteration(record),
          cleanup: cleanupBlocked('unknown', 'Worktree 在清理前发生变化，未执行清理。', latest?.revision ?? record.revision),
        })
        continue
      }
      const result = await cleanupFinalized(latest, { allowLegacyResidue: true })
      const updated = dependencies.registry.read().managedCheckouts[candidate.checkoutId]
      if (result.cleaned) {
        cleaned.push({
          checkoutId: record.checkoutId,
          iteration: managedIteration(record),
          commitOid: record.delivery.state === 'finalized' || record.delivery.state === 'retained' ? record.delivery.commitOid : null,
        })
      } else if (updated) {
        retained.push({
          checkoutId: updated.checkoutId,
          iteration: managedIteration(updated),
          cleanup: await inspectCleanupForRecord(updated),
        })
      }
    }
    return { cleaned, retained }
  }

  async function listManagedWorktrees(input: ListManagedWorktreesInput = {}): Promise<ManagedWorktreeSummaryView[]> {
    const records = Object.values(dependencies.registry.read().managedCheckouts)
      .filter((record) => record.phase !== 'discarded')
      .filter((record) => !input.projectId || record.projectId === input.projectId)
      .filter((record) => !input.checkoutId || record.checkoutId === input.checkoutId)
    const summaries = await Promise.all(records.map((record) => summarizeManagedWorktree(record, input.includeDiagnostics === true)))
    return summaries
      .filter((summary) => !input.needsAttention || summary.state === 'needs_attention' || summary.state === 'cleanup_pending')
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async function manageManagedWorktree(input: ManageManagedWorktreeInput): Promise<ManagedWorktreeSummaryView> {
    const record = dependencies.registry.read().managedCheckouts[input.checkoutId]
    if (!record) throw new SessionCheckoutError('checkout_missing', 'Worktree 记录不存在')
    if (record.revision !== input.expectedRevision) throw new SessionCheckoutError('stale_target', 'Worktree 状态已变化，请刷新后重试')
    if (input.action === 'discard') {
      const result = await operateTarget({
        action: 'discard',
        sessionId: record.ownerSessionId,
        expectedRevision: input.expectedRevision,
        confirmDirty: input.confirmDirty === true,
      })
      if (result.status === 'error') throw new SessionCheckoutError(result.code, result.message)
      const updated = dependencies.registry.read().managedCheckouts[record.checkoutId]
      if (!updated) throw new SessionCheckoutError('checkout_missing', 'Worktree 记录不存在')
      return summarizeManagedWorktree(updated)
    }
    if (input.action === 'set_retention') {
      if (record.phase !== 'retained' || record.delivery.state !== 'retained' || !input.retention) {
        throw new SessionCheckoutError('operation_not_allowed', '只有已保留的冻结 Worktree 可以调整保留期限')
      }
      const retainedAt = Date.now()
      const updated = updateManagedCheckout(record.checkoutId, (current) => {
        if (current.delivery.state !== 'retained') return current
        return {
          ...current,
          delivery: {
            ...current.delivery,
            retention: input.retention!,
            retainedAt,
            expiresAt: retentionExpiresAt(input.retention!, retainedAt),
            cleanup: 'scheduled',
            cleanupMessage: undefined,
          },
          revision: current.revision + 1,
        }
      })
      if (!updated) throw new SessionCheckoutError('checkout_missing', 'Worktree 记录不存在')
      return summarizeManagedWorktree(updated)
    }
    if (record.delivery.state !== 'retained' && record.delivery.state !== 'finalized') {
      throw new SessionCheckoutError('operation_not_allowed', '当前 Worktree 不处于可清理状态')
    }
    await cleanupFinalized(record, { allowLegacyResidue: true })
    const updated = dependencies.registry.read().managedCheckouts[record.checkoutId]
    if (!updated) throw new SessionCheckoutError('checkout_missing', 'Worktree 记录不存在')
    return summarizeManagedWorktree(updated)
  }

  async function resolveManagedRootForReveal(checkoutId: string): Promise<string> {
    const record = dependencies.registry.read().managedCheckouts[checkoutId]
    if (!record || record.phase === 'discarded') throw new SessionCheckoutError('checkout_missing', 'Worktree 目录已不存在')
    const validated = await validateManagedCheckout(bindingForManagedRecord(record), record, false)
    if (!validated) throw new SessionCheckoutError('checkout_mismatch', 'Worktree 目录身份无法验证')
    return validated.canonicalManagedRoot
  }

  async function cleanupExpiredRetained(now = Date.now()): Promise<string[]> {
    const expired = Object.values(dependencies.registry.read().managedCheckouts).filter((record) => (
      record.phase === 'retained'
      && record.delivery.state === 'retained'
      && record.delivery.cleanup === 'scheduled'
      && record.delivery.expiresAt !== null
      && record.delivery.expiresAt <= now
    ))
    const cleaned: string[] = []
    for (const record of expired) {
      try {
        // 到期保留清理同样受收敛超时保护，避免单个占用记录卡住后续启动。
        const result = await withCleanupTimeout(record.checkoutId, () => cleanupFinalized(record))
        if (result?.cleaned) cleaned.push(record.checkoutId)
      } catch (error) {
        console.warn(`[session-checkout] expired retained Worktree cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return cleaned
  }

  async function bindTarget(
    sessionId: string,
    choice: SessionTargetBindChoice,
    verifiedIsolatedProof?: VerifiedIsolatedBindProof,
    createAttempt = 0,
    requestStartedAt = Date.now(),
  ): Promise<SessionTargetView> {
      const bindStartedAt = requestStartedAt
      const session = requireSession(sessionId)
      if (session.delegationCheckoutReleasedAt !== undefined) {
        throw new SessionCheckoutError(
          'operation_not_allowed',
          '该协作会话已结束并释放 Worktree 占用，不能重新绑定；请创建新的协作子会话',
        )
      }
      let nextIteration = 1
      let replacedDeliveredBinding: SessionBindingRecord | undefined
      const existing = getPersistedBinding(sessionId)
      if (existing) {
        if (choice.kind === 'local' && existing.target.kind === 'local') {
          return inspectLocal(existing)
        }
        if (choice.kind === 'isolated' && existing.target.kind === 'isolated') {
          const existingView = await inspectIsolated(existing)
          const registry = dependencies.registry.read()
          const existingRecord = registry.managedCheckouts[existing.target.checkoutId]
          if (
            existingView.ownership === 'owner'
            && existingRecord
            && (
              existingView.checkout.phase === 'discarded'
              || (existingView.checkout.phase === 'finalized' && existingRecord.delivery.state === 'finalized')
              || (existingView.checkout.phase === 'retained' && existingRecord.delivery.state === 'retained')
            )
          ) {
            nextIteration = managedIteration(existingRecord) + 1
            replacedDeliveredBinding = {
              ...existing,
              target: { ...existing.target },
            }
            delete registry.sessionBindings[sessionId]
            registry.revision += 1
            dependencies.registry.write(registry)
          } else {
            return existingView
          }
        }
        if (choice.kind === 'inherit' && existing.inheritedFromSessionId === choice.parentSessionId) {
          return existing.target.kind === 'local' ? inspectLocal(existing) : inspectIsolated(existing)
        }
        if (!(choice.kind === 'isolated' && existing.target.kind === 'isolated' && nextIteration > 1)) {
          throw new SessionCheckoutError('target_already_bound', '会话已经绑定 Session Target，不能切换')
        }
      }
      if (dependencies.lookup.getUnboundTargetPolicy(session) === 'local') {
        if (choice.kind !== 'local') {
          throw new SessionCheckoutError('target_already_bound', '历史会话已兼容绑定 Local Checkout，不能切换')
        }
        const legacyBinding = await createLegacyLocalBinding(sessionId)
        if (!legacyBinding) throw new SessionCheckoutError('target_unselected', '会话尚未选择 Session Target')
        return inspectLocal(legacyBinding)
      }
      if (choice.kind === 'inherit') {
        const child = await resolveSessionProject(sessionId)
        if (!dependencies.lookup.getSession(choice.parentSessionId)) {
          throw new SessionCheckoutError('parent_session_not_found', `父会话不存在: ${choice.parentSessionId}`)
        }
        let parentBinding: SessionBindingRecord
        try {
          parentBinding = await resolveBinding(choice.parentSessionId)
        } catch (error) {
          if (error instanceof SessionCheckoutError && error.code === 'target_unselected') {
            throw new SessionCheckoutError('parent_target_unselected', '父会话尚未选择 Session Target')
          }
          throw error
        }
        if (child.project.id !== parentBinding.projectId) {
          throw new SessionCheckoutError('project_mismatch', '子会话项目与父会话 Session Target 不一致')
        }
        const inheritedBinding: SessionBindingRecord = {
          sessionId,
          projectId: parentBinding.projectId,
          projectName: parentBinding.projectName,
          target: parentBinding.target,
          ownerSessionId: parentBinding.ownerSessionId,
          inheritedFromSessionId: choice.parentSessionId,
          sourceRef: parentBinding.sourceRef,
          sourceOid: parentBinding.sourceOid,
          revision: 1,
        }
        const registry = dependencies.registry.read()
        registry.sessionBindings[sessionId] = inheritedBinding
        registry.revision += 1
        dependencies.registry.write(registry)
        return inheritedBinding.target.kind === 'local'
          ? inspectLocal(inheritedBinding)
          : inspectIsolated(inheritedBinding)
      }

      const { project } = await resolveSessionProject(sessionId)
      const snapshot = await dependencies.git.inspect(project.root)

      if (choice.kind === 'local') {
        const binding: SessionBindingRecord = {
          sessionId,
          projectId: project.id,
          projectName: project.name,
          target: { kind: 'local' },
          ownerSessionId: sessionId,
          sourceRef: snapshot?.headRef ?? UNVERSIONED_REF,
          sourceOid: snapshot?.headOid ?? UNVERSIONED_OID,
          revision: 1,
        }
        const registry = dependencies.registry.read()
        registry.sessionBindings[sessionId] = binding
        registry.revision += 1
        dependencies.registry.write(registry)
        return inspectLocal(binding)
      }

      if (!snapshot) {
        throw new SessionCheckoutError('not_git_repository', '非 Git 项目不能创建 Isolated Checkout')
      }
      if (verifiedIsolatedProof) {
        if (snapshot.headOid !== verifiedIsolatedProof.expectedCurrentOid) {
          throw new SessionCheckoutError('stale_target', 'Local HEAD 在确认后已变化，请重新发起 Worktree handoff')
        }
        const finalStatus = await dependencies.git.status(project.root)
        if (finalStatus.dirty && !verifiedIsolatedProof.dirtyConfirmed) {
          throw new SessionCheckoutError('dirty_confirmation_required', 'Local Checkout 在确认后出现未提交修改，已取消 Worktree handoff')
        }
      }
      // managed Worktree 不再使用全局数量硬上限；生命周期通过交付后清理收口。
      const checkoutId = dependencies.createCheckoutId()
      const repositoryKey = createHash('sha256').update(snapshot.commonDir).digest('hex').slice(0, 10)
      const localRoot = await dependencies.files.canonicalize(project.root)
      const localGitRoot = await dependencies.files.canonicalize(snapshot.root)
      const pathCandidates = createManagedWorktreePathCandidates({
        localGitRoot,
        managedCheckoutsRoot: dependencies.managedCheckoutsRoot,
        repositoryKey,
        sessionId: session.id,
        sessionTitle: session.title,
        checkoutId,
        iteration: nextIteration,
      })
      let managedGitRoot = pathCandidates.fallbackRoot
      const siblingParent = dirname(localGitRoot)
      if (!pathsEqual(siblingParent, localGitRoot)) {
        const outerWorktreeRoot = await dependencies.git.findContainingWorktreeRoot(siblingParent)
        if (!outerWorktreeRoot) {
          try {
            dependencies.files.ensureDirectory(pathCandidates.siblingContainer)
            const containerWorktreeRoot = await dependencies.git.findContainingWorktreeRoot(
              pathCandidates.siblingContainer,
            )
            if (!containerWorktreeRoot) {
              managedGitRoot = pathCandidates.siblingRoot
            } else {
              console.warn(
                `[session-checkout] Worktree 同级容器位于 Git checkout 内，回退到 Domi 数据目录: ${containerWorktreeRoot}`,
              )
            }
          } catch (error) {
            console.warn('[session-checkout] 无法创建 Worktree 同级容器，回退到 Domi 数据目录:', error)
          }
        } else {
          console.warn(
            `[session-checkout] Git 根目录父级属于外层 checkout，回退到 Domi 数据目录: ${outerWorktreeRoot}`,
          )
        }
      }
      dependencies.files.ensureDirectory(dirname(managedGitRoot))
      const projectRelativePath = relative(localGitRoot, localRoot)
      if (projectRelativePath.startsWith('..') || isAbsolute(projectRelativePath)) {
        throw new SessionCheckoutError('checkout_mismatch', '项目根目录不在其 Git checkout 内')
      }
      const managedRoot = join(managedGitRoot, projectRelativePath)
      const seedSnapshot = verifiedIsolatedProof?.seedSnapshot
      const record: ManagedCheckoutRecord = {
        checkoutId,
        projectId: project.id,
        projectName: project.name,
        ownerSessionId: sessionId,
        localRoot,
        managedRoot: resolve(managedRoot),
        managedGitRoot: resolve(managedGitRoot),
        gitCommonDir: snapshot.commonDir,
        gitDir: '',
        baseOid: seedSnapshot?.baseOid ?? snapshot.headOid,
        ...(seedSnapshot?.applyBaseOid ? { applyBaseOid: seedSnapshot.applyBaseOid } : {}),
        sourceRef: seedSnapshot?.sourceRef ?? snapshot.headRef,
        phase: 'preparing',
        delivery: { state: 'working', iteration: nextIteration },
        journal: {
          operation: 'create',
          operationId: dependencies.createCheckoutId(),
          step: 'creating_worktree',
          startedAt: Date.now(),
        },
        revision: 1,
      }
      const binding: SessionBindingRecord = {
        sessionId,
        projectId: project.id,
        projectName: project.name,
        target: { kind: 'isolated', checkoutId },
        ownerSessionId: sessionId,
        sourceRef: seedSnapshot?.sourceRef ?? snapshot.headRef,
        sourceOid: seedSnapshot?.baseOid ?? snapshot.headOid,
        revision: 1,
      }
      const preparingRegistry = dependencies.registry.read()
      preparingRegistry.sessionBindings[sessionId] = binding
      preparingRegistry.managedCheckouts[checkoutId] = record
      preparingRegistry.revision += 1
      dependencies.registry.write(preparingRegistry)

      const createStartedAt = Date.now()
      let createTimingRecorded = false
      try {
        await dependencies.git.createDetachedWorktree(
          localGitRoot,
          managedGitRoot,
          seedSnapshot?.headOid ?? snapshot.headOid,
        )
        const createdAt = Date.now()
        createTimingRecorded = true
        emitTiming({
          phase: 'worktree_create',
          sessionId,
          iteration: nextIteration,
          attempt: createAttempt + 1,
          outcome: 'success',
          timestamp: new Date(createdAt).toISOString(),
          durationMs: Math.max(0, createdAt - createStartedAt),
        })
        const canonicalManagedGitRoot = await dependencies.files.canonicalize(managedGitRoot)
        const canonicalManagedRoot = await dependencies.files.canonicalize(managedRoot)
        const created = await dependencies.git.inspect(canonicalManagedRoot)
        if (
          !created
          || !pathsEqual(created.root, canonicalManagedGitRoot)
          || !pathsEqual(created.commonDir, snapshot.commonDir)
        ) {
          throw new SessionCheckoutError('checkout_mismatch', '新建 checkout 的 Git common dir 不匹配')
        }
        if (seedSnapshot) {
          if (!dependencies.applyEngine.restoreHandoffSnapshot) {
            throw new SessionCheckoutError('operation_not_allowed', '当前 Apply engine 不支持恢复 Fork snapshot')
          }
          const restored = await dependencies.applyEngine.restoreHandoffSnapshot({
            isolatedPath: canonicalManagedRoot,
            expectedHeadOid: seedSnapshot.headOid,
            indexTreeOid: seedSnapshot.indexTreeOid,
            treeOid: seedSnapshot.treeOid,
          })
          if (restored.status === 'error') {
            throw new SessionCheckoutError(
              restored.error.code as SessionCheckoutErrorCode,
              restored.error.message,
            )
          }
          if (
            restored.isolatedFingerprint !== seedSnapshot.fingerprint
            || restored.indexTreeOid !== seedSnapshot.indexTreeOid
            || restored.treeOid !== seedSnapshot.treeOid
          ) {
            throw new SessionCheckoutError('stale_target', '新 Worktree 与源 Fork snapshot 不一致')
          }
        }
        const readyRegistry = dependencies.registry.read()
        const readyRecord: ManagedCheckoutRecord = {
          ...record,
          managedRoot: canonicalManagedRoot,
          managedGitRoot: canonicalManagedGitRoot,
          gitDir: created.gitDir,
          phase: 'ready',
          journal: null,
          revision: record.revision + 1,
        }
        readyRegistry.managedCheckouts[checkoutId] = readyRecord
        readyRegistry.revision += 1
        dependencies.registry.write(readyRegistry)
        const readyAt = Date.now()
        emitTiming({
          phase: 'checkout_bind',
          sessionId,
          iteration: nextIteration,
          attempt: createAttempt + 1,
          outcome: 'success',
          timestamp: new Date(readyAt).toISOString(),
          durationMs: Math.max(0, readyAt - bindStartedAt),
        })
        return inspectIsolated(binding)
      } catch (error) {
        const failedAt = Date.now()
        if (!createTimingRecorded) {
          emitTiming({
            phase: 'worktree_create',
            sessionId,
            iteration: nextIteration,
            attempt: createAttempt + 1,
            outcome: 'error',
            timestamp: new Date(failedAt).toISOString(),
            durationMs: Math.max(0, failedAt - createStartedAt),
          })
        }
        emitTiming({
          phase: 'checkout_bind',
          sessionId,
          iteration: nextIteration,
          attempt: createAttempt + 1,
          outcome: 'error',
          timestamp: new Date(failedAt).toISOString(),
          durationMs: Math.max(0, failedAt - bindStartedAt),
        })
        let partialCheckout: GitCheckoutSnapshot | null = null
        try {
          partialCheckout = await dependencies.git.inspect(managedRoot)
        } catch {
          partialCheckout = null
        }
        if (partialCheckout) {
          markRecoveryRequired(record)
          throw error
        }

        let residueRemoved = false
        try {
          residueRemoved = dependencies.files.removeEmptyDirectoryTree(managedGitRoot)
        } catch {
          residueRemoved = false
        }
        if (!residueRemoved) {
          markRecoveryRequired(record)
          throw new SessionCheckoutError(
            'recovery_required',
            'Worktree 创建失败且残余目录包含未知内容，已保留现场，请查看原因或改用新会话',
          )
        }

        const failedRegistry = dependencies.registry.read()
        delete failedRegistry.managedCheckouts[checkoutId]
        const currentBinding = failedRegistry.sessionBindings[sessionId]
        if (currentBinding?.target.kind === 'isolated' && currentBinding.target.checkoutId === checkoutId) {
          if (replacedDeliveredBinding) {
            failedRegistry.sessionBindings[sessionId] = replacedDeliveredBinding
          } else {
            delete failedRegistry.sessionBindings[sessionId]
          }
        }
        failedRegistry.revision += 1
        dependencies.registry.write(failedRegistry)

        if (createAttempt < 1) {
          return bindTarget(sessionId, choice, verifiedIsolatedProof, createAttempt + 1, requestStartedAt)
        }
        throw new SessionCheckoutError('git_operation_failed', 'Worktree 创建失败，已安全清理残余目录，可直接重试')
      }
  }

  return {
    inspect: inspectAvailable,
    readSessionDeliveries,
    readSessionChangedFiles,
    preflight: (sessionId, expectedRevision) => withBindingLock(
      () => preflightTarget(sessionId, expectedRevision),
      { sessionIds: [sessionId] },
    ),
    runExclusiveSessionMutation: (sessionId, operation) => withBindingLock(async () => (
      operation(await inspectTarget(sessionId, true))
    ), { sessionIds: [sessionId] }),
    bind: (sessionId, choice) => {
      const requestStartedAt = Date.now()
      return withBindingLock(
        () => bindTarget(sessionId, choice, undefined, 0, requestStartedAt),
        { sessionIds: choice.kind === 'inherit' ? [sessionId, choice.parentSessionId] : [sessionId] },
      )
    },
    cloneIsolatedTarget: (sourceSessionId, childSessionId, expectedSourceRevision) => withBindingLock(
      () => cloneIsolatedTarget(sourceSessionId, childSessionId, expectedSourceRevision),
      { sessionIds: [sourceSessionId, childSessionId] },
    ),
    bindVerifiedIsolated: (sessionId, proof) => {
      const requestStartedAt = Date.now()
      return withBindingLock(
        () => bindTarget(sessionId, { kind: 'isolated' }, proof, 0, requestStartedAt),
        { sessionIds: [sessionId] },
      )
    },
    beginNextIteration: (sessionId) => {
      const requestStartedAt = Date.now()
      return withBindingLock(
        () => bindTarget(sessionId, { kind: 'isolated' }, undefined, 0, requestStartedAt),
        { sessionIds: [sessionId] },
      )
    },
    captureSessionHandoff: (sessionId, expectedRevision) => withBindingLock(
      () => captureSessionHandoff(sessionId, expectedRevision),
      { sessionIds: [sessionId] },
    ),
    captureRecoveryHandoff: (sessionId, expectedRevision) => withBindingLock(
      () => captureRecoveryHandoff(sessionId, expectedRevision),
      { sessionIds: [sessionId] },
    ),
    markReadyForReview: (sessionId, input) => withBindingLock(
      () => markReadyForReviewTarget(sessionId, input),
      { sessionIds: [sessionId] },
    ),
    operate: (input) => withBindingLock(
      () => operateTarget(input),
      { sessionIds: [input.sessionId] },
    ),
    // 只读管理列表不占用全局 mutation lock；慢速目录诊断与用户操作互不阻塞。
    listManagedWorktrees,
    inspectManagedWorktreeCleanup,
    bulkCleanupManagedWorktrees: (candidates) => withBindingLock(() => bulkCleanupManagedWorktrees(candidates)),
    manageManagedWorktree: (input) => withBindingLock(
      () => manageManagedWorktree(input),
      { targetKeys: [`isolated:${input.checkoutId}`] },
    ),
    resolveManagedRootForReveal: (checkoutId) => withBindingLock(
      () => resolveManagedRootForReveal(checkoutId),
      { targetKeys: [`isolated:${checkoutId}`] },
    ),
    cleanupExpiredRetained: (now) => withBindingLock(
      () => cleanupExpiredRetained(now),
      { allowConcurrentInspect: true },
    ),
    assertReleaseSession: (sessionId, intent) => withBindingLock(async () => {
      await assertReleaseSession(sessionId, intent)
    }, { sessionIds: [sessionId] }),
    releaseSession: (sessionId, intent) => withBindingLock(
      () => releaseSession(sessionId, intent),
      { sessionIds: [sessionId] },
    ),
    reconcile: () => withBindingLock(reconcile, { allowConcurrentInspect: true }),
    lease: async (sessionId): Promise<CheckoutLease> => {
      const session = requireSession(sessionId)
      if (session.delegationCheckoutReleasedAt !== undefined) {
        throw new SessionCheckoutError(
          'operation_not_allowed',
          '该协作会话已结束并释放 Worktree 占用，不能再访问原 Worktree',
        )
      }
      const binding = await resolveBinding(sessionId)
      if (binding.target.kind === 'local') {
        const project = dependencies.lookup.getProject(binding.projectId)
        if (!project || !dependencies.files.exists(project.root)) {
          throw new SessionCheckoutError('recovery_required', 'Local Checkout 不可访问')
        }
        const cwd = await dependencies.files.canonicalize(project.root)
        return {
          kind: 'local',
          cwd,
          allowedRoot: cwd,
          localRoot: cwd,
          baseOid: binding.sourceOid,
          sourceRef: binding.sourceRef,
          projectId: binding.projectId,
          checkoutId: `local:${binding.projectId}`,
          ownerSessionId: binding.ownerSessionId,
          revision: binding.revision,
        }
      }

      if (binding.target.kind !== 'isolated') {
        throw new SessionCheckoutError('recovery_required', 'Session Target 引用无效')
      }
      const view = await inspectIsolated(binding)
      const record = dependencies.registry.read().managedCheckouts[binding.target.checkoutId]
      if (!record) throw new SessionCheckoutError('checkout_missing', 'Isolated Checkout 记录不存在')
      if (
        (view.checkout.phase === 'ready' && record.delivery.state === 'preview_active')
        || (
          binding.ownerSessionId === sessionId
          && (
            view.checkout.phase === 'discarded'
            || (view.checkout.phase === 'finalized' && record.delivery.state === 'finalized')
            || (view.checkout.phase === 'retained' && record.delivery.state === 'retained')
          )
        )
      ) {
        const committedLocal = record.delivery.state === 'preview_active'
          ? undefined
          : await validateCommittedLocalCheckout(binding, record)
        if (record.delivery.state !== 'preview_active' && !committedLocal) {
          throw new SessionCheckoutError('recovery_required', 'Local Checkout 身份已变化，需要恢复后才能继续')
        }
        const localRoot = committedLocal?.canonicalLocalRoot ?? await dependencies.files.canonicalize(record.localRoot)
        const followupReason = record.delivery.state === 'preview_active'
          ? 'preview_active'
          : record.delivery.state === 'retained'
            ? 'retained'
            : view.checkout.phase === 'discarded' && record.delivery.state !== 'delivered'
              ? 'discarded'
              : 'delivered'
        return {
          kind: 'isolated',
          cwd: localRoot,
          allowedRoot: localRoot,
          localRoot,
          baseOid: record.delivery.state === 'delivered' || record.delivery.state === 'finalized' || record.delivery.state === 'retained'
            ? record.delivery.commitOid ?? record.baseOid
            : record.baseOid,
          sourceRef: record.sourceRef,
          projectId: record.projectId,
          checkoutId: record.checkoutId,
          ownerSessionId: record.ownerSessionId,
          revision: view.revision,
          followupOnly: true,
          followupReason,
        }
      }
      if (view.checkout.phase !== 'ready') {
        throw new SessionCheckoutError('recovery_required', 'Isolated Checkout 需要恢复后才能租用')
      }
      const cwd = await dependencies.files.canonicalize(record.managedRoot)
      const previousReview = record.previousReview
        ?? (record.delivery.state !== 'working' && record.delivery.state !== 'delivered'
          ? projectPreviousReview(record.delivery.review)
          : undefined)
      return {
        kind: 'isolated',
        cwd,
        allowedRoot: cwd,
        localRoot: await dependencies.files.canonicalize(record.localRoot),
        baseOid: record.baseOid,
        deliveryBaseOid: record.baseOid,
        ...(previousReview?.reviewBaseOid ? { reviewBaseOid: previousReview.reviewBaseOid } : {}),
        ...(previousReview?.reviewBaseStrategy ? { reviewBaseStrategy: previousReview.reviewBaseStrategy } : {}),
        ...(previousReview?.reviewLocalHeadOid ? { reviewLocalHeadOid: previousReview.reviewLocalHeadOid } : {}),
        ...(previousReview ? {
          previousReview: {
            reviewId: previousReview.reviewId,
            iteration: previousReview.iteration,
            summary: previousReview.summary,
            suggestedCommitMessage: previousReview.suggestedCommitMessage,
            changedFiles: previousReview.changedFiles.slice(0, 50),
            ...(previousReview.reviewBaseOid ? { reviewBaseOid: previousReview.reviewBaseOid } : {}),
            ...(previousReview.reviewBaseStrategy ? { reviewBaseStrategy: previousReview.reviewBaseStrategy } : {}),
            ...(previousReview.reviewLocalHeadOid ? { reviewLocalHeadOid: previousReview.reviewLocalHeadOid } : {}),
          },
        } : {}),
        sourceRef: record.sourceRef,
        projectId: record.projectId,
        checkoutId: record.checkoutId,
        ownerSessionId: record.ownerSessionId,
        revision: view.revision,
        ...((record.checkpoints?.length ?? 0) > 0 ? { checkpointCount: record.checkpoints!.length } : {}),
      }
    },
  }
}
