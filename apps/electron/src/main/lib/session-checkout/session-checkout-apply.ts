import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import type { ApplyBaseStrategy } from '@domi/shared'

export interface ApplyPlanInput {
  baseOid: string
  isolatedPath: string
  localPath: string
}

export interface ApplyPlan {
  revision: string
  localFingerprint: string
  isolatedFingerprint: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localHeadOid: string
  /** null 表示 Local 当前为 detached HEAD；Apply 允许，Finish 会拒绝自动提交。 */
  localHeadRef: string | null
  isolatedHeadOid: string
  changedFiles: string[]
}

export interface ReviewSnapshotResult {
  status: 'ready'
  isolatedFingerprint: string
  isolatedHeadOid: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localHeadOid: string
  changedFiles: string[]
}

export type InspectReviewResult = ReviewSnapshotResult | ApplyPlanErrorResult

export interface CaptureHandoffSnapshotInput {
  isolatedPath: string
  baseOid: string
}

export interface CaptureHandoffSnapshotSuccessResult {
  status: 'captured'
  isolatedFingerprint: string
  isolatedHeadOid: string
  indexTreeOid: string
  treeOid: string
  changedFiles: string[]
}

export type CaptureHandoffSnapshotResult = CaptureHandoffSnapshotSuccessResult | ApplyPlanErrorResult

export interface RestoreHandoffSnapshotInput {
  isolatedPath: string
  expectedHeadOid: string
  indexTreeOid: string
  treeOid: string
}

export interface RestoreHandoffSnapshotSuccessResult {
  status: 'restored'
  isolatedFingerprint: string
  indexTreeOid: string
  treeOid: string
}

export type RestoreHandoffSnapshotResult = RestoreHandoffSnapshotSuccessResult | ApplyPlanErrorResult

export interface ApplyReadyPlanResult {
  status: 'ready'
  plan: ApplyPlan
}

export interface ApplyConflictPlanResult {
  status: 'conflict'
  revision: string
  localFingerprint: string
  isolatedFingerprint: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  /** 冲突计算时的真实 Local HEAD，供 Isolated Agent 在当前 Worktree 内同步并解决冲突。 */
  localHeadOid: string
  isolatedHeadOid: string
  conflictingFiles: string[]
}

export interface ApplyPlanErrorResult {
  status: 'error'
  error: ApplyError
}

export type ApplyPlanResult = ApplyReadyPlanResult | ApplyConflictPlanResult | ApplyPlanErrorResult

export interface ApplySuccessResult {
  status: 'applied'
  changedFiles: string[]
  /** 本次已整合的 Isolated 快照 commit；不创建 ref，仅供后续 Apply 作为内部基线。 */
  nextBaseOid: string
}

export interface ApplyErrorResult {
  status: 'error'
  error: ApplyError
}

export type ApplyResult = ApplySuccessResult | ApplyErrorResult

export interface FinishSuccessResult {
  status: 'finished'
  changedFiles: string[]
  /** 实际创建任务 Commit 时使用的实时 Local parent；HEAD 前进后可能不同于 Preview receipt。 */
  localHeadBefore?: string
  /** null 表示 Worktree 与 Local 已一致，没有创建空提交。 */
  commitOid: string | null
  /** 本次已整合的 Isolated 快照，供清理未完成时后续 Apply 去重。 */
  nextBaseOid: string
}

export type FinishResult = FinishSuccessResult | ApplyErrorResult

export interface PreviewReceipt {
  previewId: string
  reviewId: string
  iteration: number
  previewedAt: number
  configuredBaseOid: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localHeadOid: string
  localHeadRef: string | null
  localFingerprintBefore: string
  localFingerprintPreview: string
  localWorkingTreeOid: string
  localIndexTreeOid: string
  previewWorkingTreeOid: string
  isolatedHeadOid: string
  isolatedFingerprint: string
  isolatedSnapshotOid: string
  changedFiles: string[]
}

export interface PreviewSuccessResult {
  status: 'previewed'
  receipt: PreviewReceipt
  changedFiles: string[]
}

export type PreviewResult = PreviewSuccessResult | ApplyErrorResult

export interface RollbackSuccessResult {
  status: 'preview_rolled_back'
  changedFiles: string[]
}

export interface RollbackCommittedResult {
  status: 'preview_committed'
  changedFiles: string[]
  commitOid: string
}

export interface PreviewActiveResult {
  status: 'preview_active'
  changedFiles: string[]
}

export type PreviewInspectionResult = PreviewActiveResult | RollbackCommittedResult | ApplyErrorResult
export type RollbackResult = RollbackSuccessResult | RollbackCommittedResult | ApplyErrorResult

export interface CheckpointInput {
  isolatedPath: string
  expectedFingerprint: string
  expectedHeadOid: string
  commitMessage: string
  /** Commit object 已创建但 detached HEAD/index 尚未切换时持久化恢复信息。 */
  beforeCommit?(prepared: { commitOid: string; parentOid: string; indexTreeOid: string; changedFiles: string[] }): Promise<void>
}

export interface CheckpointSuccessResult {
  status: 'checkpointed'
  commitOid: string
  parentOid: string
  changedFiles: string[]
  isolatedFingerprint: string
}

export type CheckpointResult = CheckpointSuccessResult | ApplyErrorResult

export interface CheckpointRecoverySuccessResult {
  status: 'checkpoint_recovered' | 'checkpoint_aborted'
  isolatedFingerprint: string
}

export type CheckpointRecoveryResult = CheckpointRecoverySuccessResult | ApplyErrorResult

export interface InvalidInputApplyError {
  code: 'invalid_input'
  message: string
}

export interface InvalidPlanApplyError {
  code: 'invalid_plan'
  message: string
}

export interface StaleLocalApplyError {
  code: 'stale_local'
  message: string
}

export interface StaleIsolatedApplyError {
  code: 'stale_isolated'
  message: string
}

export interface GitApplyError {
  code: 'git_error'
  message: string
}

export interface CommitIsolationApplyError {
  code: 'commit_isolation_conflict'
  message: string
  localHeadOid?: string
  conflictingFiles?: string[]
}

export interface OperationNotAllowedApplyError {
  code: 'operation_not_allowed'
  message: string
}

export interface PreviewModifiedApplyError {
  code: 'preview_modified'
  message: string
  localHeadOid?: string
  conflictingFiles?: string[]
}

export type ApplyError =
  | InvalidInputApplyError
  | InvalidPlanApplyError
  | StaleLocalApplyError
  | StaleIsolatedApplyError
  | GitApplyError
  | CommitIsolationApplyError
  | OperationNotAllowedApplyError
  | PreviewModifiedApplyError

export interface SessionCheckoutApplyEngine {
  inspectReview(input: ApplyPlanInput): Promise<InspectReviewResult>
  captureHandoffSnapshot?(input: CaptureHandoffSnapshotInput): Promise<CaptureHandoffSnapshotResult>
  restoreHandoffSnapshot?(input: RestoreHandoffSnapshotInput): Promise<RestoreHandoffSnapshotResult>
  checkpoint(input: CheckpointInput): Promise<CheckpointResult>
  recoverCheckpoint(input: { isolatedPath: string; commitOid: string; parentOid: string; expectedIndexTreeOid: string }): Promise<CheckpointRecoveryResult>
  /** 复用真实 Apply merge 计算，但不持久化可执行 plan，也不修改任一 checkout。 */
  preflight(input: ApplyPlanInput): Promise<ApplyPlanResult>
  plan(input: ApplyPlanInput): Promise<ApplyPlanResult>
  apply(plan: ApplyPlan): Promise<ApplyResult>
  finish(plan: ApplyPlan, options: { commitMessage: string }): Promise<FinishResult>
  preview(plan: ApplyPlan, options: {
    previewId: string
    reviewId: string
    iteration: number
    /** Local 写入前持久化 receipt artifacts/journal；失败时不得触碰 Local。 */
    beforeWrite?(receipt: PreviewReceipt): Promise<void>
  }): Promise<PreviewResult>
  inspectPreview(input: { localPath: string; receipt: PreviewReceipt }): Promise<PreviewInspectionResult>
  rollback(input: { localPath: string; receipt: PreviewReceipt }): Promise<RollbackResult>
  finalize(input: {
    localPath: string
    receipt: PreviewReceipt
    commitMessage: string
    /** Commit object 已创建但 branch ref 尚未更新时持久化恢复信息。 */
    beforeCommit?(commitOid: string): Promise<void>
  }): Promise<FinishResult>
}

export interface SessionCheckoutApplyEngineOptions {
  /** 测试/宿主 seam：在最后一次 Local fingerprint 校验前执行。 */
  beforeFinalLocalValidation?(): Promise<void> | void
}

interface GitResult {
  exitCode: number
  stdout: Buffer
  stderr: string
}

interface CheckoutSnapshot {
  fingerprint: string
  headOid: string
  headRef: string | null
  headTreeOid: string
  indexTreeOid: string
  treeOid: string
}

interface ApplyScope {
  isolatedGitRoot: string
  localGitRoot: string
  projectPrefix: string
  sourceObjects: string
}

interface StoredPlan {
  input: ApplyPlanInput
  patch: Buffer
  plan: ApplyPlan
  scope: ApplyScope
}

interface MergeReadyResult {
  status: 'ready'
  changedFiles: string[]
  patch: Buffer
  mergedTreeOid: string
}

interface MergeConflictResult {
  status: 'conflict'
  conflictingFiles: string[]
}

type MergeResult = MergeReadyResult | MergeConflictResult

interface TreeMergeReadyResult {
  status: 'ready'
  treeOid: string
}

