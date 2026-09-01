import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createSessionCheckoutApplyEngine,
  type ApplyPlan,
  type SessionCheckoutApplyEngine,
} from './session-checkout-apply.ts'

interface CheckoutFixture {
  baseOid: string
  branchName: string
  isolatedPath: string
  isolatedRepositoryPath: string
  localPath: string
  localRepositoryPath: string
}

const tempDirs: string[] = []

// Git-heavy B/I/L integration cases exceed Bun's 5s default on shared Windows runners.
setDefaultTimeout(30_000)

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-c', 'core.quotePath=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await child.exited
  const stdout = await new Response(child.stdout).text()
  if (exitCode !== 0) throw new Error(await new Response(child.stderr).text())
  return stdout.trim()
}

async function createFixture(options: { projectSubdirectory?: string } = {}): Promise<CheckoutFixture> {
  const root = await mkdtemp(join(tmpdir(), 'domi apply 空格-'))
  tempDirs.push(root)
  const localRepositoryPath = join(root, 'local checkout')
  const isolatedRepositoryPath = join(root, '隔离 checkout')
  const localPath = options.projectSubdirectory
    ? join(localRepositoryPath, options.projectSubdirectory)
    : localRepositoryPath
  const isolatedPath = options.projectSubdirectory
    ? join(isolatedRepositoryPath, options.projectSubdirectory)
    : isolatedRepositoryPath
  await runGit(root, ['init', localRepositoryPath])
  await mkdir(localPath, { recursive: true })
  await runGit(localRepositoryPath, ['config', 'user.email', 'test@example.com'])
  await runGit(localRepositoryPath, ['config', 'user.name', 'Domi Test'])
  await runGit(localRepositoryPath, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(localPath, 'tracked.txt'), 'base\n')
  await writeFile(join(localPath, 'merge.txt'), 'first\nsecond\nthird\n')
  await writeFile(join(localPath, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await runGit(localRepositoryPath, ['add', '.'])
  await runGit(localRepositoryPath, ['commit', '-m', 'base'])
  const baseOid = await runGit(localRepositoryPath, ['rev-parse', 'HEAD'])
  const branchName = await runGit(localRepositoryPath, ['branch', '--show-current'])
  await runGit(localRepositoryPath, ['worktree', 'add', '--detach', isolatedRepositoryPath, baseOid])
  return { baseOid, branchName, isolatedPath, isolatedRepositoryPath, localPath, localRepositoryPath }
}

async function readyPlan(engine: SessionCheckoutApplyEngine, fixture: CheckoutFixture): Promise<ApplyPlan> {
  const result = await engine.plan(fixture)
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error(`预期 ready，实际为 ${result.status}`)
  return result.plan
}

describe('SessionCheckoutApplyEngine', () => {
  test('Given staged, unstaged and untracked changes When cloning a session handoff snapshot Then the new detached Worktree preserves the exact Git state without mutating the source', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'handoff staged\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'handoff unstaged\n')
    await writeFile(join(fixture.isolatedPath, 'handoff-untracked.bin'), Buffer.from([0, 1, 2, 255]))
    const headBefore = await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])
    const statusBefore = await runGit(fixture.isolatedPath, ['status', '--porcelain=v1', '-z'])

    const engine = createSessionCheckoutApplyEngine()
    if (!engine.captureHandoffSnapshot || !engine.restoreHandoffSnapshot) {
      throw new Error('Session handoff snapshot clone 不可用')
    }
    const result = await engine.captureHandoffSnapshot({
      isolatedPath: fixture.isolatedPath,
      baseOid: fixture.baseOid,
    })

    expect(result.status).toBe('captured')
    if (result.status !== 'captured') return
    expect(result.changedFiles).toEqual(['handoff-untracked.bin', 'tracked.txt'])
    expect(result.indexTreeOid).toHaveLength(40)
    expect(result.treeOid).toHaveLength(40)

    const clonePath = join(dirname(fixture.isolatedRepositoryPath), 'cloned-repo')
    await runGit(fixture.localRepositoryPath, ['worktree', 'add', '--detach', clonePath, result.isolatedHeadOid])
    const restored = await engine.restoreHandoffSnapshot({
      isolatedPath: clonePath,
      expectedHeadOid: result.isolatedHeadOid,
      indexTreeOid: result.indexTreeOid,
      treeOid: result.treeOid,
    })

    expect(restored.status).toBe('restored')
    if (restored.status !== 'restored') return
    expect(restored.indexTreeOid).toBe(result.indexTreeOid)
    expect(restored.treeOid).toBe(result.treeOid)
    expect(await runGit(clonePath, ['status', '--porcelain=v1', '-z'])).toBe(statusBefore)
    expect(await readFile(join(clonePath, 'tracked.txt'), 'utf8')).toBe('handoff unstaged\n')
    expect(await readFile(join(clonePath, 'handoff-untracked.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(await runGit(fixture.isolatedPath, ['status', '--porcelain=v1', '-z'])).toBe(statusBefore)
  })

  test('Given a read-only preflight When it reports a ready merge Then it exposes the real merge facts without creating an executable plan or modifying Local', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'preflight only\n')
    const localBefore = await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.preflight(fixture)

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error(`预期 ready，实际为 ${result.status}`)
    expect(result.plan).toMatchObject({
      effectiveBaseOid: fixture.baseOid,
      baseStrategy: 'isolated_contains_local_head',
      localHeadOid: fixture.baseOid,
      isolatedHeadOid: fixture.baseOid,
      changedFiles: ['tracked.txt'],
    })
    expect(result.plan.localHeadRef).toBe(`refs/heads/${fixture.branchName}`)
    expect(await engine.apply(result.plan)).toMatchObject({
      status: 'error',
      error: { code: 'invalid_plan' },
    })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe(localBefore)
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe('')
  })

  test('Given Local advanced and its HEAD was merged into Isolated When inspecting review Then only the delivery delta after Local HEAD is reported', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'local-existing.txt'), 'already in local\n')
    await runGit(fixture.localRepositoryPath, ['add', 'local-existing.txt'])
    await runGit(fixture.localRepositoryPath, ['commit', '-m', 'local existing feature'])
    const localHeadOid = await runGit(fixture.localRepositoryPath, ['rev-parse', 'HEAD'])

    await writeFile(join(fixture.isolatedPath, 'task-only.txt'), 'delivery delta\n')
    await runGit(fixture.isolatedRepositoryPath, ['add', 'task-only.txt'])
    await runGit(fixture.isolatedRepositoryPath, ['commit', '-m', 'task delta'])
    await runGit(fixture.isolatedRepositoryPath, ['merge', '--no-ff', localHeadOid, '-m', 'integrate local head'])

    const result = await createSessionCheckoutApplyEngine().inspectReview(fixture)

    expect(result).toMatchObject({
      status: 'ready',
      effectiveBaseOid: localHeadOid,
      baseStrategy: 'isolated_contains_local_head',
      localHeadOid,
      changedFiles: ['task-only.txt'],
    })
  })

  test('Given reviewed staged, unstaged and untracked changes When Checkpoint succeeds Then detached HEAD advances and the Worktree becomes clean without touching Local', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'checkpoint tracked\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\ncheckpoint second\nthird\n')
    await writeFile(join(fixture.isolatedPath, 'checkpoint-new.txt'), 'checkpoint new\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    const review = await engine.inspectReview(fixture)
    expect(review.status).toBe('ready')
    if (review.status !== 'ready') throw new Error(`预期 ready，实际为 ${review.status}`)
    const localHeadBefore = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])
    const localStatusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])

    const result = await engine.checkpoint({
      isolatedPath: fixture.isolatedPath,
      expectedFingerprint: review.isolatedFingerprint,
      expectedHeadOid: review.isolatedHeadOid,
      commitMessage: 'chore: save checkpoint',
    })

    expect(result.status).toBe('checkpointed')
    if (result.status !== 'checkpointed') throw new Error(`预期 checkpointed，实际为 ${result.status}`)
    expect(result.parentOid).toBe(fixture.baseOid)
    expect(result.changedFiles).toEqual(['checkpoint-new.txt', 'merge.txt', 'tracked.txt'])
    expect(await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])).toBe(result.commitOid)
    expect(await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD^'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.isolatedPath, ['show', '-s', '--format=%s', 'HEAD'])).toBe('chore: save checkpoint')
    expect(await runGit(fixture.isolatedPath, ['branch', '--show-current'])).toBe('')
    expect(await runGit(fixture.isolatedPath, ['status', '--porcelain=v1', '-uall'])).toBe('')
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(localHeadBefore)
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe(localStatusBefore)
  })

  test('Given Checkpoint HEAD advanced before its index replacement completed When recovery runs Then it normalizes the index only if working bytes still match the Commit', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'recover checkpoint index\n')
    const engine = createSessionCheckoutApplyEngine()
    const review = await engine.inspectReview(fixture)
    expect(review.status).toBe('ready')
    if (review.status !== 'ready') throw new Error(`预期 ready，实际为 ${review.status}`)
    const checkpoint = await engine.checkpoint({
      isolatedPath: fixture.isolatedPath,
      expectedFingerprint: review.isolatedFingerprint,
      expectedHeadOid: review.isolatedHeadOid,
      commitMessage: 'chore: recover checkpoint index',
    })
    expect(checkpoint.status).toBe('checkpointed')
    if (checkpoint.status !== 'checkpointed') throw new Error(`预期 checkpointed，实际为 ${checkpoint.status}`)
    await runGit(fixture.isolatedPath, ['read-tree', fixture.baseOid])
    expect(await runGit(fixture.isolatedPath, ['diff', '--cached', '--name-only'])).toBe('tracked.txt')

    const recovered = await createSessionCheckoutApplyEngine().recoverCheckpoint({
      isolatedPath: fixture.isolatedPath,
      commitOid: checkpoint.commitOid,
      parentOid: fixture.baseOid,
      expectedIndexTreeOid: await runGit(fixture.isolatedPath, ['rev-parse', `${fixture.baseOid}^{tree}`]),
    })

    expect(recovered.status).toBe('checkpoint_recovered')
    expect(await runGit(fixture.isolatedPath, ['status', '--porcelain=v1', '-uall'])).toBe('')
    expect(await readFile(join(fixture.isolatedPath, 'tracked.txt'), 'utf8')).toBe('recover checkpoint index\n')
  })

  test('Given Checkpoint prepared index.lock but HEAD CAS never happened When recovery runs Then it removes only the proven target lock and returns to the reviewed parent state', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'prepared checkpoint lock\n')
    const engine = createSessionCheckoutApplyEngine()
    const review = await engine.inspectReview(fixture)
    if (review.status !== 'ready') throw new Error(`预期 ready，实际为 ${review.status}`)
    const checkpoint = await engine.checkpoint({
      isolatedPath: fixture.isolatedPath,
      expectedFingerprint: review.isolatedFingerprint,
      expectedHeadOid: review.isolatedHeadOid,
      commitMessage: 'chore: prepared checkpoint lock',
    })
    if (checkpoint.status !== 'checkpointed') throw new Error(`预期 checkpointed，实际为 ${checkpoint.status}`)
    const indexPath = await runGit(fixture.isolatedPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    const preparedIndexPath = join(fixture.isolatedRepositoryPath, 'prepared.index')
    await copyFile(indexPath, preparedIndexPath)
    await runGit(fixture.isolatedPath, ['update-ref', '--no-deref', 'HEAD', fixture.baseOid, checkpoint.commitOid])
    await runGit(fixture.isolatedPath, ['read-tree', fixture.baseOid])
    await copyFile(preparedIndexPath, `${indexPath}.lock`)
    await writeFile(`${indexPath}.lock.domi-${checkpoint.commitOid}`, `${checkpoint.commitOid}\n`)

    const recovered = await createSessionCheckoutApplyEngine().recoverCheckpoint({
      isolatedPath: fixture.isolatedPath,
      commitOid: checkpoint.commitOid,
      parentOid: fixture.baseOid,
      expectedIndexTreeOid: await runGit(fixture.isolatedPath, ['rev-parse', `${fixture.baseOid}^{tree}`]),
    })

    expect(recovered.status).toBe('checkpoint_aborted')
    expect(await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseOid)
    await expect(readFile(`${indexPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(fixture.isolatedPath, 'tracked.txt'), 'utf8')).toBe('prepared checkpoint lock\n')
  })

  test('Given staged-only data appears after an interrupted Checkpoint When recovery runs Then it preserves the index and fails closed', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'checkpoint target\n')
    const engine = createSessionCheckoutApplyEngine()
    const review = await engine.inspectReview(fixture)
    if (review.status !== 'ready') throw new Error(`预期 ready，实际为 ${review.status}`)
    const checkpoint = await engine.checkpoint({
      isolatedPath: fixture.isolatedPath,
      expectedFingerprint: review.isolatedFingerprint,
      expectedHeadOid: review.isolatedHeadOid,
      commitMessage: 'chore: staged recovery guard',
    })
    if (checkpoint.status !== 'checkpointed') throw new Error(`预期 checkpointed，实际为 ${checkpoint.status}`)
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'staged-only must survive\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'checkpoint target\n')
    const stagedBefore = await runGit(fixture.isolatedPath, ['show', ':tracked.txt'])

    const recovered = await createSessionCheckoutApplyEngine().recoverCheckpoint({
      isolatedPath: fixture.isolatedPath,
      commitOid: checkpoint.commitOid,
      parentOid: fixture.baseOid,
      expectedIndexTreeOid: await runGit(fixture.isolatedPath, ['rev-parse', `${fixture.baseOid}^{tree}`]),
    })

    expect(recovered).toMatchObject({ status: 'error', error: { code: 'stale_isolated' } })
    expect(await runGit(fixture.isolatedPath, ['show', ':tracked.txt'])).toBe(stagedBefore)
    expect(stagedBefore).toBe('staged-only must survive')
  })

  test('Given a reviewed Worktree changes again before Checkpoint When saving Then it fails closed without creating a Commit', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'reviewed checkpoint\n')
    const engine = createSessionCheckoutApplyEngine()
    const review = await engine.inspectReview(fixture)
    expect(review.status).toBe('ready')
    if (review.status !== 'ready') throw new Error(`预期 ready，实际为 ${review.status}`)
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'changed after review\n')

    const result = await engine.checkpoint({
      isolatedPath: fixture.isolatedPath,
      expectedFingerprint: review.isolatedFingerprint,
      expectedHeadOid: review.isolatedHeadOid,
      commitMessage: 'chore: stale checkpoint',
    })

    expect(result).toMatchObject({ status: 'error', error: { code: 'stale_isolated' } })
    expect(await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.isolatedPath, ['status', '--porcelain=v1', '-uall'])).toContain('tracked.txt')
  })

  test('Given Isolated has a committed text change When Apply succeeds Then Local receives only unstaged changes', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated change'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)
    const result = await engine.apply(plan)

    expect(result).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('isolated\n')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('tracked.txt')
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.localPath, ['branch', '--show-current'])).toBe(fixture.branchName)
    expect((await runGit(fixture.localPath, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).split('\n')).toEqual([
      `refs/heads/${fixture.branchName}`,
    ])
  })

  test('Given a clean Local and an Isolated task When Finish runs Then it creates one squash commit with the requested message', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'finished task\n')
    await writeFile(join(fixture.isolatedPath, 'task-new.txt'), 'new task file\n')
    await runGit(fixture.isolatedPath, ['add', '.'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'temporary worktree commit'])
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\nsecond\nfinished remainder\n')
    const engine = createSessionCheckoutApplyEngine()

    const result = await engine.finish(await readyPlan(engine, fixture), {
      commitMessage: 'fix: finish isolated task',
    })

    expect(result.status).toBe('finished')
    if (result.status !== 'finished') throw new Error(`预期 finished，实际为 ${result.status}`)
    const head = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])
    expect(result.commitOid).toBe(head)
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD^'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.localPath, ['show', '-s', '--format=%s', 'HEAD'])).toBe('fix: finish isolated task')
    expect((await runGit(fixture.localPath, ['show', '--format=', '--name-only', 'HEAD'])).split('\n').sort()).toEqual([
      'merge.txt',
      'task-new.txt',
      'tracked.txt',
    ])
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe('')
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('finished task\n')
  })

  test('Given Preview receipt persistence fails When beforeWrite rejects Then Local remains byte-for-byte unchanged', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'prepared preview\n')
    const engine = createSessionCheckoutApplyEngine()
    let prepared = false

    const result = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-prepared',
      reviewId: 'review-prepared',
      iteration: 1,
      beforeWrite: async (receipt) => {
        prepared = true
        expect(receipt.previewWorkingTreeOid).toHaveLength(40)
        expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
        throw new Error('模拟 registry 持久化失败')
      },
    })

    expect(prepared).toBe(true)
    expect(result).toMatchObject({ status: 'error', error: { code: 'git_error' } })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe('')
  })

  test('Given Local still exactly matches an active Preview When rollback is requested Then Domi restores the Apply-before snapshot', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'preview task\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-exact-rollback',
      reviewId: 'review-exact-rollback',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)

    const rollback = await createSessionCheckoutApplyEngine().rollback({
      localPath: fixture.localPath,
      receipt: preview.receipt,
    })

    expect(rollback).toMatchObject({ status: 'preview_rolled_back', changedFiles: ['tracked.txt'] })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe('')
  })

  test('Given a task Preview has extra Local review work When rollback is requested Then Domi fails closed and preserves the full Local state', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'local-staged.txt'), 'keep staged\n')
    await runGit(fixture.localPath, ['add', 'local-staged.txt'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'preview task\n')
    const engine = createSessionCheckoutApplyEngine()

    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-1',
      reviewId: 'review-1',
      iteration: 1,
    })

    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('preview task\n')
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('local-staged.txt')
    await writeFile(join(fixture.localPath, 'review-note.txt'), 'created while reviewing\n')

    const statusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])
    const rollback = await createSessionCheckoutApplyEngine().rollback({
      localPath: fixture.localPath,
      receipt: preview.receipt,
    })

    expect(rollback).toMatchObject({ status: 'error', error: { code: 'preview_modified' } })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('preview task\n')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('local-staged.txt')
    expect(await readFile(join(fixture.localPath, 'review-note.txt'), 'utf8')).toBe('created while reviewing\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe(statusBefore)
  })

  test('Given the exact Preview snapshot was manually committed When rollback is requested Then Domi recognizes delivery without modifying Local', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'manually committed preview\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-manually-committed',
      reviewId: 'review-manually-committed',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)

    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'feat: accept preview manually'])
    const previewCommit = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])
    await writeFile(join(fixture.localPath, 'follow-up.txt'), 'later commit\n')
    await runGit(fixture.localPath, ['add', 'follow-up.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'chore: follow up after preview'])
    const committedHead = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])

    const rollback = await createSessionCheckoutApplyEngine().rollback({
      localPath: fixture.localPath,
      receipt: preview.receipt,
    })

    expect(rollback).toMatchObject({ status: 'preview_committed', changedFiles: ['tracked.txt'], commitOid: previewCommit })
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(committedHead)
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('manually committed preview\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe('')
  })

  test('Given a later commit changes a committed Preview path When rollback is requested Then Domi refuses to classify the old snapshot as current delivery', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'committed preview\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-committed-then-changed',
      reviewId: 'review-committed-then-changed',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)

    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'feat: accept preview'])
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'changed after preview commit\n')
    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'fix: change delivered path later'])
    const statusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])

    const rollback = await createSessionCheckoutApplyEngine().rollback({ localPath: fixture.localPath, receipt: preview.receipt })

    expect(rollback).toMatchObject({ status: 'error', error: { code: 'stale_local' } })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('changed after preview commit\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe(statusBefore)
  })

  test('Given Local HEAD advances without committing the Preview When rollback is requested Then Domi fails closed without modifying Local', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'preview across advanced head\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-advanced-rollback',
      reviewId: 'review-advanced-rollback',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)

    await writeFile(join(fixture.localPath, 'local-follow-up.txt'), 'new Local commit\n')
    await runGit(fixture.localPath, ['add', 'local-follow-up.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'chore: advance local after preview'])
    const advancedHead = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])
    const statusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])

    const rollback = await createSessionCheckoutApplyEngine().rollback({
      localPath: fixture.localPath,
      receipt: preview.receipt,
    })

    expect(rollback).toMatchObject({ status: 'error', error: { code: 'stale_local' } })
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(advancedHead)
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('preview across advanced head\n')
    expect(await readFile(join(fixture.localPath, 'local-follow-up.txt'), 'utf8')).toBe('new Local commit\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe(statusBefore)
  })

  test('Given Local HEAD advances on the same branch after Preview When finalized Then the task becomes one commit on top of the latest Local HEAD', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'accepted after advanced head\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-advanced-finalize',
      reviewId: 'review-advanced-finalize',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)

    await writeFile(join(fixture.localPath, 'local-follow-up.txt'), 'new Local commit\n')
    await runGit(fixture.localPath, ['add', 'local-follow-up.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'chore: advance local after preview'])
    const advancedHead = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])

    const result = await createSessionCheckoutApplyEngine().finalize({
      localPath: fixture.localPath,
      receipt: preview.receipt,
      commitMessage: 'fix: finalize preview on latest local',
    })

    expect(result.status).toBe('finished')
    if (result.status !== 'finished') throw new Error(`预期 finished，实际为 ${result.status}`)
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD^'])).toBe(advancedHead)
    expect(await runGit(fixture.localPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('tracked.txt')
    expect(await readFile(join(fixture.localPath, 'local-follow-up.txt'), 'utf8')).toBe('new Local commit\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe('')
  })

  test('Given Local switches branches after Preview When rollback or finalize is requested Then Domi does not guess a target branch', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'preview before branch switch\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-branch-switch',
      reviewId: 'review-branch-switch',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)

    await runGit(fixture.localPath, ['switch', '-c', 'other-review-branch'])
    const statusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])
    const rollback = await createSessionCheckoutApplyEngine().rollback({ localPath: fixture.localPath, receipt: preview.receipt })
    const finalize = await createSessionCheckoutApplyEngine().finalize({
      localPath: fixture.localPath,
      receipt: preview.receipt,
      commitMessage: 'fix: must not cross branches',
    })

    expect(rollback).toMatchObject({ status: 'error', error: { code: 'stale_local' } })
    expect(finalize).toMatchObject({ status: 'error', error: { code: 'stale_local' } })
    expect(await runGit(fixture.localPath, ['branch', '--show-current'])).toBe('other-review-branch')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-uall'])).toBe(statusBefore)
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('preview before branch switch\n')
  })

  test('Given Preview is accepted after unrelated Local work When a fresh engine finalizes Then only the task enters one commit', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'local-staged.txt'), 'keep staged\n')
    await runGit(fixture.localPath, ['add', 'local-staged.txt'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'accepted preview\n')
    const engine = createSessionCheckoutApplyEngine()
    const preview = await engine.preview(await readyPlan(engine, fixture), {
      previewId: 'preview-2',
      reviewId: 'review-2',
      iteration: 1,
    })
    expect(preview.status).toBe('previewed')
    if (preview.status !== 'previewed') throw new Error(`预期 previewed，实际为 ${preview.status}`)
    await writeFile(join(fixture.localPath, 'merge.txt'), 'review-local\nsecond\nthird\n')
    await writeFile(join(fixture.localPath, 'review-untracked.txt'), 'keep me\n')

    const result = await createSessionCheckoutApplyEngine().finalize({
      localPath: fixture.localPath,
      receipt: preview.receipt,
      commitMessage: 'fix: accepted preview',
    })

    expect(result.status).toBe('finished')
    if (result.status !== 'finished') throw new Error(`预期 finished，实际为 ${result.status}`)
    expect(result.commitOid).toBe(await runGit(fixture.localPath, ['rev-parse', 'HEAD']))
    expect(await runGit(fixture.localPath, ['show', '-s', '--format=%s', 'HEAD'])).toBe('fix: accepted preview')
    expect(await runGit(fixture.localPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('tracked.txt')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('local-staged.txt')
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('merge.txt')
    expect(await readFile(join(fixture.localPath, 'review-untracked.txt'), 'utf8')).toBe('keep me\n')
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('accepted preview\n')
  })

  test('Given Local has unrelated staged, unstaged and untracked work When Finish runs Then only task changes enter the commit and Local layers remain', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'local-staged.txt'), 'keep staged\n')
    await runGit(fixture.localPath, ['add', 'local-staged.txt'])
    await writeFile(join(fixture.localPath, 'merge.txt'), 'local unstaged\nsecond\nthird\n')
    await writeFile(join(fixture.localPath, 'local-untracked.txt'), 'keep untracked\n')
    const stagedBefore = await runGit(fixture.localPath, ['show', ':local-staged.txt'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'task only\n')
    const engine = createSessionCheckoutApplyEngine()

    const result = await engine.finish(await readyPlan(engine, fixture), {
      commitMessage: 'fix: task only',
    })

    expect(result.status).toBe('finished')
    expect(await runGit(fixture.localPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe('tracked.txt')
    expect(await runGit(fixture.localPath, ['show', ':local-staged.txt'])).toBe(stagedBefore)
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('local-staged.txt')
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('merge.txt')
    expect(await readFile(join(fixture.localPath, 'local-untracked.txt'), 'utf8')).toBe('keep untracked\n')
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('task only\n')
  })

  test('Given Local staged and task edits are disjoint hunks in one file When Finish runs Then the task hunk is committed and the Local hunk stays staged', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'merge.txt'), 'local first\nsecond\nthird\n')
    await runGit(fixture.localPath, ['add', 'merge.txt'])
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\nsecond\ntask third\n')
    const engine = createSessionCheckoutApplyEngine()

    const result = await engine.finish(await readyPlan(engine, fixture), {
      commitMessage: 'fix: third line',
    })

    expect(result.status).toBe('finished')
    expect(await runGit(fixture.localPath, ['show', 'HEAD:merge.txt'])).toBe('first\nsecond\ntask third')
    expect(await runGit(fixture.localPath, ['show', ':merge.txt'])).toBe('local first\nsecond\ntask third')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('merge.txt')
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('')
  })

  test('Given Local is detached When Finish is requested Then it refuses before mutating Local', async () => {
    const fixture = await createFixture()
    await runGit(fixture.localPath, ['checkout', '--detach', fixture.baseOid])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'task\n')
    const beforeStatus = await runGit(fixture.localPath, ['status', '--porcelain=v1'])
    const engine = createSessionCheckoutApplyEngine()

    const result = await engine.finish(await readyPlan(engine, fixture), { commitMessage: 'fix: task' })

    expect(result).toEqual({
      status: 'error',
      error: { code: 'operation_not_allowed', message: 'Local 当前不是普通分支，不能自动创建任务提交' },
    })
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe(beforeStatus)
  })

  test('Given Worktree has no remaining delta When Finish runs Then it does not create an empty commit', async () => {
    const fixture = await createFixture()
    const engine = createSessionCheckoutApplyEngine()

    const result = await engine.finish(await readyPlan(engine, fixture), { commitMessage: 'fix: no-op' })

    expect(result.status).toBe('finished')
    if (result.status !== 'finished') throw new Error(`预期 finished，实际为 ${result.status}`)
    expect(result.commitOid).toBeNull()
    expect(result.changedFiles).toEqual([])
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(fixture.baseOid)
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe('')
  })

  test('Given Local already has staged work When unrelated Isolated changes are applied Then the original index is preserved', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'local-staged.txt'), 'local staged\n')
    await runGit(fixture.localPath, ['add', 'local-staged.txt'])
    const stagedBefore = await runGit(fixture.localPath, ['diff', '--cached', '--binary'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.apply(await readyPlan(engine, fixture))

    expect(result.status).toBe('applied')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--binary'])).toBe(stagedBefore)
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('tracked.txt')
  })

  test('Given Local staged work and Isolated edits are on different lines of one file When applied Then the original staged blob is unchanged', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'merge.txt'), 'local first\nsecond\nthird\n')
    await runGit(fixture.localPath, ['add', 'merge.txt'])
    const stagedBlobBefore = await runGit(fixture.localPath, ['show', ':merge.txt'])
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\nsecond\nisolated third\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.apply(await readyPlan(engine, fixture))

    expect(result).toMatchObject({ status: 'applied', changedFiles: ['merge.txt'] })
    expect(await runGit(fixture.localPath, ['show', ':merge.txt'])).toBe(stagedBlobBefore)
    expect(await readFile(join(fixture.localPath, 'merge.txt'), 'utf8')).toBe('local first\nsecond\nisolated third\n')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('merge.txt')
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('merge.txt')
  })

  test('Given Local and Isolated modify different files When planned Then both sides merge without touching Local before apply', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'merge.txt'), 'local unstaged\nsecond\nthird\n')
    await writeFile(join(fixture.localPath, 'local-only.txt'), 'local untracked\n')
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated\n')
    const localStatusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)

    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe(localStatusBefore)
    expect(await engine.apply(plan)).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
    expect(await readFile(join(fixture.localPath, 'merge.txt'), 'utf8')).toBe('local unstaged\nsecond\nthird\n')
    expect(await readFile(join(fixture.localPath, 'local-only.txt'), 'utf8')).toBe('local untracked\n')
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('isolated\n')
  })

  test('Given Isolated was rebased onto the latest Local HEAD When its feature further edits that Local change Then Apply uses the shared history instead of reporting a false conflict', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'local shared revision\n')
    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local advances'])
    const localHead = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])

    // 等价于 Agent 将专用 Worktree rebase 到最新 Local HEAD 后继续实现功能。
    await runGit(fixture.isolatedPath, ['checkout', '--detach', localHead])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated feature based on local revision\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated feature'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)
    expect(plan.baseStrategy).toBe('isolated_contains_local_head')
    expect(plan.effectiveBaseOid).toBe(localHead)
    expect(plan.localHeadOid).toBe(localHead)
    const result = await engine.apply(plan)

    expect(result).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('isolated feature based on local revision\n')
    expect(await runGit(fixture.localPath, ['rev-parse', 'HEAD'])).toBe(localHead)
    expect(await runGit(fixture.localPath, ['diff', '--name-only'])).toBe('tracked.txt')
  })

  test('Given a successful first Apply When Isolated changes again Then the internal snapshot remains the recorded base for the second incremental Apply', async () => {
    const fixture = await createFixture()
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'first isolated delivery\n')

    const firstPlan = await readyPlan(engine, fixture)
    const firstResult = await engine.apply(firstPlan)
    expect(firstResult.status).toBe('applied')
    if (firstResult.status !== 'applied') throw new Error('预期首次 Apply 成功')

    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\nsecond\nsecond delivery\n')
    const secondPlan = await readyPlan(engine, { ...fixture, baseOid: firstResult.nextBaseOid })

    expect(secondPlan.baseStrategy).toBe('recorded_base')
    expect(secondPlan.effectiveBaseOid).toBe(firstResult.nextBaseOid)
    expect(secondPlan.changedFiles).toEqual(['merge.txt'])
    expect(await engine.apply(secondPlan)).toMatchObject({ status: 'applied', changedFiles: ['merge.txt'] })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('first isolated delivery\n')
    expect(await readFile(join(fixture.localPath, 'merge.txt'), 'utf8')).toBe('first\nsecond\nsecond delivery\n')
  })

  test('Given both real HEADs diverge after a successful Apply When planning again Then the internal snapshot is excluded from shared history and only pending work is applied', async () => {
    const fixture = await createFixture()
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'first isolated delivery\n')

    const firstResult = await engine.apply(await readyPlan(engine, fixture))
    expect(firstResult.status).toBe('applied')
    if (firstResult.status !== 'applied') throw new Error('预期首次 Apply 成功')

    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'accept first delivery locally'])
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'checkpoint first delivery'])
    await writeFile(join(fixture.localPath, 'local-follow-up.txt'), 'local follow-up\n')
    await runGit(fixture.localPath, ['add', 'local-follow-up.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local follows up'])
    await writeFile(join(fixture.isolatedPath, 'isolated-follow-up.txt'), 'isolated follow-up\n')
    await runGit(fixture.isolatedPath, ['add', 'isolated-follow-up.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated follows up'])

    const plan = await readyPlan(engine, { ...fixture, baseOid: firstResult.nextBaseOid })

    expect(plan.baseStrategy).toBe('shared_merge_base')
    expect(plan.effectiveBaseOid).toBe(fixture.baseOid)
    expect(plan.changedFiles).toEqual(['isolated-follow-up.txt'])
    expect(await engine.apply(plan)).toMatchObject({ status: 'applied', changedFiles: ['isolated-follow-up.txt'] })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('first isolated delivery\n')
    expect(await readFile(join(fixture.localPath, 'local-follow-up.txt'), 'utf8')).toBe('local follow-up\n')
    expect(await readFile(join(fixture.localPath, 'isolated-follow-up.txt'), 'utf8')).toBe('isolated follow-up\n')
  })

  test('Given Local contains the committed Isolated HEAD When Isolated has uncommitted remainder Then only that remainder is applied', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated committed\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated committed'])
    const isolatedHead = await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])
    await runGit(fixture.localRepositoryPath, ['merge', '--ff-only', isolatedHead])
    await writeFile(join(fixture.localRepositoryPath, 'local-after.txt'), 'local later commit\n')
    await runGit(fixture.localRepositoryPath, ['add', 'local-after.txt'])
    await runGit(fixture.localRepositoryPath, ['commit', '-m', 'local later'])
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\nsecond\nisolated remainder\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)

    expect(plan.baseStrategy).toBe('local_contains_isolated_head')
    expect(plan.effectiveBaseOid).toBe(isolatedHead)
    expect(plan.changedFiles).toEqual(['merge.txt'])
    expect(await engine.apply(plan)).toMatchObject({ status: 'applied', changedFiles: ['merge.txt'] })
    expect(await readFile(join(fixture.localRepositoryPath, 'local-after.txt'), 'utf8')).toBe('local later commit\n')
    expect(await readFile(join(fixture.localPath, 'merge.txt'), 'utf8')).toBe('first\nsecond\nisolated remainder\n')
  })

  test('Given Local contains all committed Isolated work and Isolated has no remainder When planned Then Apply is a safe no-op', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated already included\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated included'])
    const isolatedHead = await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])
    await runGit(fixture.localRepositoryPath, ['merge', '--ff-only', isolatedHead])
    await writeFile(join(fixture.localRepositoryPath, 'local-after.txt'), 'local later\n')
    await runGit(fixture.localRepositoryPath, ['add', 'local-after.txt'])
    await runGit(fixture.localRepositoryPath, ['commit', '-m', 'local later'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)

    expect(plan.baseStrategy).toBe('local_contains_isolated_head')
    expect(plan.changedFiles).toEqual([])
    expect(await engine.apply(plan)).toMatchObject({ status: 'applied', changedFiles: [] })
    expect(await runGit(fixture.localRepositoryPath, ['status', '--porcelain=v1'])).toBe('')
  })

  test('Given Isolated contains Local HEAD and Local also has staged and unstaged unrelated work When applied Then Local layers remain intact', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'shared committed local\n')
    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local shared'])
    const localHead = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])
    await runGit(fixture.isolatedPath, ['checkout', '--detach', localHead])
    await writeFile(join(fixture.isolatedPath, 'merge.txt'), 'first\nsecond\nisolated third\n')
    await writeFile(join(fixture.localPath, 'local-staged.txt'), 'keep staged\n')
    await runGit(fixture.localPath, ['add', 'local-staged.txt'])
    await writeFile(join(fixture.localPath, 'local-unstaged.txt'), 'keep unstaged\n')
    const stagedBefore = await runGit(fixture.localPath, ['diff', '--cached', '--binary'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)

    expect(plan.baseStrategy).toBe('isolated_contains_local_head')
    expect(await engine.apply(plan)).toMatchObject({ status: 'applied', changedFiles: ['merge.txt'] })
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--binary'])).toBe(stagedBefore)
    expect(await readFile(join(fixture.localPath, 'local-unstaged.txt'), 'utf8')).toBe('keep unstaged\n')
  })

  test('Given Isolated contains Local HEAD but Local dirty work changes the same region When planning Then the true content conflict still leaves Local unchanged', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'shared committed local\n')
    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local shared'])
    const localHead = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])
    await runGit(fixture.isolatedPath, ['checkout', '--detach', localHead])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated feature\n')
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'local dirty conflict\n')
    const localBefore = await readFile(join(fixture.localPath, 'tracked.txt'))
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.plan(fixture)

    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') throw new Error('预期真实内容冲突')
    expect(result.baseStrategy).toBe('isolated_contains_local_head')
    expect(result.effectiveBaseOid).toBe(localHead)
    expect(result.conflictingFiles).toEqual(['tracked.txt'])
    expect(await readFile(join(fixture.localPath, 'tracked.txt'))).toEqual(localBefore)
  })

  test('Given a monorepo Local outside-project commit is inherited by Isolated When applying project changes Then it is not rejected as an Isolated boundary escape', async () => {
    const fixture = await createFixture({ projectSubdirectory: join('packages', 'app') })
    await writeFile(join(fixture.localRepositoryPath, 'outside.txt'), 'outside inherited\n')
    await runGit(fixture.localRepositoryPath, ['add', 'outside.txt'])
    await runGit(fixture.localRepositoryPath, ['commit', '-m', 'outside local change'])
    const localHead = await runGit(fixture.localRepositoryPath, ['rev-parse', 'HEAD'])
    await runGit(fixture.isolatedRepositoryPath, ['checkout', '--detach', localHead])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'project-only feature\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, fixture)

    expect(plan.baseStrategy).toBe('isolated_contains_local_head')
    expect(plan.changedFiles).toEqual(['tracked.txt'])
    expect(await engine.apply(plan)).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
    expect(await readFile(join(fixture.localRepositoryPath, 'outside.txt'), 'utf8')).toBe('outside inherited\n')
  })

  test('Given recorded base is not an ancestor of the shared candidate When planning Then dynamic ancestry cannot advance the base', async () => {
    const fixture = await createFixture()
    const baseTree = await runGit(fixture.localRepositoryPath, ['rev-parse', `${fixture.baseOid}^{tree}`])
    const unrelatedRecordedBase = await runGit(fixture.localRepositoryPath, ['commit-tree', baseTree, '-m', 'unrelated recorded base'])
    await writeFile(join(fixture.localRepositoryPath, 'local-shared.txt'), 'shared local commit\n')
    await runGit(fixture.localRepositoryPath, ['add', 'local-shared.txt'])
    await runGit(fixture.localRepositoryPath, ['commit', '-m', 'local advances'])
    const localHead = await runGit(fixture.localRepositoryPath, ['rev-parse', 'HEAD'])
    await runGit(fixture.isolatedRepositoryPath, ['checkout', '--detach', localHead])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated feature\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, { ...fixture, baseOid: unrelatedRecordedBase })

    expect(plan.baseStrategy).toBe('recorded_base')
    expect(plan.effectiveBaseOid).toBe(unrelatedRecordedBase)
  })

  test('Given Local was reset away from a recorded base that remains in Isolated history When both sides diverge Then planning uses their unique shared merge-base', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'old-local.txt'), 'old Local history\n')
    await runGit(fixture.localPath, ['add', 'old-local.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'old local history'])
    const staleRecordedBase = await runGit(fixture.localPath, ['rev-parse', 'HEAD'])

    await runGit(fixture.isolatedPath, ['checkout', '--detach', staleRecordedBase])
    await writeFile(join(fixture.isolatedPath, 'isolated-after-reset.txt'), 'isolated task\n')
    await runGit(fixture.isolatedPath, ['add', 'isolated-after-reset.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated continues old history'])

    await runGit(fixture.localPath, ['reset', '--hard', fixture.baseOid])
    await writeFile(join(fixture.localPath, 'local-after-reset.txt'), 'rewritten Local history\n')
    await runGit(fixture.localPath, ['add', 'local-after-reset.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'rewrite local history'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, { ...fixture, baseOid: staleRecordedBase })

    expect(plan.baseStrategy).toBe('shared_merge_base')
    expect(plan.effectiveBaseOid).toBe(fixture.baseOid)
    expect(plan.changedFiles).toEqual(['isolated-after-reset.txt', 'old-local.txt'])
    expect(await engine.apply(plan)).toMatchObject({
      status: 'applied',
      changedFiles: ['isolated-after-reset.txt', 'old-local.txt'],
    })
    expect(await readFile(join(fixture.localPath, 'local-after-reset.txt'), 'utf8')).toBe('rewritten Local history\n')
  })

  test('Given the raw Git merge-base is a Domi Apply snapshot When histories diverge Then planning peels it to the shared business parent', async () => {
    const fixture = await createFixture()
    const baseTree = await runGit(fixture.localPath, ['rev-parse', `${fixture.baseOid}^{tree}`])
    const staleRecordedBase = await runGit(fixture.localPath, ['commit-tree', baseTree, '-p', fixture.baseOid, '-m', 'stale recorded base'])

    await runGit(fixture.localPath, ['config', 'user.name', 'Domi Apply'])
    await runGit(fixture.localPath, ['config', 'user.email', 'domi-apply@localhost'])
    const internalSnapshot = await runGit(fixture.localPath, [
      'commit-tree', baseTree, '-p', fixture.baseOid, '-m', 'Applied Isolated snapshot',
    ])
    await runGit(fixture.localPath, ['config', 'user.name', 'Domi Test'])
    await runGit(fixture.localPath, ['config', 'user.email', 'test@example.com'])

    await runGit(fixture.localPath, ['reset', '--hard', internalSnapshot])
    await writeFile(join(fixture.localPath, 'local-after-snapshot.txt'), 'local branch\n')
    await runGit(fixture.localPath, ['add', 'local-after-snapshot.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local after internal snapshot'])
    await runGit(fixture.isolatedPath, ['checkout', '--detach', internalSnapshot])
    await writeFile(join(fixture.isolatedPath, 'isolated-after-snapshot.txt'), 'isolated branch\n')
    await runGit(fixture.isolatedPath, ['add', 'isolated-after-snapshot.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated after internal snapshot'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const plan = await readyPlan(engine, { ...fixture, baseOid: staleRecordedBase })

    expect(await runGit(fixture.localPath, ['merge-base', 'HEAD', await runGit(fixture.isolatedPath, ['rev-parse', 'HEAD'])])).toBe(internalSnapshot)
    expect(plan.baseStrategy).toBe('shared_merge_base')
    expect(plan.effectiveBaseOid).toBe(fixture.baseOid)
    expect(plan.effectiveBaseOid).not.toBe(internalSnapshot)
    expect(plan.changedFiles).toEqual(['isolated-after-snapshot.txt'])
  })

  test('Given Local and Isolated committed histories diverge from the recorded base When planning Then recorded-base conflict semantics remain fail-closed', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'local committed conflict\n')
    await runGit(fixture.localPath, ['add', 'tracked.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local diverges'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated committed conflict\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated diverges'])
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.plan(fixture)

    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') throw new Error('预期 divergent 冲突')
    expect(result.baseStrategy).toBe('recorded_base')
    expect(result.effectiveBaseOid).toBe(fixture.baseOid)
    expect(result.conflictingFiles).toEqual(['tracked.txt'])
  })

  test('Given both sides change the same text region When planning Then conflicts are listed and Local is byte-for-byte unchanged', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'local\n')
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated\n')
    const localStatusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-z'])
    const localContentBefore = await readFile(join(fixture.localPath, 'tracked.txt'))
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.plan(fixture)

    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') throw new Error(`预期 conflict，实际为 ${result.status}`)
    expect(result.conflictingFiles).toEqual(['tracked.txt'])
    expect(result.revision.length).toBeGreaterThan(0)
    expect(result.localFingerprint.length).toBe(64)
    expect(result.isolatedFingerprint.length).toBe(64)
    expect(result.localHeadOid).toBe(await runGit(fixture.localPath, ['rev-parse', 'HEAD']))
    expect(await readFile(join(fixture.localPath, 'tracked.txt'))).toEqual(localContentBefore)
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-z'])).toBe(localStatusBefore)
  })

  test('Given both sides replace the same binary file When planning Then it conflicts without overwriting Local', async () => {
    const fixture = await createFixture()
    const localBytes = Buffer.from([0, 10, 20, 30])
    await writeFile(join(fixture.localPath, 'binary.dat'), localBytes)
    await writeFile(join(fixture.isolatedPath, 'binary.dat'), Buffer.from([0, 40, 50, 60]))
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.plan(fixture)

    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') throw new Error(`预期 conflict，实际为 ${result.status}`)
    expect(result.conflictingFiles).toEqual(['binary.dat'])
    expect(await readFile(join(fixture.localPath, 'binary.dat'))).toEqual(localBytes)
  })

  test('Given Isolated has staged and unstaged layers When applied Then its final working-tree bytes are transferred', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated staged\n')
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated final unstaged\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.apply(await readyPlan(engine, fixture))

    expect(result).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('isolated final unstaged\n')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
  })

  test('Given Isolated has an untracked Unicode file When applied Then the file is created as unstaged Local work', async () => {
    const fixture = await createFixture()
    const relativePath = '新文件 with space.txt'
    await writeFile(join(fixture.isolatedPath, relativePath), 'untracked content\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.apply(await readyPlan(engine, fixture))

    expect(result).toMatchObject({ status: 'applied', changedFiles: [relativePath] })
    expect(await readFile(join(fixture.localPath, relativePath), 'utf8')).toBe('untracked content\n')
    expect(await runGit(fixture.localPath, ['ls-files', '--others', '--exclude-standard'])).toBe(relativePath)
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
  })

  test('Given Isolated deletes a tracked file When applied Then Local records an unstaged deletion', async () => {
    const fixture = await createFixture()
    await unlink(join(fixture.isolatedPath, 'tracked.txt'))
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.apply(await readyPlan(engine, fixture))

    expect(result).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
    expect(await runGit(fixture.localPath, ['diff', '--name-status'])).toBe('D\ttracked.txt')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
    await expect(lstat(join(fixture.localPath, 'tracked.txt'))).rejects.toThrow()
  })

  test('Given Isolated changes binary bytes When applied Then Local receives the exact unstaged binary content', async () => {
    const fixture = await createFixture()
    const expected = Buffer.from([0, 255, 17, 34, 0, 128, 64])
    await writeFile(join(fixture.isolatedPath, 'binary.dat'), expected)
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

    const result = await engine.apply(await readyPlan(engine, fixture))

    expect(result).toMatchObject({ status: 'applied', changedFiles: ['binary.dat'] })
    expect(await readFile(join(fixture.localPath, 'binary.dat'))).toEqual(expected)
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
    expect(await runGit(fixture.localPath, ['diff', '--numstat'])).toBe('-\t-\tbinary.dat')
  })

  test('Given a caller tampers with a reviewed plan When apply is requested Then invalid_plan prevents all writes', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated planned\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    const plan = await readyPlan(engine, fixture)
    plan.changedFiles.push('not-reviewed.txt')

    const result = await engine.apply(plan)

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('预期 invalid_plan')
    expect(result.error.code).toBe('invalid_plan')
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1'])).toBe('')
  })

  test('Given Local changes after planning When apply is requested Then stale_local is returned without applying any Isolated bytes', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated planned\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    const plan = await readyPlan(engine, fixture)
    await writeFile(join(fixture.localPath, 'tracked.txt'), 'local after plan\n')
    const statusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-z'])

    const result = await engine.apply(plan)

    expect(result).toEqual({
      status: 'error',
      error: { code: 'stale_local', message: 'Local 在 plan 后发生变化，请重新计算' },
    })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('local after plan\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-z'])).toBe(statusBefore)
  })

  test('Given Local creates a commit after planning When apply is requested Then explicit HEAD validation returns stale_local', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated planned\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    const plan = await readyPlan(engine, fixture)
    await writeFile(join(fixture.localPath, 'local-after-plan.txt'), 'new Local commit\n')
    await runGit(fixture.localPath, ['add', 'local-after-plan.txt'])
    await runGit(fixture.localPath, ['commit', '-m', 'local after plan'])

    const result = await engine.apply(plan)

    expect(result).toEqual({
      status: 'error',
      error: { code: 'stale_local', message: 'Local 在 plan 后发生变化，请重新计算' },
    })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
  })

  test('Given Local changes after the persistent Isolated snapshot When the final write is about to start Then stale_local still prevents the patch', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated planned\n')
    const engine = createSessionCheckoutApplyEngine({
      beforeFinalLocalValidation: async () => {
        await writeFile(join(fixture.localPath, 'merge.txt'), 'late local change\n')
      },
    })
    const plan = await readyPlan(engine, fixture)

    const result = await engine.apply(plan)

    expect(result).toEqual({
      status: 'error',
      error: { code: 'stale_local', message: 'Local 在 Apply 写入前发生变化，请重新计算' },
    })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(join(fixture.localPath, 'merge.txt'), 'utf8')).toBe('late local change\n')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
  })

  test('Given only Local staging state changes after planning When apply is requested Then the plan is stale even if final bytes match', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.localPath, 'merge.txt'), 'local first\nsecond\nthird\n')
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated planned\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    const plan = await readyPlan(engine, fixture)
    await runGit(fixture.localPath, ['add', 'merge.txt'])

    const result = await engine.apply(plan)

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('预期 stale_local')
    expect(result.error.code).toBe('stale_local')
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('merge.txt')
  })

  test('Given Isolated commits the reviewed bytes after planning When apply is requested Then explicit HEAD validation returns stale_isolated', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.isolatedPath, 'tracked.txt'), 'isolated planned\n')
    const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()
    const plan = await readyPlan(engine, fixture)
    await runGit(fixture.isolatedPath, ['add', 'tracked.txt'])
    await runGit(fixture.isolatedPath, ['commit', '-m', 'isolated after plan'])
    const localStatusBefore = await runGit(fixture.localPath, ['status', '--porcelain=v1', '-z'])

    const result = await engine.apply(plan)

    expect(result).toEqual({
      status: 'error',
      error: { code: 'stale_isolated', message: 'Isolated 在 plan 后发生变化，请重新计算' },
    })
    expect(await readFile(join(fixture.localPath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await runGit(fixture.localPath, ['status', '--porcelain=v1', '-z'])).toBe(localStatusBefore)
  })

  ;(process.platform === 'win32' ? test.skip : test)(
    'Given Isolated changes executable mode When applied Then Local receives an unstaged mode change',
    async () => {
      const fixture = await createFixture()
      await runGit(fixture.localPath, ['config', 'core.filemode', 'true'])
      await chmod(join(fixture.isolatedPath, 'tracked.txt'), 0o755)
      const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

      const result = await engine.apply(await readyPlan(engine, fixture))

      expect(result).toMatchObject({ status: 'applied', changedFiles: ['tracked.txt'] })
      expect((await lstat(join(fixture.localPath, 'tracked.txt'))).mode & 0o111).not.toBe(0)
      expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
    },
  )

  ;(process.platform === 'win32' ? test.skip : test)(
    'Given symlinks are available and Isolated adds one When applied Then Local receives an unstaged symlink',
    async () => {
      const fixture = await createFixture()
      await symlink('tracked.txt', join(fixture.isolatedPath, 'tracked-link'))
      const engine: SessionCheckoutApplyEngine = createSessionCheckoutApplyEngine()

      const result = await engine.apply(await readyPlan(engine, fixture))

      expect(result).toMatchObject({ status: 'applied', changedFiles: ['tracked-link'] })
      expect((await lstat(join(fixture.localPath, 'tracked-link'))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(fixture.localPath, 'tracked-link'))).toBe('tracked.txt')
      expect(await runGit(fixture.localPath, ['diff', '--cached', '--name-only'])).toBe('')
    },
  )
})
