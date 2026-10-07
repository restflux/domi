import { afterEach, describe, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeSessionCheckoutDependencies } from './production-adapters.ts'
import { createSessionCheckoutModule } from './session-checkout-module.ts'
import { WorktreeLocalFilesService } from '../worktree-local-files/service.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (code !== 0) throw new Error(stderr)
  return stdout.trim()
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'domi-local-files-lifecycle-'))
  roots.push(root)
  const localRoot = join(root, 'project')
  await mkdir(localRoot)
  await git(localRoot, 'init', '-b', 'main')
  await writeFile(join(localRoot, 'work.txt'), 'base\n')
  await git(localRoot, 'add', '.')
  await git(localRoot, 'commit', '-m', 'base')
  await writeFile(join(localRoot, '.env.local'), 'CONFIG=private\n')
  const active = new Set<string>()
  const dependencies = createNodeSessionCheckoutDependencies({ configDir: join(root, 'config'), lookup: {
    getSession: (id) => ({ id, projectId: 'project' }),
    getProject: (id) => id === 'project' ? { id, name: 'Test', root: localRoot } : undefined,
    isSessionActive: (id) => active.has(id),
    markDelegationCheckoutReleased: () => {}, markInheritedCheckoutReleased: () => {},
    getUnboundTargetPolicy: () => 'unselected',
  } })
  let copyFailure = false
  let rejected = false
  dependencies.localFiles = {
    preflight: async () => {
      if (rejected) throw new Error('新增文件尚未确认')
      return { paths: ['.env.local'], manifestVersion: 'v1' }
    },
    copy: async (_project, targetRoot) => {
      if (copyFailure) throw new Error('复制被中断')
      await copyFile(join(localRoot, '.env.local'), join(targetRoot, '.env.local'))
      return { copied: ['.env.local'], skipped: [] }
    },
    inspectTarget: async () => [],
  }
  return {
    dependencies, active, localRoot, module: createSessionCheckoutModule(dependencies),
    failCopy: () => { copyFailure = true }, allowCopy: () => { copyFailure = false },
    rejectPlan: () => { rejected = true },
  }
}