type TreeMergeResult = TreeMergeReadyResult | MergeConflictResult

class GitCommandFailure extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(result.stderr || `git 命令退出码为 ${result.exitCode}`)
  }
}

const GIT_TIMEOUT_MS = 30_000
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer | string; allowedExitCodes?: number[] } = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolveResult, reject) => {
    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    const finish = (error: Error | null, result?: GitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (result) resolveResult(result)
    }

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (exitCode) => {
      const result: GitResult = {
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
      }
      const allowed = options.allowedExitCodes ?? [0]
      finish(allowed.includes(result.exitCode) ? null : new GitCommandFailure(args, result), result)
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error(`git 命令超时：${args[0] ?? 'unknown'}`))
    }, GIT_TIMEOUT_MS)

    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function stdoutText(result: GitResult): string {
  return result.stdout.toString('utf8').trim()
}

function parseNullSeparated(output: Buffer): string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0)
}

function gitObjectEnvironment(objectDirectory: string, sourceObjectDirectory: string): NodeJS.ProcessEnv {
  const existingAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return {
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [sourceObjectDirectory, existingAlternates]
      .filter((value): value is string => Boolean(value))
      .join(delimiter),
  }
}

async function sourceObjectDirectory(checkoutPath: string): Promise<string> {
  const output = stdoutText(await runGit(checkoutPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']))
  return resolve(checkoutPath, output)
}

async function resolveGitRoot(checkoutPath: string): Promise<string> {
  const output = stdoutText(await runGit(checkoutPath, ['rev-parse', '--show-toplevel']))
  return resolve(checkoutPath, output)
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(resolve(path))
  } catch {
    return resolve(path)
  }
}

function projectPrefix(gitRoot: string, projectRoot: string): string | null {
  const prefix = relative(canonicalExistingPath(gitRoot), canonicalExistingPath(projectRoot))
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
  if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) return null
  return prefix
}

function isProjectPath(repoPath: string, prefix: string): boolean {
  return !prefix || repoPath.startsWith(`${prefix}/`)
}

function toProjectPath(repoPath: string, prefix: string): string {
  return prefix ? repoPath.slice(prefix.length + 1) : repoPath
}

function toRepositoryPaths(projectPaths: readonly string[], prefix: string): string[] {
  return projectPaths.map((path) => prefix ? `${prefix}/${path}` : path)
}

interface EffectiveApplyBase {
  oid: string
  strategy: ApplyBaseStrategy
}

async function isAncestor(checkoutPath: string, olderOid: string, newerOid: string): Promise<boolean> {
  const result = await runGit(
    checkoutPath,
    ['merge-base', '--is-ancestor', olderOid, newerOid],
    { allowedExitCodes: [0, 1] },
  )
  return result.exitCode === 0
}

const INTERNAL_APPLY_SNAPSHOT_SUBJECTS = new Set([
  'Applied Isolated snapshot',
  'Previewed Isolated snapshot',
  'Finished Isolated snapshot',
])

async function internalApplySnapshotParent(checkoutPath: string, oid: string): Promise<string | null> {
  const result = await runGit(checkoutPath, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%s%x00%P', oid])
  const [authorName, authorEmail, committerName, committerEmail, subject, parents = ''] = stdoutText(result).split('\0')
  if (
    authorName !== 'Domi Apply'
    || authorEmail !== 'domi-apply@localhost'
    || committerName !== 'Domi Apply'
    || committerEmail !== 'domi-apply@localhost'
    || subject === undefined
    || !INTERNAL_APPLY_SNAPSHOT_SUBJECTS.has(subject)
  ) return null
  const parentOids = parents.trim().split(/\s+/).filter(Boolean)
  return parentOids.length === 1 ? parentOids[0]! : null
}

async function uniqueSharedMergeBase(
  checkoutPath: string,
  localHeadOid: string,
  isolatedHeadOid: string,
): Promise<string | null> {
  const result = await runGit(
    checkoutPath,
    ['merge-base', '--all', localHeadOid, isolatedHeadOid],
    { allowedExitCodes: [0, 1] },
  )
  if (result.exitCode === 1) return null

  const candidates = stdoutText(result).split(/\r?\n/).map((oid) => oid.trim()).filter(Boolean)
  const businessCandidates = new Set<string>()
  for (const candidate of candidates) {
    let current = candidate
    const visited = new Set<string>()
    while (!visited.has(current)) {
      visited.add(current)
      const parent = await internalApplySnapshotParent(checkoutPath, current)
      if (!parent) break
      current = parent
    }
    businessCandidates.add(current)
  }
  return businessCandidates.size === 1 ? [...businessCandidates][0]! : null
}

async function selectEffectiveApplyBase(
  checkoutPath: string,
  recordedBaseOid: string,
  localHeadOid: string,
  isolatedHeadOid: string,
): Promise<EffectiveApplyBase> {
  // Worktree 若已明确整合当前 Local HEAD，只需证明 recorded base 仍属于 Worktree 的任务历史。
  // Local 可能因 reset/rebase/force update 不再包含旧 Session Base；继续要求 recorded base 位于
  // Local 历史会让冲突解决后的下一次预检退回旧基线，并重复报告同一批冲突。
  const recordedInIsolated = await isAncestor(checkoutPath, recordedBaseOid, isolatedHeadOid)
  const localInIsolated = await isAncestor(checkoutPath, localHeadOid, isolatedHeadOid)
  if (recordedInIsolated && localInIsolated) {
    return { oid: localHeadOid, strategy: 'isolated_contains_local_head' }
  }

  const recordedInLocal = await isAncestor(checkoutPath, recordedBaseOid, localHeadOid)
  const isolatedInLocal = await isAncestor(checkoutPath, isolatedHeadOid, localHeadOid)
  if (recordedInLocal && recordedInIsolated && isolatedInLocal) {
    return { oid: isolatedHeadOid, strategy: 'local_contains_isolated_head' }
  }

  // Apply snapshot 是内容去重锚点，不是双方共享的业务提交。HEAD 仍在线性关系中时保留它的
  // 增量语义；一旦双方历史分叉，就只能从真实 Git 拓扑重新选择共同基线。
  if (localInIsolated || isolatedInLocal) {
    return { oid: recordedBaseOid, strategy: 'recorded_base' }
  }

  const mergeBaseOid = await uniqueSharedMergeBase(checkoutPath, localHeadOid, isolatedHeadOid)
  if (mergeBaseOid) {
    return mergeBaseOid === recordedBaseOid
      ? { oid: recordedBaseOid, strategy: 'recorded_base' }
      : { oid: mergeBaseOid, strategy: 'shared_merge_base' }
  }
  // 无共同祖先或存在多个同等 merge-base 时不猜测，保留 recorded-base 的既有 fail-closed 语义。
  return { oid: recordedBaseOid, strategy: 'recorded_base' }
}

async function changedTreePaths(
  checkoutPath: string,
  baseOid: string,
  treeOid: string,
  objectDirectory: string | null,
  sourceObjects: string | null,
): Promise<string[]> {
  const result = await runGit(
    checkoutPath,
    ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', baseOid, treeOid, '--'],
    { env: objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : undefined },
  )
  return parseNullSeparated(result.stdout)
}

async function findCommitWithTree(
  checkoutPath: string,
  ancestorOid: string,
  descendantOid: string,
  treeOid: string,
): Promise<string | null> {
  const ancestry = await runGit(checkoutPath, ['merge-base', '--is-ancestor', ancestorOid, descendantOid], { allowedExitCodes: [0, 1] })
  if (ancestry.exitCode !== 0) return null
  const history = stdoutText(await runGit(checkoutPath, ['log', '--format=%H:%T', `${ancestorOid}..${descendantOid}`]))
  for (const line of history.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const commitOid = line.slice(0, separator)
    const commitTreeOid = line.slice(separator + 1)
    if (commitTreeOid === treeOid) return commitOid
  }
  return null
}

async function captureSnapshot(
  checkoutPath: string,
  indexPath: string,
  objectDirectory: string | null,
  sourceObjects: string | null,
  forceIncludePaths: readonly string[] = [],
): Promise<CheckoutSnapshot> {
  const headOid = stdoutText(await runGit(checkoutPath, ['rev-parse', 'HEAD']))
  const headTreeOid = stdoutText(await runGit(checkoutPath, ['rev-parse', `${headOid}^{tree}`]))
  const symbolic = await runGit(checkoutPath, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
  const headRef = symbolic.exitCode === 0 ? stdoutText(symbolic) : null
  const indexEntries = (await runGit(checkoutPath, ['ls-files', '--stage', '-z'])).stdout
  const stagedPatch = (
    await runGit(checkoutPath, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      headOid,
      '--',
    ])
  ).stdout
  const env: NodeJS.ProcessEnv = {
    ...(objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : {}),
    GIT_INDEX_FILE: indexPath,
  }

  await runGit(checkoutPath, ['read-tree', headOid], { env })
  if (stagedPatch.length > 0) {
    await runGit(checkoutPath, ['apply', '--cached', '--binary', '--whitespace=nowarn'], {
      env,
      input: stagedPatch,
    })
  }
  const indexTreeOid = stdoutText(await runGit(checkoutPath, ['write-tree'], { env }))
  // 先还原真实 index 的 staged 语义，再叠加 working tree，得到完整最终状态。
  await runGit(checkoutPath, ['add', '-A', '--', '.'], { env })
  const forceIncludedExistingPaths = forceIncludePaths.filter((path) => existsSync(join(checkoutPath, path)))
  if (forceIncludedExistingPaths.length > 0) {
    // Local 与 Isolated 的 ignore 规则可能不同；任务明确写入且仍存在的路径必须进入验收快照。
    // 删除已经由上面的 add -A 记录，不能再次作为 pathspec 传入，否则 Git 会因路径不存在而拒绝。
    await runGit(checkoutPath, ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env,
      input: Buffer.from(`${forceIncludedExistingPaths.join('\0')}\0`),
    })
  }
  const treeOid = stdoutText(await runGit(checkoutPath, ['write-tree'], { env }))
  const fingerprint = createHash('sha256')
    .update(headOid)
    .update('\0')
    .update(headRef ?? 'DETACHED')
    .update('\0')
    .update(indexEntries)
    .update('\0')
    .update(treeOid)
    .digest('hex')

  return { fingerprint, headOid, headRef, headTreeOid, indexTreeOid, treeOid }
}

