import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeLocalFilesService } from './service'

let directory: string
let project: { id: string; root: string }
let target: string
let service: WorktreeLocalFilesService

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'domi-local-files-'))
  project = { id: 'project-1', root: join(directory, 'source') }
  target = join(directory, 'target')
  await mkdir(project.root)
  await mkdir(target)
  execFileSync('git', ['init', '-q', project.root])
  execFileSync('git', ['init', '-q', target])
  service = new WorktreeLocalFilesService({ storagePath: join(directory, 'config', 'approvals.json') })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function approve(paths: string[]): Promise<void> {
  await writeFile(join(project.root, '.worktreeinclude'), `${paths.join('\n')}\n`)
  const view = await service.inspect(project)
  await service.confirm(project, view.manifestVersion)
}

describe('本机确认与复制', () => {
  test('清单不是授权，只有明确确认后才能复制独立的非受控文件', async () => {
    await writeFile(join(project.root, '.env.local'), 'secret=value\n', { mode: 0o600 })
    await writeFile(join(project.root, '.worktreeinclude'), '# 本机\n.env.local\n')
    const before = await service.inspect(project)
    expect(before.entries).toEqual([{ path: '.env.local', status: 'unapproved' }])
    await expect(service.preflight(project)).rejects.toMatchObject({ code: 'unapproved_file' })
    await service.confirm(project, before.manifestVersion)
    const plan = await service.preflight(project)
    expect(await service.copy(project, target, plan)).toEqual({ copied: ['.env.local'], skipped: [] })
    await writeFile(join(target, '.env.local'), 'target-only')
    expect(await readFile(join(project.root, '.env.local'), 'utf8')).toBe('secret=value\n')
  })

  test('用户保存并批准清单使用内容 CAS 且保留注释', async () => {
    await writeFile(join(project.root, 'old.json'), '{}')
    await writeFile(join(project.root, 'new.json'), '{}')
    await writeFile(join(project.root, '.worktreeinclude'), '# 配置\n\nold.json\n# 下一段\n')
    const before = await service.inspect(project)
    const saved = await service.save(project, ['new.json'], before.manifestVersion)
    expect(await readFile(join(project.root, '.worktreeinclude'), 'utf8')).toBe('# 配置\n\n# 下一段\nnew.json\n')
    expect(saved.entries).toEqual([{ path: 'new.json', status: 'ready' }])
    await expect(service.save(project, ['old.json'], before.manifestVersion)).rejects.toMatchObject({ code: 'manifest_changed' })
    await expect(service.confirm(project, before.manifestVersion)).rejects.toMatchObject({ code: 'manifest_changed' })
  })

  test('外部清单新增文件不会继承授权，授权绑定项目标识与 canonical root', async () => {
    await writeFile(join(project.root, 'local.json'), '{}')
    await writeFile(join(project.root, 'new.json'), '{}')
    await approve(['local.json'])
    await expect(service.preflight({ ...project, id: 'other-project' })).rejects.toMatchObject({ code: 'unapproved_file' })
    const other = join(directory, 'other')
    await mkdir(other)
    execFileSync('git', ['init', '-q', other])
    await writeFile(join(other, 'local.json'), '{}')
    await writeFile(join(other, '.worktreeinclude'), 'local.json\n')
    await expect(service.preflight({ ...project, root: other })).rejects.toMatchObject({ code: 'unapproved_file' })
    await writeFile(join(project.root, '.worktreeinclude'), 'local.json\nnew.json\n')
    await expect(service.preflight(project)).rejects.toMatchObject({ code: 'unapproved_file' })
    expect(await readFile(join(directory, 'config', 'approvals.json'), 'utf8')).not.toContain('secret=value')
  })

  test('同一路径的项目根目录被替换后不继承原目录批准', async () => {
    await writeFile(join(project.root, 'local.json'), 'original')
    await approve(['local.json'])
    renameSync(project.root, join(directory, 'old-source'))
    await mkdir(project.root)
    execFileSync('git', ['init', '-q', project.root])
    await writeFile(join(project.root, 'local.json'), 'replacement')
    await writeFile(join(project.root, '.worktreeinclude'), 'local.json\n')
    await expect(service.preflight(project)).rejects.toMatchObject({ code: 'unapproved_file' })
  })

  test('目标存在默认跳过，只有最新指纹确认才能覆盖且副本权限不扩大', async () => {
    await writeFile(join(project.root, 'local.json'), 'source', { mode: 0o400 })
    await approve(['local.json'])
    await writeFile(join(target, 'local.json'), 'target')
    const plan = await service.preflight(project)
    expect(await service.copy(project, target, plan)).toEqual({ copied: [], skipped: ['local.json'] })
    const [entry] = await service.inspectTarget(target, plan.paths)
    await writeFile(join(target, 'local.json'), 'changed')
    await expect(service.copy(project, target, plan, [{ path: 'local.json', expectedFingerprint: entry!.fingerprint }])).rejects.toMatchObject({ code: 'target_changed' })
    expect(await readFile(join(target, 'local.json'), 'utf8')).toBe('changed')
    const [fresh] = await service.inspectTarget(target, plan.paths)
    expect(await service.copy(project, target, plan, [{ path: 'local.json', expectedFingerprint: fresh!.fingerprint }])).toEqual({ copied: ['local.json'], skipped: [] })
    expect(await readFile(join(target, 'local.json'), 'utf8')).toBe('source')
    if (process.platform !== 'win32') expect((await lstat(join(target, 'local.json'))).mode & 0o777).toBe(0o400)
    await chmod(join(project.root, 'local.json'), 0o600)
    await writeFile(join(project.root, 'local.json'), 'only-source')
    expect(await readFile(join(target, 'local.json'), 'utf8')).toBe('source')
  })

  test('预检后源文件或清单变化时拒绝复制，不向目标写入', async () => {
    await writeFile(join(project.root, 'local.json'), 'source')
    await approve(['local.json'])
    const plan = await service.preflight(project)
    await writeFile(join(project.root, 'local.json'), 'changed')
    await expect(service.copy(project, target, plan)).rejects.toMatchObject({ code: 'file_changed' })
    expect((await service.inspectTarget(target, plan.paths))[0]!.exists).toBe(false)
    const next = await service.preflight(project)
    await writeFile(join(project.root, '.worktreeinclude'), '# 外部修改\nlocal.json\n')
    await expect(service.copy(project, target, next)).rejects.toMatchObject({ code: 'manifest_changed' })
  })

  test('非法路径、符号链接和 tracked 源或目标全部拒绝', async () => {
    await writeFile(join(project.root, 'local.json'), '{}')
    await expect(service.resolveSelection(project, [join(directory, 'outside.json')], [])).rejects.toMatchObject({ code: 'invalid_path' })
    execFileSync('git', ['-C', project.root, 'add', '--', 'local.json'])
    await writeFile(join(project.root, '.worktreeinclude'), 'local.json\n')
    await expect(service.inspect(project)).rejects.toMatchObject({ code: 'tracked_file' })
    execFileSync('git', ['-C', project.root, 'rm', '--cached', '--', 'local.json'])
    await approve(['local.json'])
    const plan = await service.preflight(project)
    await writeFile(join(target, 'local.json'), 'target')
    execFileSync('git', ['-C', target, 'add', '--', 'local.json'])
    await expect(service.copy(project, target, plan)).rejects.toMatchObject({ code: 'tracked_file' })
    await symlink(join(project.root, 'local.json'), join(project.root, 'link.json'))
    expect(await service.resolveSelection(project, ['link.json'], [])).toMatchObject({ paths: [], skipped: [{ path: 'link.json', reason: '链接或特殊文件不可选择' }] })
    await mkdir(join(project.root, 'folder'))
    await writeFile(join(project.root, 'folder', 'file.json'), '{}')
    await symlink(join(project.root, 'folder'), join(project.root, 'alias'))
    await expect(service.resolveSelection(project, ['alias/file.json'], [])).rejects.toMatchObject({ code: 'unsafe_file' })
  })

  test('损坏或符号链接形式的授权文件 fail closed', async () => {
    await writeFile(join(project.root, 'local.json'), '{}')
    await approve(['local.json'])
    await writeFile(join(directory, 'config', 'approvals.json'), '{invalid')
    await expect(service.preflight(project)).rejects.toMatchObject({ code: 'authorization_corrupt' })
    const viewVersion = (await readFile(join(project.root, '.worktreeinclude'))).toString()
    expect(viewVersion).toBe('local.json\n')
    await rm(join(directory, 'config', 'approvals.json'))
    await symlink(join(project.root, 'local.json'), join(directory, 'config', 'approvals.json'))
    await expect(service.inspect(project)).rejects.toMatchObject({ code: 'authorization_corrupt' })
  })

  test('发布前目标竞争失败，不覆盖竞争者且清理临时文件', async () => {
    await writeFile(join(project.root, 'local.json'), 'source')
    await approve(['local.json'])
    service = new WorktreeLocalFilesService({ storagePath: join(directory, 'config', 'approvals.json'),
      beforePublish: () => { writeFileSync(join(target, 'local.json'), 'competitor') },
    })
    await expect(service.copy(project, target, await service.preflight(project))).rejects.toMatchObject({ code: 'target_changed' })
    expect(await readFile(join(target, 'local.json'), 'utf8')).toBe('competitor')
  })

  test('多文件发布中后续目标竞争失败，撤回此前已发布的文件', async () => {
    await writeFile(join(project.root, 'first.json'), 'first-source')
    await writeFile(join(project.root, 'second.json'), 'second-source')
    await approve(['first.json', 'second.json'])
    await writeFile(join(target, 'first.json'), 'first-original')
    service = new WorktreeLocalFilesService({ storagePath: join(directory, 'config', 'approvals.json'),
      beforePublish: (path) => { if (path === 'second.json') writeFileSync(join(target, path), 'competitor') },
    })
    const plan = await service.preflight(project)
    const [first] = await service.inspectTarget(target, ['first.json'])
    await expect(service.copy(project, target, plan, [{ path: 'first.json', expectedFingerprint: first!.fingerprint }])).rejects.toMatchObject({ code: 'target_changed' })
    expect(await readFile(join(target, 'first.json'), 'utf8')).toBe('first-original')
    expect(await readFile(join(target, 'second.json'), 'utf8')).toBe('competitor')
  })

  test('操作中父目录被 symlink 替换时失败，清理不进入外部目录', async () => {
    await mkdir(join(project.root, 'config'))
    await writeFile(join(project.root, 'config', 'local.json'), 'source')
    await approve(['config/local.json'])
    await mkdir(join(target, 'config'))
    const outside = join(directory, 'outside')
    await mkdir(outside)
    service = new WorktreeLocalFilesService({ storagePath: join(directory, 'config', 'approvals.json'),
      beforePublish: () => {
        renameSync(join(target, 'config'), join(target, 'displaced'))
        symlinkSync(outside, join(target, 'config'))
        writeFileSync(join(outside, 'local.json'), 'outside-preserved')
      },
    })
    await expect(service.copy(project, target, await service.preflight(project))).rejects.toMatchObject({ code: 'file_changed' })
    expect(await readFile(join(outside, 'local.json'), 'utf8')).toBe('outside-preserved')
  })

  test('发布前源竞争失败，不复制已变更内容', async () => {
    await writeFile(join(project.root, 'local.json'), 'source')
    await approve(['local.json'])
    service = new WorktreeLocalFilesService({ storagePath: join(directory, 'config', 'approvals.json'),
      beforePublish: () => { writeFileSync(join(project.root, 'local.json'), 'changed-by-competitor') },
    })
    await expect(service.copy(project, target, await service.preflight(project))).rejects.toMatchObject({ code: 'file_changed' })
    expect((await service.inspectTarget(target, ['local.json']))[0]!.exists).toBe(false)
  })

  test('目标父级 symlink、特殊文件和嵌套 Git 仓库不能被当作普通本地文件', async () => {
    await mkdir(join(project.root, 'config'))
    await writeFile(join(project.root, 'config', 'local.json'), 'source')
    await approve(['config/local.json'])
    const plan = await service.preflight(project)
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await symlink(outside, join(target, 'config'))
    await expect(service.copy(project, target, plan)).rejects.toMatchObject({ code: 'unsafe_file' })
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(project.root, 'pipe')])
      expect(await service.resolveSelection(project, ['pipe'], [])).toMatchObject({ paths: [], skipped: [{ path: 'pipe', reason: '链接或特殊文件不可选择' }] })
    }
    execFileSync('git', ['init', '-q', join(project.root, 'nested')])
    await writeFile(join(project.root, 'nested', 'file.json'), '{}')
    await expect(service.resolveSelection(project, ['nested/file.json'], [])).rejects.toMatchObject({ code: 'unsafe_file' })
  })

  test('拒绝过大文件、无效 UTF-8 清单和伪造复制计划', async () => {
    await writeFile(join(project.root, '.worktreeinclude'), Buffer.from([0xff, 0xfe]))
    await expect(service.inspect(project)).rejects.toMatchObject({ code: 'invalid_manifest' })
    await writeFile(join(project.root, 'huge'), Buffer.alloc(4 * 1024 * 1024 + 1))
    await writeFile(join(project.root, '.worktreeinclude'), 'huge\n')
    await expect(service.preflight(project)).rejects.toMatchObject({ code: 'limit_exceeded' })
    await writeFile(join(project.root, '.worktreeinclude'), '')
    await expect(service.copy(project, target, { paths: [], manifestVersion: (await service.inspect(project)).manifestVersion })).rejects.toMatchObject({ code: 'invalid_plan' })
  })

  test('Git tracked 大小写别名不能绕过源检查，合法根目录别名可选文件', async () => {
    await writeFile(join(project.root, 'Local.json'), '{}')
    execFileSync('git', ['-C', project.root, 'add', '--', 'Local.json'])
    await writeFile(join(project.root, '.worktreeinclude'), 'local.json\n')
    await expect(service.inspect(project)).rejects.toMatchObject({ code: 'tracked_file' })
    await writeFile(join(project.root, 'allowed.json'), '{}')
    const alias = join(directory, 'project-alias')
    await symlink(project.root, alias)
    expect((await service.resolveSelection({ ...project, root: alias }, ['allowed.json'], [])).paths).toEqual(['allowed.json'])
    if (process.platform !== 'win32') {
      await writeFile(join(project.root, 'back\\slash'), '{}')
      await expect(service.resolveSelection(project, ['back\\slash'], [])).rejects.toMatchObject({ code: 'invalid_path' })
    }
  })

  test('Git 环境重定向不能将其他项目的索引伪装成本项目', async () => {
    await writeFile(join(project.root, 'local.json'), '{}')
    execFileSync('git', ['-C', project.root, 'add', '--', 'local.json'])
    const savedDirectory = process.env.GIT_DIR
    const savedWorktree = process.env.GIT_WORK_TREE
    process.env.GIT_DIR = join(target, '.git')
    process.env.GIT_WORK_TREE = target
    try {
      await writeFile(join(project.root, '.worktreeinclude'), 'local.json\n')
      await expect(service.inspect(project)).rejects.toMatchObject({ code: 'tracked_file' })
    } finally {
      if (savedDirectory === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDirectory
      if (savedWorktree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedWorktree
    }
  })

  test('Git 仓库子目录作为项目根时可准备本地文件，HEAD 已受控但暂存删除的文件仍拒绝', async () => {
    await mkdir(join(project.root, 'service'))
    await mkdir(join(target, 'service'))
    const nestedProject = { ...project, root: join(project.root, 'service') }
    await writeFile(join(nestedProject.root, '.env.local'), 'subproject-only')
    const saved = await service.save(nestedProject, ['.env.local'], 'missing')
    expect(saved.entries[0]?.status).toBe('ready')
    expect(await service.copy(nestedProject, join(target, 'service'), await service.preflight(nestedProject))).toMatchObject({ copied: ['.env.local'] })
    execFileSync('git', ['-C', project.root, 'add', 'service/.env.local'])
    execFileSync('git', ['-C', project.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'tracked'])
    execFileSync('git', ['-C', project.root, 'rm', '--cached', 'service/.env.local'])
    await expect(service.preflight(nestedProject)).rejects.toMatchObject({ code: 'tracked_file' })
  })

  test('空或缺失清单可预检为零文件，缺失文件不能确认', async () => {
    expect((await service.preflight(project)).paths).toEqual([])
    const empty = await service.inspect(project)
    await expect(service.save(project, ['missing.json'], empty.manifestVersion)).rejects.toMatchObject({ code: 'missing_file' })
    await writeFile(join(project.root, '.worktreeinclude'), 'missing.json\n')
    expect((await service.inspect(project)).entries).toEqual([{ path: 'missing.json', status: 'missing' }])
    await expect(service.confirm(project, (await service.inspect(project)).manifestVersion)).rejects.toMatchObject({ code: 'missing_file' })
  })
})
