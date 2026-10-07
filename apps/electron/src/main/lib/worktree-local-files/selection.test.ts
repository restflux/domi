import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeLocalFilesService } from './service.ts'

let directory: string
let project: { id: string; root: string }
let service: WorktreeLocalFilesService

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'domi-local-files-tree-')))
  project = { id: 'project', root: join(directory, 'project') }
  await mkdir(project.root)
  execFileSync('git', ['init', '-q', project.root])
  execFileSync('git', ['-C', project.root, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', project.root, 'config', 'user.email', 'test@example.invalid'])
  await writeFile(join(project.root, 'README.md'), 'tracked')
  await writeFile(join(project.root, '.gitignore'), '.env*\n')
  execFileSync('git', ['-C', project.root, 'add', '.'])
  execFileSync('git', ['-C', project.root, 'commit', '-qm', 'test fixture'])
  service = new WorktreeLocalFilesService({ storagePath: join(directory, 'approval.json') })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('项目内本地配置选择', () => {
  test('选择文件夹展开为当前具体文件，跨目录去重，保存前不批准且后来新增文件不自动加入', async () => {
    await mkdir(join(project.root, 'config'))
    await writeFile(join(project.root, 'config', 'local.json'), '{}')
    await writeFile(join(project.root, '.env.local'), 'SECRET=not-returned')
    const selection = await service.resolveSelection(project, ['config', '.env.local', 'config/local.json'], ['.env.local'])
    expect(selection.paths.sort()).toEqual(['.env.local', 'config/local.json'])
    expect(selection.skipped).toEqual([])
    expect((await service.inspect(project)).entries).toEqual([])
    await service.save(project, selection.paths, 'missing')
    await writeFile(join(project.root, 'config', 'new-secret.json'), '{}')
    expect((await service.inspect(project)).entries.map(entry => entry.path).sort()).toEqual(['.env.local', 'config/local.json'])
  })
  test('目录展开跳过受控文件、缓存、链接与嵌套仓库，并返回具体原因而不扫描其内容', async () => {
    const config = join(project.root, 'config')
    await mkdir(config)
    await writeFile(join(config, 'local.json'), '{}')
    await writeFile(join(config, 'tracked.json'), '{}')
    execFileSync('git', ['-C', project.root, 'add', 'config/tracked.json'])
    for (const name of ['node_modules', '.cache', 'nested']) await mkdir(join(config, name))
    await writeFile(join(config, 'node_modules', 'dependency.env'), 'secret')
    execFileSync('git', ['init', '-q', join(config, 'nested')])
    await writeFile(join(config, 'nested', 'nested.env'), 'secret')
    const outside = join(directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'outside-secret.env'), 'secret')
    await symlink(outside, join(config, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await service.resolveSelection(project, ['config'], [])
    expect(result.paths).toEqual(['config/local.json'])
    expect(result.skipped.map(entry => entry.path).sort()).toEqual(['config/.cache', 'config/linked', 'config/nested', 'config/node_modules', 'config/tracked.json'])
    expect(result.skipped.every(entry => entry.reason.length > 0)).toBe(true)
    expect((await service.listDirectory(project, '', 'outside-secret')).entries).toEqual([])
    await expect(service.listDirectory(project, 'config/linked')).rejects.toMatchObject({ code: 'unsafe_file' })
  })

  test('搜索按项目相对路径查找未展开的子目录和隐藏文件，结果仍含不可选原因', async () => {
    await mkdir(join(project.root, 'config', 'deep'), { recursive: true })
    await writeFile(join(project.root, 'config', 'deep', '.env.local'), 'NOT_RETURNED')
    const search = await service.listDirectory(project, '', 'ENV.LOCAL')
    expect(search.entries).toEqual([{ path: 'config/deep/.env.local', name: '.env.local', kind: 'file', selectable: true }])
    expect(JSON.stringify(search)).not.toContain('NOT_RETURNED')
    expect((await service.listDirectory(project, '', 'readme')).entries[0]).toMatchObject({ selectable: false })
  })

  test('绝对路径、穿越、匹配语法及受保护目录不能通过浏览或选择请求', async () => {
    for (const path of ['../outside', '/tmp', 'config/../outside', 'config/*.env', 'node_modules', '.git', 'config\\\\secret']) {
      await expect(service.listDirectory(project, path)).rejects.toMatchObject({ code: 'invalid_path' })
      await expect(service.resolveSelection(project, [path], [])).rejects.toMatchObject({ code: 'invalid_path' })
    }
    await expect(service.listDirectory(project, '', 'a'.repeat(129))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  test('100文件上限包含现有选择，文件夹超限整次拒绝，不创建清单或静默截断', async () => {
    await mkdir(join(project.root, 'many'))
    for (let index = 0; index < 100; index++) await writeFile(join(project.root, 'many', `${index}.json`), '{}')
    expect((await service.resolveSelection(project, ['many'], [])).paths).toHaveLength(100)
    await writeFile(join(project.root, '.env.local'), 'existing')
    await expect(service.resolveSelection(project, ['many'], ['.env.local'])).rejects.toMatchObject({ code: 'limit_exceeded' })
    await writeFile(join(project.root, 'many', 'extra.json'), '{}')
    await expect(service.resolveSelection(project, ['many'], [])).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect((await service.inspect(project)).entries).toEqual([])
  })

  test('超过4MiB的文件不可选，选择总计超过32MiB时整次拒绝', async () => {
    await mkdir(join(project.root, 'large'))
    for (let index = 0; index < 9; index++) {
      const handle = await open(join(project.root, 'large', `${index}.bin`), 'w')
      try { await handle.truncate(4 * 1024 * 1024) } finally { await handle.close() }
    }
    await expect(service.resolveSelection(project, ['large'], [])).rejects.toMatchObject({ code: 'limit_exceeded' })
    const handle = await open(join(project.root, 'oversized.bin'), 'w')
    try { await handle.truncate(4 * 1024 * 1024 + 1) } finally { await handle.close() }
    expect((await service.listDirectory(project, '')).entries.find(entry => entry.path === 'oversized.bin')).toMatchObject({ selectable: false, reason: '文件超过 4 MiB 限制' })
  })

  test('浏览前目录被替换为外部链接时拒绝竞争结果', async () => {
    await mkdir(join(project.root, 'config'))
    await mkdir(join(directory, 'outside'))
    await writeFile(join(directory, 'outside', 'outside-secret.env'), 'secret')
    let changed = false
    service = new WorktreeLocalFilesService({ storagePath: join(directory, 'approval.json'), beforeReadDirectory: async path => {
      if (path !== 'config' || changed) return
      changed = true
      await rename(join(project.root, 'config'), join(project.root, 'old-config'))
      await symlink(join(directory, 'outside'), join(project.root, 'config'), process.platform === 'win32' ? 'junction' : 'dir')
    } })
    await expect(service.listDirectory(project, 'config')).rejects.toMatchObject({ code: 'file_changed' })
  })

  test('单目录容量与深度都有界，超限不返回部分条目', async () => {
    await mkdir(join(project.root, 'many'))
    for (let index = 0; index < 1001; index++) await writeFile(join(project.root, 'many', `${index}.json`), '{}')
    await expect(service.listDirectory(project, 'many')).rejects.toMatchObject({ code: 'limit_exceeded' })
    const deep = Array.from({ length: 33 }, () => 'd').join('/')
    await mkdir(join(project.root, deep), { recursive: true })
    await expect(service.listDirectory(project, deep)).rejects.toMatchObject({ code: 'limit_exceeded' })
  })

  test('浏览项目根显示隐藏文件和不可选原因，只返回元数据而不批准或创建清单', async () => {
    await writeFile(join(project.root, '.env.local'), 'SECRET=not-returned')
    await mkdir(join(project.root, 'config'))
    const view = await service.listDirectory(project, '')
    expect(view.entries).toContainEqual({ path: '.env.local', name: '.env.local', kind: 'file', selectable: true })
    expect(view.entries.find(entry => entry.path === 'README.md')).toMatchObject({ selectable: false, reason: expect.any(String) })
    expect(view.entries.find(entry => entry.path === '.git')).toMatchObject({ selectable: false })
    expect(view.entries.find(entry => entry.path === 'config')).toMatchObject({ kind: 'directory', selectable: true })
    expect(JSON.stringify(view)).not.toContain('not-returned')
    expect((await service.inspect(project)).entries).toEqual([])
  })
})