async function createSnapshotCommit(
  checkoutPath: string,
  treeOid: string,
  parentOid: string | null,
  objectDirectory: string | null,
  sourceObjects: string | null,
  label: string,
): Promise<string> {
  const args = ['commit-tree', treeOid, ...(parentOid ? ['-p', parentOid] : [])]
  const result = await runGit(checkoutPath, args, {
    env: {
      ...(objectDirectory && sourceObjects ? gitObjectEnvironment(objectDirectory, sourceObjects) : {}),
      GIT_AUTHOR_NAME: 'Domi Apply',
      GIT_AUTHOR_EMAIL: 'domi-apply@localhost',
      GIT_COMMITTER_NAME: 'Domi Apply',
      GIT_COMMITTER_EMAIL: 'domi-apply@localhost',
    },
    input: `${label}\n`,
  })
  return stdoutText(result)
}

async function computeMerge(
  tempRoot: string,
  sourceObjects: string,
  objectDirectory: string,
  baseOid: string,
  local: CheckoutSnapshot,
  isolated: CheckoutSnapshot,
  checkoutPath: string,
  projectPathPrefix: string,
): Promise<MergeResult> {
  const localCommit = await createSnapshotCommit(
    checkoutPath,
    local.treeOid,
    baseOid,
    objectDirectory,
    sourceObjects,
    'Local snapshot',
  )
  const isolatedCommit = await createSnapshotCommit(
    checkoutPath,
    isolated.treeOid,
    baseOid,
    objectDirectory,
    sourceObjects,
    'Isolated snapshot',
  )
  const mergePath = join(tempRoot, 'merge checkout')
  const hooksPath = join(tempRoot, 'disabled hooks')
  await mkdir(mergePath, { recursive: true })
  await mkdir(hooksPath, { recursive: true })
  await runGit(mergePath, ['init', '--template='])
  await runGit(mergePath, ['config', 'core.autocrlf', 'false'])
  await runGit(mergePath, ['config', 'core.hooksPath', hooksPath])
  await runGit(mergePath, ['config', 'user.name', 'Domi Apply'])
  await runGit(mergePath, ['config', 'user.email', 'domi-apply@localhost'])

  const mergeEnv: NodeJS.ProcessEnv = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectDirectory, sourceObjects].join(delimiter),
  }
  await runGit(mergePath, ['checkout', '--detach', localCommit], { env: mergeEnv })
  const merge = await runGit(mergePath, ['merge', '--no-commit', '--no-ff', isolatedCommit], {
    env: mergeEnv,
    allowedExitCodes: [0, 1],
  })

  if (merge.exitCode === 1) {
    const conflicts = await runGit(mergePath, ['diff', '--name-only', '--diff-filter=U', '-z'], { env: mergeEnv })
    const conflictingFiles = parseNullSeparated(conflicts.stdout)
      .filter((path) => isProjectPath(path, projectPathPrefix))
      .map((path) => toProjectPath(path, projectPathPrefix))
      .sort()
    if (conflictingFiles.length === 0) throw new GitCommandFailure(['merge'], merge)
    return { status: 'conflict', conflictingFiles }
  }

  const mergedTree = stdoutText(await runGit(mergePath, ['write-tree'], { env: mergeEnv }))
  const changed = await runGit(
    mergePath,
    ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', local.treeOid, mergedTree, '--'],
    { env: mergeEnv },
  )
  const patch = (
    await runGit(
      mergePath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        local.treeOid,
        mergedTree,
        '--',
      ],
      { env: mergeEnv },
    )
  ).stdout
  const changedFiles = parseNullSeparated(changed.stdout)
    .filter((path) => isProjectPath(path, projectPathPrefix))
    .map((path) => toProjectPath(path, projectPathPrefix))
    .sort()
  const centralIndex = join(tempRoot, 'merged-central.index')
  const centralEnv: NodeJS.ProcessEnv = {
    ...gitObjectEnvironment(objectDirectory, sourceObjects),
    GIT_INDEX_FILE: centralIndex,
  }
  await runGit(checkoutPath, ['read-tree', local.treeOid], { env: centralEnv })
  if (patch.length > 0) {
    await runGit(checkoutPath, ['apply', '--cached', '--binary', '--whitespace=nowarn'], {
      env: centralEnv,
      input: patch,
    })
  }
  const centralMergedTree = stdoutText(await runGit(checkoutPath, ['write-tree'], { env: centralEnv }))
  return { status: 'ready', changedFiles, patch, mergedTreeOid: centralMergedTree }
}

async function computeTreeMerge(
  tempRoot: string,
  sourceObjects: string,
  objectDirectory: string,
  checkoutPath: string,
  label: string,
  baseTreeOid: string,
  oursTreeOid: string,
  theirsTreeOid: string,
): Promise<TreeMergeResult> {
  const baseCommit = await createSnapshotCommit(
    checkoutPath,
    baseTreeOid,
    null,
    objectDirectory,
    sourceObjects,
    `${label} base`,
  )
  const oursCommit = await createSnapshotCommit(
    checkoutPath,
    oursTreeOid,
    baseCommit,
    objectDirectory,
    sourceObjects,
    `${label} ours`,
  )
  const theirsCommit = await createSnapshotCommit(
    checkoutPath,
    theirsTreeOid,
    baseCommit,
    objectDirectory,
    sourceObjects,
    `${label} theirs`,
  )
  const mergePath = join(tempRoot, label.replace(/[^a-z0-9_-]+/gi, '-'))
  const hooksPath = join(tempRoot, `${label}-disabled-hooks`.replace(/[^a-z0-9_-]+/gi, '-'))
  await mkdir(mergePath, { recursive: true })
  await mkdir(hooksPath, { recursive: true })
  await runGit(mergePath, ['init', '--template='])
  await runGit(mergePath, ['config', 'core.autocrlf', 'false'])
  await runGit(mergePath, ['config', 'core.hooksPath', hooksPath])
  await runGit(mergePath, ['config', 'user.name', 'Domi Apply'])
  await runGit(mergePath, ['config', 'user.email', 'domi-apply@localhost'])

  const env: NodeJS.ProcessEnv = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectDirectory, sourceObjects].join(delimiter),
  }
  await runGit(mergePath, ['checkout', '--detach', oursCommit], { env })
  const merge = await runGit(mergePath, ['merge', '--no-commit', '--no-ff', theirsCommit], {
    env,
    allowedExitCodes: [0, 1],
  })
  if (merge.exitCode === 1) {
    const conflicts = await runGit(mergePath, ['diff', '--name-only', '--diff-filter=U', '-z'], { env })
    const conflictingFiles = parseNullSeparated(conflicts.stdout).sort()
    if (conflictingFiles.length === 0) throw new GitCommandFailure(['merge'], merge)
    return { status: 'conflict', conflictingFiles }
  }
  const mergedTreeOid = stdoutText(await runGit(mergePath, ['write-tree'], { env }))
  const mergedPatch = (
    await runGit(
      mergePath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        oursTreeOid,
        mergedTreeOid,
        '--',
      ],
      { env },
    )
  ).stdout
  const centralIndex = join(tempRoot, `${label}-central.index`.replace(/[^a-z0-9_.-]+/gi, '-'))
  const centralEnv: NodeJS.ProcessEnv = {
    ...gitObjectEnvironment(objectDirectory, sourceObjects),
    GIT_INDEX_FILE: centralIndex,
  }
  await runGit(checkoutPath, ['read-tree', oursTreeOid], { env: centralEnv })
  if (mergedPatch.length > 0) {
    await runGit(checkoutPath, ['apply', '--cached', '--binary', '--whitespace=nowarn'], {
      env: centralEnv,
      input: mergedPatch,
    })
  }
  return { status: 'ready', treeOid: stdoutText(await runGit(checkoutPath, ['write-tree'], { env: centralEnv })) }
}

async function treePatch(
  checkoutPath: string,
  fromTreeOid: string,
  toTreeOid: string,
  objectDirectory: string,
  sourceObjects: string,
): Promise<Buffer> {
  return (
    await runGit(
      checkoutPath,
      [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        fromTreeOid,
        toTreeOid,
        '--',
      ],
      { env: gitObjectEnvironment(objectDirectory, sourceObjects) },
    )
  ).stdout
}