describe('Worktree 本地配置生命周期', () => {
  test('所选分支已跟踪配置路径时在创建前拒绝，不留下不可恢复的配置凭证', async () => {
    const context = await fixture()
    const base = await git(context.localRoot, 'rev-parse', 'HEAD')
    await git(context.localRoot, 'switch', '-c', 'tracked-config')
    await git(context.localRoot, 'add', '.env.local')
    await git(context.localRoot, 'commit', '-m', 'track config')
    await git(context.localRoot, 'switch', '--detach', base)
    await writeFile(join(context.localRoot, '.env.local'), 'CONFIG=private\n')
    const service = new WorktreeLocalFilesService({ storagePath: join(context.localRoot, '..', 'approvals.json') })
    await service.save({ id: 'project', root: context.localRoot }, ['.env.local'], 'missing')
    context.dependencies.localFiles = service
    await expect(context.module.bind('owner', { kind: 'isolated', sourceBranch: 'tracked-config' })).rejects.toMatchObject({ code: 'local_files_required', message: '不能准备由 Git 管理的源文件或目标文件' })
    expect(Object.keys(context.dependencies.registry.read().managedCheckouts)).toEqual([])
  })
  test('累计排除路径达到凭证上限时，在变更 revision 或复制前拒绝新路径', async () => {
    const context = await fixture()
    const view = await context.module.bind('owner', { kind: 'isolated' })
    const registry = context.dependencies.registry.read()
    const record = Object.values(registry.managedCheckouts)[0]!
    record.localFiles = { paths: Array.from({ length: 128 }, (_, index) => `old-${index}.json`), manifestVersion: 'v1', state: 'ready' }
    context.dependencies.registry.write(registry)
    await expect(context.module.prepareLocalFiles!('owner', view.revision)).rejects.toMatchObject({ code: 'operation_not_allowed' })
    expect(context.dependencies.registry.read().managedCheckouts[record.checkoutId]?.revision).toBe(view.revision)
  })
  test('独立 Fork 从 Local 准备配置，不继承来源 Worktree 的配置字节', async () => {
    const context = await fixture()
    const source = await context.module.bind('owner', { kind: 'isolated' })
    const sourceLease = await context.module.lease('owner')
    await writeFile(join(sourceLease.cwd, '.env.local'), 'CONFIG=parent-only\n')
    await writeFile(join(sourceLease.cwd, 'work.txt'), 'fork work\n')
    await context.module.cloneIsolatedTarget('owner', 'fork', source.revision)
    const forkLease = await context.module.lease('fork')
    expect(await readFile(join(forkLease.cwd, '.env.local'), 'utf8')).toBe('CONFIG=private\n')
    expect(await readFile(join(forkLease.cwd, 'work.txt'), 'utf8')).toBe('fork work\n')
  })

  test('Given 未确认路径 When 创建 Worktree Then 在创建前停止且不产生 checkout', async () => {
    const context = await fixture()
    context.rejectPlan()
    await expect(context.module.bind('owner', { kind: 'isolated' })).rejects.toMatchObject({ code: 'local_files_required' })
    expect(Object.keys(context.dependencies.registry.read().managedCheckouts)).toEqual([])
  })
  test('Given 已确认配置 When 创建并重启 Then 可使用独立配置副本但交付排除仍有效', async () => {
    const context = await fixture()
    await context.module.bind('owner', { kind: 'isolated' })
    const lease = await context.module.lease('owner')
    expect(await readFile(join(lease.cwd, '.env.local'), 'utf8')).toBe('CONFIG=private\n')
    await writeFile(join(lease.cwd, '.env.local'), 'CONFIG=changed\n')
    expect(await readFile(join(context.localRoot, '.env.local'), 'utf8')).toBe('CONFIG=private\n')
    const restarted = createSessionCheckoutModule(context.dependencies)
    expect(restarted.isRuntimeFile!(lease.cwd, join(lease.cwd, '.env.local'))).toBe(true)
    await writeFile(join(lease.cwd, 'work.txt'), 'done\n')
    const review = await restarted.markReadyForReview('owner', { summary: '实现任务', validationStatus: 'passed', tests: [], suggestedCommitMessage: 'feat: 任务' })
    expect(review.delivery?.state).toBe('ready_for_review')
    if (review.delivery?.state === 'ready_for_review') expect(review.delivery.review.changedFiles).toEqual(['work.txt'])
  })
  test('Given 复制失败 When 重启和补复制 Then 保留排除并在补齐前拒绝运行', async () => {
    const context = await fixture()
    context.failCopy()
    await expect(context.module.bind('owner', { kind: 'isolated' })).rejects.toMatchObject({ code: 'local_files_required' })
    const restarted = createSessionCheckoutModule(context.dependencies)
    await expect(restarted.lease('owner')).rejects.toMatchObject({ code: 'local_files_required' })
    const view = await restarted.inspect('owner')
    context.allowCopy()
    expect(await restarted.prepareLocalFiles!('owner', view.revision)).toEqual({ copied: ['.env.local'], skipped: [] })
    expect((await restarted.lease('owner')).kind).toBe('isolated')
  })
  test('Given 活跃共享会话或错误 owner/revision When 补复制 Then 拒绝修改', async () => {
    const context = await fixture()
    const view = await context.module.bind('owner', { kind: 'isolated' })
    await context.module.bind('child', { kind: 'inherit', parentSessionId: 'owner' })
    context.active.add('child')
    await expect(context.module.prepareLocalFiles!('owner', view.revision)).rejects.toThrow()
    context.active.clear()
    await expect(context.module.prepareLocalFiles!('child', view.revision)).rejects.toThrow()
    await expect(context.module.prepareLocalFiles!('owner', 999)).rejects.toMatchObject({ code: 'stale_target' })
  })
})
