import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gitLongPathArgs, GitCommandInterruptedError } from './git-execution-policy.ts'
import { createNodeSessionCheckoutDependencies } from './production-adapters.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'domi-long-'))
  roots.push(root)
  const repository = join(root, 'repo')
  git(root, 'init', '-q', repository)
  git(repository, 'config', 'user.name', 'Domi Test')
  git(repository, 'config', 'user.email', 'domi@example.test')
  git(repository, 'config', 'core.longpaths', 'false')
  git(repository, 'config', 'core.autocrlf', 'false')
  const relative = join('a'.repeat(60), 'b'.repeat(60), 'file.txt')
  mkdirSync(dirname(join(repository, relative)), { recursive: true })
  writeFileSync(join(repository, relative), '长路径内容\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'base')
  const options = {
    configDir: join(root, 'config'),
    lookup: {
      getSession: () => undefined, getProject: () => undefined,
      isSessionActive: () => false, markDelegationCheckoutReleased: () => {},
      markInheritedCheckoutReleased: () => {}, getUnboundTargetPolicy: () => 'unselected' as const,
    },
  }
  return { root, repository, relative, options }
}

test('Given Windows When 构建长路径参数 Then 只改变当前命令且其他平台不附加', () => {
  expect(gitLongPathArgs('win32')).toEqual(['-c', 'core.longpaths=true'])
  expect(gitLongPathArgs('linux')).toEqual([])
})

test.skipIf(process.platform !== 'win32')('Given 用户禁用长路径 When 创建超过260字符的Worktree文件 Then 检出与状态成功且配置不变', async () => {
  const { root, repository, relative, options } = setup()
  const target = join(root, 'managed-'.repeat(15))
  expect(join(target, relative).length).toBeGreaterThan(260)
  const dependencies = createNodeSessionCheckoutDependencies(options)
  await dependencies.git.createDetachedWorktree(repository, target, git(repository, 'rev-parse', 'HEAD'))
  expect(readFileSync(join(target, relative), 'utf8')).toBe('长路径内容\n')
  expect(await dependencies.git.status(target)).toEqual({ dirty: false })
  writeFileSync(join(target, relative), '长路径更新\n')
  const plan = await dependencies.applyEngine.plan({
    localPath: repository, isolatedPath: target, baseOid: git(repository, 'rev-parse', 'HEAD'),
  })
  expect(plan.status).toBe('ready')
  if (plan.status !== 'ready') throw new Error('长路径验收 plan 失败')
  expect((await dependencies.applyEngine.apply(plan.plan)).status).toBe('applied')
  expect(readFileSync(join(repository, relative), 'utf8')).toBe('长路径更新\n')
  // 不使用 helper 的 -c 覆盖，检查磁盘中的用户配置。
  const config = spawnSync('git', ['config', '--local', '--get', 'core.longpaths'], { cwd: repository, encoding: 'utf8' })
  expect(config.stdout.trim()).toBe('false')
}, 30_000)

test('Given 创建预算耗尽 When 真实Git终止请求结束 Then 返回不可用于自动清理的超时错误', async () => {
  const { root, repository, options } = setup()
  const dependencies = createNodeSessionCheckoutDependencies({ ...options, worktreeCreateTimeoutMs: 1 })
  await expect(dependencies.git.createDetachedWorktree(repository, join(root, 'interrupted'), git(repository, 'rev-parse', 'HEAD')))
    .rejects.toBeInstanceOf(GitCommandInterruptedError)
}, 30_000)