function pathsMatch(left: string, right: string): boolean {
  const normalizedLeft = canonicalExistingPath(left)
  const normalizedRight = canonicalExistingPath(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function planMatches(stored: ApplyPlan, supplied: ApplyPlan): boolean {
  return stored.revision === supplied.revision
    && stored.localFingerprint === supplied.localFingerprint
    && stored.isolatedFingerprint === supplied.isolatedFingerprint
    && stored.effectiveBaseOid === supplied.effectiveBaseOid
    && stored.baseStrategy === supplied.baseStrategy
    && stored.localHeadOid === supplied.localHeadOid
    && stored.localHeadRef === supplied.localHeadRef
    && stored.isolatedHeadOid === supplied.isolatedHeadOid
    && stored.changedFiles.length === supplied.changedFiles.length
    && stored.changedFiles.every((path, index) => path === supplied.changedFiles[index])
}

async function prepareIndexFromPatch(
  checkoutPath: string,
  indexPath: string,
  baseOid: string,
  patch: Buffer,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexPath }
  await runGit(checkoutPath, ['read-tree', baseOid], { env })
  if (patch.length > 0) {
    await runGit(checkoutPath, ['apply', '--cached', '--binary', '--whitespace=nowarn'], { env, input: patch })
  }
  return stdoutText(await runGit(checkoutPath, ['write-tree'], { env }))
}

async function createUserCommit(
  checkoutPath: string,
  treeOid: string,
  parentOid: string,
  commitMessage: string,
): Promise<string> {
  return stdoutText(await runGit(
    checkoutPath,
    ['commit-tree', treeOid, '-p', parentOid],
    { input: `${commitMessage.trim()}\n` },
  ))
}

async function resolveIndexPath(checkoutPath: string): Promise<string> {
  return resolve(checkoutPath, stdoutText(await runGit(
    checkoutPath,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
  )))
}

async function inspectIndexFileTree(checkoutPath: string, indexPath: string): Promise<{ exists: false } | { exists: true; treeOid: string | null }> {
  try {
    const handle = await open(indexPath, 'r')
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
  try {
    const treeOid = stdoutText(await runGit(checkoutPath, ['write-tree'], { env: { GIT_INDEX_FILE: indexPath } }))
    return { exists: true, treeOid }
  } catch {
    return { exists: true, treeOid: null }
  }
}

async function checkpointLockMarkerOwned(markerPath: string, commitOid: string): Promise<boolean> {
  try {
    return (await readFile(markerPath, 'utf8')).trim() === commitOid
  } catch {
    return false
  }
}

async function removeBestEffort(path: string | null): Promise<void> {
  if (!path) return
  try {
    await unlink(path)
  } catch {
    // 临时 index 不存在或已完成 rename 时无需处理。
  }
}

class DefaultSessionCheckoutApplyEngine implements SessionCheckoutApplyEngine {
  private readonly plans = new Map<string, StoredPlan>()

  constructor(private readonly options: SessionCheckoutApplyEngineOptions) {}

  async captureHandoffSnapshot(input: CaptureHandoffSnapshotInput): Promise<CaptureHandoffSnapshotResult> {
    if (!OID_PATTERN.test(input.baseOid)) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Session handoff base OID 无效' } }
    }
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-session-handoff-'))
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const projectPathPrefix = projectPrefix(isolatedGitRoot, input.isolatedPath)
      if (projectPathPrefix === null) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Session handoff 项目目录不属于当前 Worktree' } }
      }
      await runGit(isolatedGitRoot, ['cat-file', '-e', `${input.baseOid}^{commit}`])
      const snapshot = await captureSnapshot(isolatedGitRoot, join(tempRoot, 'snapshot.index'), null, null)
      const changedPaths = await changedTreePaths(isolatedGitRoot, input.baseOid, snapshot.treeOid, null, null)
      if (changedPaths.some((path) => !isProjectPath(path, projectPathPrefix))) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Worktree 包含项目根目录外的变更，不能交接' } }
      }
      return {
        status: 'captured',
        isolatedFingerprint: snapshot.fingerprint,
        isolatedHeadOid: snapshot.headOid,
        indexTreeOid: snapshot.indexTreeOid,
        treeOid: snapshot.treeOid,
        changedFiles: changedPaths.map((path) => toProjectPath(path, projectPathPrefix)).sort(),
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    }
  }

  async restoreHandoffSnapshot(input: RestoreHandoffSnapshotInput): Promise<RestoreHandoffSnapshotResult> {
    if (
      !OID_PATTERN.test(input.expectedHeadOid)
      || !OID_PATTERN.test(input.indexTreeOid)
      || !OID_PATTERN.test(input.treeOid)
    ) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Session handoff snapshot OID 无效' } }
    }

    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-session-handoff-restore-'))
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const headOid = stdoutText(await runGit(isolatedGitRoot, ['rev-parse', 'HEAD']))
      const symbolic = await runGit(isolatedGitRoot, ['symbolic-ref', '--quiet', 'HEAD'], { allowedExitCodes: [0, 1] })
      if (headOid !== input.expectedHeadOid || symbolic.exitCode === 0) {
        return { status: 'error', error: { code: 'stale_isolated', message: '目标 Worktree HEAD 与 handoff snapshot 不一致' } }
      }
      const dirty = (await runGit(isolatedGitRoot, ['status', '--porcelain=v1', '-z'])).stdout.length > 0
      if (dirty) {
        return { status: 'error', error: { code: 'stale_isolated', message: '目标 Worktree 在恢复 snapshot 前已发生变化' } }
      }

      await runGit(isolatedGitRoot, ['read-tree', '--reset', '-u', input.treeOid])
      await runGit(isolatedGitRoot, ['read-tree', input.indexTreeOid])

      const restored = await captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'restored.index'),
        null,
        null,
      )
      if (
        restored.headOid !== input.expectedHeadOid
        || restored.headRef !== null
        || restored.indexTreeOid !== input.indexTreeOid
        || restored.treeOid !== input.treeOid
      ) {
        return { status: 'error', error: { code: 'stale_isolated', message: '目标 Worktree 未能完整恢复 handoff snapshot' } }
      }
      return {
        status: 'restored',
        isolatedFingerprint: restored.fingerprint,
        indexTreeOid: restored.indexTreeOid,
        treeOid: restored.treeOid,
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    }
  }

  async checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
    const commitMessage = input.commitMessage.trim()
    if (!commitMessage || !OID_PATTERN.test(input.expectedHeadOid) || !input.expectedFingerprint.trim()) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Checkpoint 输入无效' } }
    }

    let tempRoot: string | null = null
    let adjacentIndex: string | null = null
    let indexLockMarker: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-checkpoint-'))
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const projectPathPrefix = projectPrefix(isolatedGitRoot, input.isolatedPath)
      if (projectPathPrefix === null) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Checkpoint 项目目录不属于当前 Worktree' } }
      }
      const snapshot = await captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'checkpoint.index'),
        null,
        null,
      )
      if (snapshot.headRef !== null) {
        return { status: 'error', error: { code: 'operation_not_allowed', message: 'Checkpoint 只允许写入 detached managed Worktree' } }
      }
      if (snapshot.headOid !== input.expectedHeadOid || snapshot.fingerprint !== input.expectedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Worktree 在准备验收后发生变化，不能保存阶段' } }
      }
      const changedPaths = await changedTreePaths(isolatedGitRoot, snapshot.headOid, snapshot.treeOid, null, null)
      if (changedPaths.some((path) => !isProjectPath(path, projectPathPrefix))) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Worktree 包含项目根目录外的变更，不能保存阶段' } }
      }
      const changedFiles = changedPaths.map((path) => toProjectPath(path, projectPathPrefix)).sort()
      if (changedFiles.length === 0) {
        return { status: 'error', error: { code: 'operation_not_allowed', message: '当前阶段没有可保存的新修改' } }
      }

      const commitOid = await createUserCommit(isolatedGitRoot, snapshot.treeOid, snapshot.headOid, commitMessage)
      await input.beforeCommit?.({ commitOid, parentOid: snapshot.headOid, indexTreeOid: snapshot.indexTreeOid, changedFiles })

      const finalIndexPath = join(tempRoot, 'clean.index')
      await prepareIndexFromPatch(isolatedGitRoot, finalIndexPath, commitOid, Buffer.alloc(0))
      const realIndexPath = await resolveIndexPath(isolatedGitRoot)
      const indexLockPath = `${realIndexPath}.lock`
      indexLockMarker = `${indexLockPath}.domi-${commitOid}`
      await writeFile(indexLockMarker, `${commitOid}\n`, { flag: 'wx' })
      const indexLock = await open(indexLockPath, 'wx')
      adjacentIndex = indexLockPath
      await indexLock.close()
      await copyFile(finalIndexPath, adjacentIndex)

      const finalSnapshot = await captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'final-checkpoint.index'),
        null,
        null,
      )
      if (finalSnapshot.headOid !== snapshot.headOid || finalSnapshot.fingerprint !== snapshot.fingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Worktree 在保存阶段前发生变化，请重新准备验收' } }
      }

      let headUpdated = false
      try {
        await runGit(isolatedGitRoot, ['update-ref', '--no-deref', 'HEAD', commitOid, snapshot.headOid])
        headUpdated = true
        await rename(adjacentIndex, realIndexPath)
        adjacentIndex = null
        await removeBestEffort(indexLockMarker)
        indexLockMarker = null
      } catch (error) {
        if (headUpdated) {
          try {
            await runGit(isolatedGitRoot, ['update-ref', '--no-deref', 'HEAD', snapshot.headOid, commitOid])
          } catch (rollbackError) {
            return {
              status: 'error',
              error: {
                code: 'git_error',
                message: `Checkpoint index 写入失败且 HEAD 无法回滚：${this.errorMessage(error)}；${this.errorMessage(rollbackError)}`,
              },
            }
          }
        }
        return { status: 'error', error: { code: 'git_error', message: `Checkpoint 写入失败，已回滚：${this.errorMessage(error)}` } }
      }

      const completed = await captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'completed.index'),
        null,
        null,
      )
      if (
        completed.headOid !== commitOid
        || completed.headRef !== null
        || completed.headTreeOid !== snapshot.treeOid
        || completed.indexTreeOid !== snapshot.treeOid
        || completed.treeOid !== snapshot.treeOid
      ) {
        return { status: 'error', error: { code: 'git_error', message: 'Checkpoint 已写入，但 Worktree 未收敛到 clean 状态' } }
      }
      return {
        status: 'checkpointed',
        commitOid,
        parentOid: snapshot.headOid,
        changedFiles,
        isolatedFingerprint: completed.fingerprint,
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      await removeBestEffort(adjacentIndex)
      await removeBestEffort(indexLockMarker)
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async recoverCheckpoint(input: { isolatedPath: string; commitOid: string; parentOid: string; expectedIndexTreeOid: string }): Promise<CheckpointRecoveryResult> {
    if (!OID_PATTERN.test(input.commitOid) || !OID_PATTERN.test(input.parentOid) || !OID_PATTERN.test(input.expectedIndexTreeOid)) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Checkpoint 恢复 OID 无效' } }
    }
    let tempRoot: string | null = null
    let ownedIndexLock: string | null = null
    let ownedLockMarker: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-checkpoint-recovery-'))
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const realIndexPath = await resolveIndexPath(isolatedGitRoot)
      const indexLockPath = `${realIndexPath}.lock`
      const indexLockMarker = `${indexLockPath}.domi-${input.commitOid}`
      const targetTreeOid = stdoutText(await runGit(isolatedGitRoot, ['rev-parse', `${input.commitOid}^{tree}`]))
      const existingLock = await inspectIndexFileTree(isolatedGitRoot, indexLockPath)
      const markerOwned = await checkpointLockMarkerOwned(indexLockMarker, input.commitOid)
      const snapshot = await captureSnapshot(isolatedGitRoot, join(tempRoot, 'current.index'), null, null)
      if (snapshot.headRef !== null) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Worktree 已不再是 detached HEAD' } }
      }

      if (snapshot.headOid === input.parentOid) {
        if (existingLock.exists) {
          if (!markerOwned || (existingLock.treeOid !== null && existingLock.treeOid !== targetTreeOid)) {
            return { status: 'error', error: { code: 'stale_isolated', message: '遗留 index.lock 无法证明属于当前 Checkpoint，已保留现场' } }
          }
          await unlink(indexLockPath)
        }
        if (markerOwned) await unlink(indexLockMarker)
        return { status: 'checkpoint_aborted', isolatedFingerprint: snapshot.fingerprint }
      }
      if (snapshot.headOid !== input.commitOid) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Worktree HEAD 与待恢复 Checkpoint 不一致' } }
      }
      if (snapshot.treeOid !== snapshot.headTreeOid) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Worktree 在 Checkpoint 中断后出现了新修改，不能自动恢复 index' } }
      }
      if (snapshot.indexTreeOid !== input.expectedIndexTreeOid && snapshot.indexTreeOid !== snapshot.headTreeOid) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Checkpoint 中断后 index 出现了新的 staged 修改，不能自动覆盖' } }
      }

      const cleanIndexPath = join(tempRoot, 'clean.index')
      await prepareIndexFromPatch(isolatedGitRoot, cleanIndexPath, input.commitOid, Buffer.alloc(0))
      if (existingLock.exists) {
        if (!markerOwned || (existingLock.treeOid !== null && existingLock.treeOid !== targetTreeOid)) {
          return { status: 'error', error: { code: 'stale_isolated', message: '遗留 index.lock 与 Checkpoint 目标不一致，已保留现场' } }
        }
        if (existingLock.treeOid === null) await copyFile(cleanIndexPath, indexLockPath)
      } else {
        if (!markerOwned) {
          await writeFile(indexLockMarker, `${input.commitOid}\n`, { flag: 'wx' })
          ownedLockMarker = indexLockMarker
        }
        const indexLock = await open(indexLockPath, 'wx')
        ownedIndexLock = indexLockPath
        await indexLock.close()
        await copyFile(cleanIndexPath, indexLockPath)
      }

      const lockedSnapshot = await captureSnapshot(isolatedGitRoot, join(tempRoot, 'locked-current.index'), null, null)
      if (
        lockedSnapshot.headOid !== snapshot.headOid
        || lockedSnapshot.fingerprint !== snapshot.fingerprint
        || (lockedSnapshot.indexTreeOid !== input.expectedIndexTreeOid && lockedSnapshot.indexTreeOid !== lockedSnapshot.headTreeOid)
      ) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Checkpoint 恢复加锁前 Worktree 或 index 已变化' } }
      }
      await rename(indexLockPath, realIndexPath)
      ownedIndexLock = null
      await removeBestEffort(indexLockMarker)
      ownedLockMarker = null
      const completed = await captureSnapshot(isolatedGitRoot, join(tempRoot, 'completed.index'), null, null)
      if (
        completed.headOid !== input.commitOid
        || completed.headRef !== null
        || completed.indexTreeOid !== completed.headTreeOid
        || completed.treeOid !== completed.headTreeOid
      ) {
        return { status: 'error', error: { code: 'git_error', message: 'Checkpoint index 恢复后仍未收敛到 clean 状态' } }
      }
      return { status: 'checkpoint_recovered', isolatedFingerprint: completed.fingerprint }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      await removeBestEffort(ownedIndexLock)
      await removeBestEffort(ownedLockMarker)
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async inspectReview(input: ApplyPlanInput): Promise<InspectReviewResult> {
    if (!OID_PATTERN.test(input.baseOid)) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Session Base OID 格式无效' } }
    }
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-review-snapshot-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const localGitRoot = await resolveGitRoot(input.localPath)
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const localObjects = await sourceObjectDirectory(localGitRoot)
      const isolatedObjects = await sourceObjectDirectory(isolatedGitRoot)
      if (!pathsMatch(localObjects, isolatedObjects)) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Local 与 Isolated 不属于同一 Git 仓库' } }
      }
      const localPrefix = projectPrefix(localGitRoot, input.localPath)
      const isolatedPrefix = projectPrefix(isolatedGitRoot, input.isolatedPath)
      if (localPrefix === null || isolatedPrefix === null || localPrefix !== isolatedPrefix) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Local 与 Isolated 的项目子目录不一致' } }
      }
      await runGit(localGitRoot, ['cat-file', '-e', `${input.baseOid}^{commit}`])
      const local = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        localObjects,
      )
      const isolated = await captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        localObjects,
      )
      const effectiveBase = await selectEffectiveApplyBase(
        localGitRoot,
        input.baseOid,
        local.headOid,
        isolated.headOid,
      )
      const changedFiles = await changedTreePaths(
        isolatedGitRoot,
        effectiveBase.oid,
        isolated.treeOid,
        objectDirectory,
        localObjects,
      )
      if (changedFiles.some((path) => !isProjectPath(path, localPrefix))) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Isolated 包含项目根目录外的变更，不能准备验收' } }
      }
      return {
        status: 'ready',
        isolatedFingerprint: isolated.fingerprint,
        isolatedHeadOid: isolated.headOid,
        effectiveBaseOid: effectiveBase.oid,
        baseStrategy: effectiveBase.strategy,
        localHeadOid: local.headOid,
        changedFiles: changedFiles.map((path) => toProjectPath(path, localPrefix)).sort(),
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async preflight(input: ApplyPlanInput): Promise<ApplyPlanResult> {
    return this.calculatePlan(input, false)
  }

  async plan(input: ApplyPlanInput): Promise<ApplyPlanResult> {
    return this.calculatePlan(input, true)
  }

  private async calculatePlan(input: ApplyPlanInput, persistPlan: boolean): Promise<ApplyPlanResult> {
    if (!OID_PATTERN.test(input.baseOid)) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Session Base OID 格式无效' } }
    }

    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-apply-plan-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const localGitRoot = await resolveGitRoot(input.localPath)
      const isolatedGitRoot = await resolveGitRoot(input.isolatedPath)
      const localObjects = await sourceObjectDirectory(localGitRoot)
      const isolatedObjects = await sourceObjectDirectory(isolatedGitRoot)
      if (!pathsMatch(localObjects, isolatedObjects)) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Local 与 Isolated 不属于同一 Git 仓库' } }
      }
      const localPrefix = projectPrefix(localGitRoot, input.localPath)
      const isolatedPrefix = projectPrefix(isolatedGitRoot, input.isolatedPath)
      if (localPrefix === null || isolatedPrefix === null || localPrefix !== isolatedPrefix) {
        return { status: 'error', error: { code: 'invalid_input', message: 'Local 与 Isolated 的项目子目录不一致' } }
      }
      await runGit(localGitRoot, ['cat-file', '-e', `${input.baseOid}^{commit}`])

      const local = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        localObjects,
      )
      const isolated = await captureSnapshot(
        isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        localObjects,
      )
      const effectiveBase = await selectEffectiveApplyBase(
        localGitRoot,
        input.baseOid,
        local.headOid,
        isolated.headOid,
      )
      const isolatedChangedPaths = await changedTreePaths(
        isolatedGitRoot,
        effectiveBase.oid,
        isolated.treeOid,
        objectDirectory,
        localObjects,
      )
      if (isolatedChangedPaths.some((path) => !isProjectPath(path, localPrefix))) {
        return {
          status: 'error',
          error: { code: 'invalid_input', message: 'Isolated 包含项目根目录外的变更，已拒绝 Apply' },
        }
      }
      const merge = await computeMerge(
        tempRoot,
        localObjects,
        objectDirectory,
        effectiveBase.oid,
        local,
        isolated,
        localGitRoot,
        localPrefix,
      )
      const revision = randomUUID()
      if (merge.status === 'conflict') {
        return {
          status: 'conflict',
          revision,
          localFingerprint: local.fingerprint,
          isolatedFingerprint: isolated.fingerprint,
          effectiveBaseOid: effectiveBase.oid,
          baseStrategy: effectiveBase.strategy,
          localHeadOid: local.headOid,
          isolatedHeadOid: isolated.headOid,
          conflictingFiles: merge.conflictingFiles,
        }
      }

      const plan: ApplyPlan = {
        revision,
        localFingerprint: local.fingerprint,
        isolatedFingerprint: isolated.fingerprint,
        effectiveBaseOid: effectiveBase.oid,
        baseStrategy: effectiveBase.strategy,
        localHeadOid: local.headOid,
        localHeadRef: local.headRef,
        isolatedHeadOid: isolated.headOid,
        changedFiles: merge.changedFiles,
      }
      if (persistPlan) {
        this.plans.set(revision, {
          input: { ...input },
          patch: merge.patch,
          plan: { ...plan, changedFiles: [...plan.changedFiles] },
          scope: {
            isolatedGitRoot,
            localGitRoot,
            projectPrefix: localPrefix,
            sourceObjects: localObjects,
          },
        })
      }
      return { status: 'ready', plan: { ...plan, changedFiles: [...plan.changedFiles] } }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async apply(plan: ApplyPlan): Promise<ApplyResult> {
    const stored = this.plans.get(plan.revision)
    if (!stored || !planMatches(stored.plan, plan)) {
      return { status: 'error', error: { code: 'invalid_plan', message: 'Apply plan 不存在、已使用或已被修改' } }
    }

    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-apply-check-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(stored.scope.localGitRoot)
      if (!pathsMatch(sourceObjects, stored.scope.sourceObjects)) {
        return { status: 'error', error: { code: 'invalid_plan', message: 'Apply plan 的 Git 仓库身份已变化' } }
      }
      const local = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (local.headOid !== stored.plan.localHeadOid || local.fingerprint !== stored.plan.localFingerprint) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在 plan 后发生变化，请重新计算' } }
      }

      const isolated = await captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        sourceObjects,
      )
      if (isolated.headOid !== stored.plan.isolatedHeadOid || isolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Isolated 在 plan 后发生变化，请重新计算' } }
      }

      // 将已审核的 Isolated 最终状态写成无 ref 的内部 commit，供同一 checkout 后续 Apply 去重。
      // 使用独立 index，不改变 Isolated 的真实 staged/working tree。
      const persistentIsolated = await captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'persistent-isolated.index'),
        null,
        null,
      )
      if (persistentIsolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Isolated 在 plan 后发生变化，请重新计算' } }
      }
      const nextBaseOid = await createSnapshotCommit(
        stored.scope.isolatedGitRoot,
        persistentIsolated.treeOid,
        stored.plan.effectiveBaseOid,
        null,
        null,
        'Applied Isolated snapshot',
      )

      await this.options.beforeFinalLocalValidation?.()
      const finalLocal = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (finalLocal.headOid !== stored.plan.localHeadOid || finalLocal.fingerprint !== stored.plan.localFingerprint) {
        return {
          status: 'error',
          error: { code: 'stale_local', message: 'Local 在 Apply 写入前发生变化，请重新计算' },
        }
      }

      if (stored.patch.length > 0) {
        await runGit(stored.scope.localGitRoot, ['apply', '--binary', '--whitespace=nowarn'], { input: stored.patch })
      }
      this.plans.delete(plan.revision)
      return { status: 'applied', changedFiles: [...stored.plan.changedFiles], nextBaseOid }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async preview(
    plan: ApplyPlan,
    options: {
      previewId: string
      reviewId: string
      iteration: number
      beforeWrite?(receipt: PreviewReceipt): Promise<void>
    },
  ): Promise<PreviewResult> {
    const stored = this.plans.get(plan.revision)
    if (!stored || !planMatches(stored.plan, plan)) {
      return { status: 'error', error: { code: 'invalid_plan', message: 'Preview plan 不存在、已使用或已被修改' } }
    }
    if (!options.previewId.trim() || !options.reviewId.trim() || !Number.isSafeInteger(options.iteration) || options.iteration < 1) {
      return { status: 'error', error: { code: 'invalid_input', message: 'Preview identity 无效' } }
    }

    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-preview-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(stored.scope.localGitRoot)
      if (!pathsMatch(sourceObjects, stored.scope.sourceObjects)) {
        return { status: 'error', error: { code: 'invalid_plan', message: 'Preview plan 的 Git 仓库身份已变化' } }
      }
      const local = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (
        local.headOid !== stored.plan.localHeadOid
        || local.headRef !== stored.plan.localHeadRef
        || local.fingerprint !== stored.plan.localFingerprint
      ) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在 plan 后发生变化，请重新计算' } }
      }
      const isolated = await captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        sourceObjects,
      )
      if (isolated.headOid !== stored.plan.isolatedHeadOid || isolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Isolated 在 plan 后发生变化，请重新计算' } }
      }

      const persistentLocal = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'persistent-local.index'),
        null,
        null,
      )
      const persistentIsolated = await captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'persistent-isolated.index'),
        null,
        null,
      )
      if (
        persistentLocal.fingerprint !== stored.plan.localFingerprint
        || persistentIsolated.fingerprint !== stored.plan.isolatedFingerprint
      ) {
        return { status: 'error', error: { code: 'invalid_plan', message: 'Preview 持久快照与审核 plan 不一致' } }
      }
      const previewWorkingTreeOid = await prepareIndexFromPatch(
        stored.scope.localGitRoot,
        join(tempRoot, 'preview-working.index'),
        persistentLocal.treeOid,
        stored.patch,
      )
      const isolatedSnapshotOid = await createSnapshotCommit(
        stored.scope.isolatedGitRoot,
        persistentIsolated.treeOid,
        stored.plan.effectiveBaseOid,
        null,
        null,
        'Previewed Isolated snapshot',
      )
      const preparedReceipt: PreviewReceipt = {
        previewId: options.previewId,
        reviewId: options.reviewId,
        iteration: options.iteration,
        previewedAt: Date.now(),
        configuredBaseOid: stored.input.baseOid,
        effectiveBaseOid: stored.plan.effectiveBaseOid,
        baseStrategy: stored.plan.baseStrategy,
        localHeadOid: persistentLocal.headOid,
        localHeadRef: persistentLocal.headRef,
        localFingerprintBefore: persistentLocal.fingerprint,
        localFingerprintPreview: '',
        localWorkingTreeOid: persistentLocal.treeOid,
        localIndexTreeOid: persistentLocal.indexTreeOid,
        previewWorkingTreeOid,
        isolatedHeadOid: persistentIsolated.headOid,
        isolatedFingerprint: persistentIsolated.fingerprint,
        isolatedSnapshotOid,
        changedFiles: [...stored.plan.changedFiles],
      }

      await this.options.beforeFinalLocalValidation?.()
      const finalLocal = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (finalLocal.headOid !== stored.plan.localHeadOid || finalLocal.fingerprint !== stored.plan.localFingerprint) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在 Preview 写入前发生变化，请重新计算' } }
      }
      await options.beforeWrite?.(preparedReceipt)
      if (stored.patch.length > 0) {
        await runGit(stored.scope.localGitRoot, ['apply', '--binary', '--whitespace=nowarn'], { input: stored.patch })
      }
      const previewedLocal = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'previewed-local.index'),
        null,
        null,
        toRepositoryPaths(stored.plan.changedFiles, stored.scope.projectPrefix),
      )
      if (previewedLocal.treeOid !== previewWorkingTreeOid) {
        return {
          status: 'error',
          error: { code: 'git_error', message: 'Preview 写入后的 Local snapshot 与准备结果不一致，需要恢复确认' },
        }
      }

      this.plans.delete(plan.revision)
      const receipt: PreviewReceipt = {
        ...preparedReceipt,
        localFingerprintPreview: previewedLocal.fingerprint,
      }
      return { status: 'previewed', receipt, changedFiles: [...receipt.changedFiles] }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  private async classifyPreview(
    localGitRoot: string,
    receipt: PreviewReceipt,
    current: CheckoutSnapshot,
  ): Promise<PreviewInspectionResult> {
    if (
      current.headRef !== receipt.localHeadRef
      || (current.headRef === null && current.headOid !== receipt.localHeadOid)
    ) {
      return { status: 'error', error: { code: 'stale_local', message: 'Local 分支或 detached HEAD 已变化，不能自动处理 Preview' } }
    }
    if (current.headOid !== receipt.localHeadOid) {
      const committedPreviewOid = await findCommitWithTree(
        localGitRoot,
        receipt.localHeadOid,
        current.headOid,
        receipt.previewWorkingTreeOid,
      )
      const changedAfterPreview = committedPreviewOid
        ? new Set(parseNullSeparated((await runGit(
            localGitRoot,
            ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', committedPreviewOid, current.headOid, '--'],
          )).stdout))
        : new Set<string>()
      const previewStillPresent = committedPreviewOid
        ? receipt.changedFiles.every((file) => !changedAfterPreview.has(file))
        : false
      if (!committedPreviewOid || !previewStillPresent) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local HEAD 已变化，且无法证明 Preview 已进入提交历史；未修改 Local' } }
      }
      return {
        status: 'preview_committed',
        changedFiles: [...receipt.changedFiles],
        commitOid: committedPreviewOid,
      }
    }
    if (current.fingerprint !== receipt.localFingerprintPreview) {
      return {
        status: 'error',
        error: {
          code: 'preview_modified',
          message: 'Local 在 Preview 后发生额外修改；未自动撤回或清理',
          localHeadOid: current.headOid,
        },
      }
    }
    return { status: 'preview_active', changedFiles: [...receipt.changedFiles] }
  }

  async inspectPreview(input: { localPath: string; receipt: PreviewReceipt }): Promise<PreviewInspectionResult> {
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-preview-inspect-'))
      const localGitRoot = await resolveGitRoot(input.localPath)
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(localGitRoot)
      const localProjectPrefix = projectPrefix(localGitRoot, input.localPath)
      if (localProjectPrefix === null) throw new Error('Local Project 不在 Git 根目录内')
      const receiptPaths = toRepositoryPaths(input.receipt.changedFiles, localProjectPrefix)
      const current = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'current.index'),
        objectDirectory,
        sourceObjects,
        receiptPaths,
      )
      return await this.classifyPreview(localGitRoot, input.receipt, current)
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async rollback(input: { localPath: string; receipt: PreviewReceipt }): Promise<RollbackResult> {
    let tempRoot: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-preview-rollback-'))
      const localGitRoot = await resolveGitRoot(input.localPath)
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(localGitRoot)
      const localProjectPrefix = projectPrefix(localGitRoot, input.localPath)
      if (localProjectPrefix === null) throw new Error('Local Project 不在 Git 根目录内')
      const receiptPaths = toRepositoryPaths(input.receipt.changedFiles, localProjectPrefix)
      const current = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'current.index'),
        objectDirectory,
        sourceObjects,
        receiptPaths,
      )
      const inspection = await this.classifyPreview(localGitRoot, input.receipt, current)
      if (inspection.status === 'error') return inspection
      if (inspection.status === 'preview_committed') {
        await this.options.beforeFinalLocalValidation?.()
        const finalLocal = await captureSnapshot(
          localGitRoot,
          join(tempRoot, 'final-committed-local.index'),
          objectDirectory,
          sourceObjects,
          receiptPaths,
        )
        if (finalLocal.fingerprint !== current.fingerprint || finalLocal.headOid !== current.headOid) {
          return { status: 'error', error: { code: 'stale_local', message: 'Local 在确认 Preview 提交状态前发生变化，请重试' } }
        }
        return inspection
      }
      const rollbackTree = await computeTreeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        localGitRoot,
        'preview-rollback',
        input.receipt.previewWorkingTreeOid,
        current.treeOid,
        input.receipt.localWorkingTreeOid,
      )
      if (rollbackTree.status === 'conflict') {
        return {
          status: 'error',
          error: {
            code: 'preview_modified',
            message: `Local 在 Preview 区域出现额外修改，无法安全撤回：${rollbackTree.conflictingFiles.join('、')}`,
            localHeadOid: current.headOid,
            conflictingFiles: [...rollbackTree.conflictingFiles],
          },
        }
      }
      const rollbackPatch = await treePatch(
        localGitRoot,
        current.treeOid,
        rollbackTree.treeOid,
        objectDirectory,
        sourceObjects,
      )
      await this.options.beforeFinalLocalValidation?.()
      const finalLocal = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
        receiptPaths,
      )
      if (finalLocal.fingerprint !== current.fingerprint || finalLocal.headOid !== current.headOid) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在撤回 Preview 前发生变化，请重试' } }
      }
      if (rollbackPatch.length > 0) {
        await runGit(localGitRoot, ['apply', '--binary', '--whitespace=nowarn'], { input: rollbackPatch })
      }
      return { status: 'preview_rolled_back', changedFiles: [...input.receipt.changedFiles] }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async finalize(input: {
    localPath: string
    receipt: PreviewReceipt
    commitMessage: string
    beforeCommit?(commitOid: string): Promise<void>
  }): Promise<FinishResult> {
    const commitMessage = input.commitMessage.trim()
    if (!commitMessage) {
      return { status: 'error', error: { code: 'invalid_input', message: '提交信息不能为空' } }
    }
    if (!input.receipt.localHeadRef?.startsWith('refs/heads/')) {
      return { status: 'error', error: { code: 'operation_not_allowed', message: 'Preview 创建时 Local 不是普通分支，不能自动创建任务提交' } }
    }

    let tempRoot: string | null = null
    let adjacentIndex: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-preview-finalize-'))
      const localGitRoot = await resolveGitRoot(input.localPath)
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(localGitRoot)
      const localProjectPrefix = projectPrefix(localGitRoot, input.localPath)
      if (localProjectPrefix === null) throw new Error('Local Project 不在 Git 根目录内')
      const receiptPaths = toRepositoryPaths(input.receipt.changedFiles, localProjectPrefix)
      const current = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'current.index'),
        objectDirectory,
        sourceObjects,
        receiptPaths,
      )
      if (current.headRef !== input.receipt.localHeadRef || !current.headRef?.startsWith('refs/heads/')) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 分支已变化，不能完成 Preview 提交' } }
      }

      const previewRemoval = await computeTreeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        localGitRoot,
        'preview-finalize-separation',
        input.receipt.previewWorkingTreeOid,
        current.treeOid,
        input.receipt.localWorkingTreeOid,
      )
      if (previewRemoval.status === 'conflict') {
        return {
          status: 'error',
          error: {
            code: 'preview_modified',
            message: `Local 在 Preview 区域出现额外修改，无法可靠提交：${previewRemoval.conflictingFiles.join('、')}`,
            localHeadOid: current.headOid,
            conflictingFiles: [...previewRemoval.conflictingFiles],
          },
        }
      }

      if (input.receipt.changedFiles.length === 0) {
        await this.options.beforeFinalLocalValidation?.()
        const finalLocal = await captureSnapshot(
          localGitRoot,
          join(tempRoot, 'final-empty.index'),
          objectDirectory,
          sourceObjects,
          receiptPaths,
        )
        if (finalLocal.fingerprint !== current.fingerprint) {
          return { status: 'error', error: { code: 'stale_local', message: 'Local 在完成 Preview 前发生变化，请重试' } }
        }
        return {
          status: 'finished',
          changedFiles: [],
          localHeadBefore: current.headOid,
          commitOid: null,
          nextBaseOid: input.receipt.isolatedSnapshotOid,
        }
      }

      const taskTree = await computeTreeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        localGitRoot,
        'preview-task-isolation',
        input.receipt.localWorkingTreeOid,
        current.headTreeOid,
        input.receipt.previewWorkingTreeOid,
      )
      if (taskTree.status === 'conflict') {
        return {
          status: 'error',
          error: {
            code: 'commit_isolation_conflict',
            message: `Preview 任务增量无法与 Local HEAD 可靠拆分：${taskTree.conflictingFiles.join('、')}`,
            localHeadOid: current.headOid,
            conflictingFiles: [...taskTree.conflictingFiles],
          },
        }
      }
      const finalIndexTree = await computeTreeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        localGitRoot,
        'preview-index-preservation',
        current.headTreeOid,
        taskTree.treeOid,
        current.indexTreeOid,
      )
      if (finalIndexTree.status === 'conflict') {
        return {
          status: 'error',
          error: {
            code: 'commit_isolation_conflict',
            message: `Preview 提交与 Local staged 修改无法可靠分离：${finalIndexTree.conflictingFiles.join('、')}`,
            localHeadOid: current.headOid,
            conflictingFiles: [...finalIndexTree.conflictingFiles],
          },
        }
      }
      const taskPatch = await treePatch(
        localGitRoot,
        current.headTreeOid,
        taskTree.treeOid,
        objectDirectory,
        sourceObjects,
      )
      const finalIndexPatch = await treePatch(
        localGitRoot,
        taskTree.treeOid,
        finalIndexTree.treeOid,
        objectDirectory,
        sourceObjects,
      )
      const actualTaskTreeOid = await prepareIndexFromPatch(
        localGitRoot,
        join(tempRoot, 'task.index'),
        current.headOid,
        taskPatch,
      )
      const commitOid = await createUserCommit(localGitRoot, actualTaskTreeOid, current.headOid, commitMessage)
      const finalIndexPath = join(tempRoot, 'final.index')
      await prepareIndexFromPatch(localGitRoot, finalIndexPath, commitOid, finalIndexPatch)
      await input.beforeCommit?.(commitOid)

      await this.options.beforeFinalLocalValidation?.()
      const finalLocal = await captureSnapshot(
        localGitRoot,
        join(tempRoot, 'final-local.index'),
        objectDirectory,
        sourceObjects,
        receiptPaths,
      )
      if (finalLocal.fingerprint !== current.fingerprint || finalLocal.headOid !== current.headOid) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在 Preview 提交写入前发生变化，请重试' } }
      }

      const realIndexPath = await resolveIndexPath(localGitRoot)
      adjacentIndex = `${realIndexPath}.domi-${randomUUID()}`
      await copyFile(finalIndexPath, adjacentIndex)
      let refUpdated = false
      try {
        await runGit(localGitRoot, ['update-ref', current.headRef, commitOid, current.headOid])
        refUpdated = true
        await rename(adjacentIndex, realIndexPath)
        adjacentIndex = null
      } catch (error) {
        if (refUpdated) {
          try {
            await runGit(localGitRoot, ['update-ref', current.headRef, current.headOid, commitOid])
          } catch (rollbackError) {
            return {
              status: 'error',
              error: {
                code: 'git_error',
                message: `Preview 提交写入失败且 ref 无法回滚：${this.errorMessage(error)}；${this.errorMessage(rollbackError)}`,
              },
            }
          }
        }
        return { status: 'error', error: { code: 'git_error', message: `Preview 提交写入失败，已回滚：${this.errorMessage(error)}` } }
      }
      return {
        status: 'finished',
        changedFiles: [...input.receipt.changedFiles],
        localHeadBefore: current.headOid,
        commitOid,
        nextBaseOid: input.receipt.isolatedSnapshotOid,
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      await removeBestEffort(adjacentIndex)
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  async finish(plan: ApplyPlan, options: { commitMessage: string }): Promise<FinishResult> {
    const stored = this.plans.get(plan.revision)
    if (!stored || !planMatches(stored.plan, plan)) {
      return { status: 'error', error: { code: 'invalid_plan', message: 'Finish plan 不存在、已使用或已被修改' } }
    }
    const commitMessage = options.commitMessage.trim()
    if (!commitMessage) {
      return { status: 'error', error: { code: 'invalid_input', message: '提交信息不能为空' } }
    }
    if (!stored.plan.localHeadRef?.startsWith('refs/heads/')) {
      return {
        status: 'error',
        error: { code: 'operation_not_allowed', message: 'Local 当前不是普通分支，不能自动创建任务提交' },
      }
    }

    let tempRoot: string | null = null
    let adjacentIndex: string | null = null
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'domi-finish-'))
      const objectDirectory = join(tempRoot, 'objects')
      await mkdir(objectDirectory, { recursive: true })
      const sourceObjects = await sourceObjectDirectory(stored.scope.localGitRoot)
      if (!pathsMatch(sourceObjects, stored.scope.sourceObjects)) {
        return { status: 'error', error: { code: 'invalid_plan', message: 'Finish plan 的 Git 仓库身份已变化' } }
      }

      const local = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'local.index'),
        objectDirectory,
        sourceObjects,
      )
      if (
        local.headOid !== stored.plan.localHeadOid
        || local.headRef !== stored.plan.localHeadRef
        || local.fingerprint !== stored.plan.localFingerprint
      ) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在 plan 后发生变化，请重新计算' } }
      }
      const isolated = await captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'isolated.index'),
        objectDirectory,
        sourceObjects,
      )
      if (isolated.headOid !== stored.plan.isolatedHeadOid || isolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Isolated 在 plan 后发生变化，请重新计算' } }
      }

      const merge = await computeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        stored.plan.effectiveBaseOid,
        local,
        isolated,
        stored.scope.localGitRoot,
        stored.scope.projectPrefix,
      )
      if (merge.status === 'conflict') {
        return {
          status: 'error',
          error: { code: 'invalid_plan', message: 'Finish 复验得到与已审核 plan 不一致的冲突' },
        }
      }
      if (
        merge.changedFiles.length !== stored.plan.changedFiles.length
        || merge.changedFiles.some((path, index) => path !== stored.plan.changedFiles[index])
      ) {
        return { status: 'error', error: { code: 'invalid_plan', message: 'Finish 复验的文件集合已变化' } }
      }

      const persistentIsolated = await captureSnapshot(
        stored.scope.isolatedGitRoot,
        join(tempRoot, 'persistent-isolated.index'),
        null,
        null,
      )
      if (persistentIsolated.fingerprint !== stored.plan.isolatedFingerprint) {
        return { status: 'error', error: { code: 'stale_isolated', message: 'Isolated 在 plan 后发生变化，请重新计算' } }
      }
      const nextBaseOid = await createSnapshotCommit(
        stored.scope.isolatedGitRoot,
        persistentIsolated.treeOid,
        stored.plan.effectiveBaseOid,
        null,
        null,
        'Finished Isolated snapshot',
      )

      if (merge.changedFiles.length === 0) {
        await this.options.beforeFinalLocalValidation?.()
        const finalLocal = await captureSnapshot(
          stored.scope.localGitRoot,
          join(tempRoot, 'final-local.index'),
          objectDirectory,
          sourceObjects,
        )
        if (finalLocal.fingerprint !== stored.plan.localFingerprint) {
          return { status: 'error', error: { code: 'stale_local', message: 'Local 在 Finish 前发生变化，请重新计算' } }
        }
        this.plans.delete(plan.revision)
        return { status: 'finished', changedFiles: [], commitOid: null, nextBaseOid }
      }

      // C = H + (M - L)：把任务增量从完整 Local 快照 L 中剥离，重放到旧 HEAD H。
      const taskTree = await computeTreeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        stored.scope.localGitRoot,
        'finish-task-isolation',
        local.treeOid,
        local.headTreeOid,
        merge.mergedTreeOid,
      )
      if (taskTree.status === 'conflict') {
        return {
          status: 'error',
          error: {
            code: 'commit_isolation_conflict',
            message: `任务增量无法与 Local 原有修改可靠拆分：${taskTree.conflictingFiles.join('、')}`,
          },
        }
      }

      // S' = C + (S - H)：在任务提交 C 上恢复用户原有 staged 状态。
      const finalIndexTree = await computeTreeMerge(
        tempRoot,
        sourceObjects,
        objectDirectory,
        stored.scope.localGitRoot,
        'finish-index-preservation',
        local.headTreeOid,
        taskTree.treeOid,
        local.indexTreeOid,
      )
      if (finalIndexTree.status === 'conflict') {
        return {
          status: 'error',
          error: {
            code: 'commit_isolation_conflict',
            message: `任务提交与 Local 原有 staged 修改无法可靠分离：${finalIndexTree.conflictingFiles.join('、')}`,
          },
        }
      }

      const taskPatch = await treePatch(
        stored.scope.localGitRoot,
        local.headTreeOid,
        taskTree.treeOid,
        objectDirectory,
        sourceObjects,
      )
      const finalIndexPatch = await treePatch(
        stored.scope.localGitRoot,
        taskTree.treeOid,
        finalIndexTree.treeOid,
        objectDirectory,
        sourceObjects,
      )
      const taskIndexPath = join(tempRoot, 'task-commit.index')
      const actualTaskTreeOid = await prepareIndexFromPatch(
        stored.scope.localGitRoot,
        taskIndexPath,
        local.headOid,
        taskPatch,
      )
      const commitOid = await createUserCommit(
        stored.scope.localGitRoot,
        actualTaskTreeOid,
        local.headOid,
        commitMessage,
      )
      const finalIndexPath = join(tempRoot, 'preserved-local.index')
      await prepareIndexFromPatch(
        stored.scope.localGitRoot,
        finalIndexPath,
        commitOid,
        finalIndexPatch,
      )

      await this.options.beforeFinalLocalValidation?.()
      const finalLocal = await captureSnapshot(
        stored.scope.localGitRoot,
        join(tempRoot, 'final-local-validation.index'),
        objectDirectory,
        sourceObjects,
      )
      if (
        finalLocal.headOid !== stored.plan.localHeadOid
        || finalLocal.headRef !== stored.plan.localHeadRef
        || finalLocal.fingerprint !== stored.plan.localFingerprint
      ) {
        return { status: 'error', error: { code: 'stale_local', message: 'Local 在 Finish 写入前发生变化，请重新计算' } }
      }

      const realIndexPath = await resolveIndexPath(stored.scope.localGitRoot)
      adjacentIndex = `${realIndexPath}.domi-${randomUUID()}`
      await copyFile(finalIndexPath, adjacentIndex)

      let worktreePatched = false
      let refUpdated = false
      try {
        if (merge.patch.length > 0) {
          await runGit(stored.scope.localGitRoot, ['apply', '--binary', '--whitespace=nowarn'], { input: merge.patch })
          worktreePatched = true
        }
        await runGit(stored.scope.localGitRoot, [
          'update-ref',
          stored.plan.localHeadRef,
          commitOid,
          local.headOid,
        ])
        refUpdated = true
        await rename(adjacentIndex, realIndexPath)
        adjacentIndex = null
      } catch (error) {
        const rollbackErrors: string[] = []
        if (refUpdated) {
          try {
            await runGit(stored.scope.localGitRoot, [
              'update-ref',
              stored.plan.localHeadRef,
              local.headOid,
              commitOid,
            ])
          } catch (rollbackError) {
            rollbackErrors.push(`ref: ${this.errorMessage(rollbackError)}`)
          }
        }
        if (worktreePatched) {
          try {
            await runGit(stored.scope.localGitRoot, ['apply', '-R', '--binary', '--whitespace=nowarn'], { input: merge.patch })
          } catch (rollbackError) {
            rollbackErrors.push(`worktree: ${this.errorMessage(rollbackError)}`)
          }
        }
        const detail = this.errorMessage(error)
        if (rollbackErrors.length > 0) {
          return {
            status: 'error',
            error: {
              code: 'git_error',
              message: `Finish 写入失败且无法证明完整回滚：${detail}；${rollbackErrors.join('；')}`,
            },
          }
        }
        return { status: 'error', error: { code: 'git_error', message: `Finish 写入失败，已回滚：${detail}` } }
      }

      this.plans.delete(plan.revision)
      return {
        status: 'finished',
        changedFiles: [...stored.plan.changedFiles],
        commitOid,
        nextBaseOid,
      }
    } catch (error) {
      return { status: 'error', error: { code: 'git_error', message: this.errorMessage(error) } }
    } finally {
      await removeBestEffort(adjacentIndex)
      if (tempRoot) await this.cleanup(tempRoot)
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof GitCommandFailure) {
      return `Git 操作失败（${error.args[0] ?? 'unknown'}）：${error.message}`
    }
    return error instanceof Error ? error.message : '未知 Git 错误'
  }

  private async cleanup(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2 })
    } catch (error) {
      // 清理失败不能掩盖 plan/apply 的主结果。
      console.warn('[session-checkout-apply] 临时目录清理失败：', error)
    }
  }
}

export function createSessionCheckoutApplyEngine(
  options: SessionCheckoutApplyEngineOptions = {},
): SessionCheckoutApplyEngine {
  return new DefaultSessionCheckoutApplyEngine(options)
}
