import { afterEach, describe, expect, test } from 'bun:test'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WorktreeDependencySnapshotService,
  parseRobocopyDirectoryInspection,
  type DependencySnapshotCopyDirectory,
  type DependencySnapshotInspectDirectory,
} from './worktree-dependency-snapshot-node.ts'

const tempRoots: string[] = []
const runtime = {
  platform: 'win32' as const,
  arch: 'x64',
  bunVersion: '1.3.14',
  installEnvHash: 'fixture-install-env',
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  root: string
  projectRoot: string
  localRoot: string
  dependencyFile: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'domi-dependency-snapshot-'))
  tempRoots.push(root)
  const projectRoot = join(root, 'managed-worktrees', 'checkout')
  const localRoot = join(root, 'local', 'project')
  await mkdir(join(projectRoot, 'packages', 'shared'), { recursive: true })
  await mkdir(localRoot, { recursive: true })
  await writeFile(join(projectRoot, '.git'), 'gitdir: fixture\n')
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
    name: 'fixture-root',
    private: true,
    workspaces: ['packages/*'],
  }))
  await writeFile(join(projectRoot, 'bun.lock'), 'lock-v1\n')
  await writeFile(join(projectRoot, 'packages', 'shared', 'package.json'), JSON.stringify({
    name: '@fixture/shared',
    version: '1.0.0',
  }))
  const dependencyFile = join(projectRoot, 'node_modules', 'dependency', 'index.js')
  await mkdir(join(projectRoot, 'node_modules', 'dependency'), { recursive: true })
  await mkdir(join(projectRoot, 'node_modules', '@fixture'), { recursive: true })
  await writeFile(dependencyFile, 'module.exports = 42\n')
  await symlink(
    join(projectRoot, 'packages', 'shared'),
    join(projectRoot, 'node_modules', '@fixture', 'shared'),
    'junction',
  )
  return { root, projectRoot, localRoot, dependencyFile }
}

const portableInspect: DependencySnapshotInspectDirectory = async ({ source, signal }) => {
  const queue = [source]
  let fileCount = 0
  let totalBytes = 0
  let directoryCount = 0
  let skippedDirectoryCount = 0
  while (queue.length > 0) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const directory = await opendir(queue.pop()!)
    for await (const entry of directory) {
      const path = join(directory.path, entry.name)
      if (entry.isSymbolicLink()) {
        skippedDirectoryCount += 1
      } else if (entry.isDirectory()) {
        directoryCount += 1
        queue.push(path)
      } else if (entry.isFile()) {
        fileCount += 1
        totalBytes += (await stat(path)).size
      }
    }
  }
  return { tree: { fileCount, totalBytes, directoryCount }, skippedDirectoryCount }
}

const portableCopy: DependencySnapshotCopyDirectory = async ({ source, destination, excludedDirectories, signal }) => {
  const exclusions = new Set(excludedDirectories.map((path) => resolve(path).toLowerCase()))
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const candidate = resolve(path).toLowerCase()
      return ![...exclusions].some((excluded) => candidate === excluded || candidate.startsWith(`${excluded}\\`))
    },
  })
  const inspected = await portableInspect({ source: destination, signal })
  return { ...inspected, skippedDirectoryCount: excludedDirectories.length }
}

function service(overrides: Partial<ConstructorParameters<typeof WorktreeDependencySnapshotService>[0]> = {}) {
  let nextId = 0
  return new WorktreeDependencySnapshotService({
    copyDirectory: portableCopy,
    inspectDirectory: portableInspect,
    createId: () => `id-${++nextId}`,
    now: () => 1_000_000,
    log: () => {},
    ...overrides,
  })
}

async function repositorySnapshotRoot(fixture: Fixture): Promise<string> {
  const versionRoot = join(fixture.root, 'managed-worktrees', '.domi-dependency-snapshots', 'v1')
  const [repository] = await readdir(versionRoot)
  if (!repository) throw new Error('snapshot repository missing')
  return join(versionRoot, repository)
}

async function snapshotDirectories(fixture: Fixture): Promise<string[]> {
  const repositoryRoot = await repositorySnapshotRoot(fixture)
  return (await readdir(repositoryRoot))
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .sort()
}

describe('Robocopy dependency summary', () => {
  test('Given localized Robocopy labels When parsing Then numeric directory, file and byte rows remain deterministic', () => {
    const inspected = parseRobocopyDirectoryInspection(`
      目录:      6048      6042         6         0         0         0
      文件:     59998     59998         0         0         0         0
      字节: 939125553 939125553         0         0         0         0
      时间:   0:00:17   0:00:17                       0:00:00   0:00:00
    `)

    expect(inspected).toEqual({
      tree: { directoryCount: 6042, fileCount: 59998, totalBytes: 939125553 },
      skippedDirectoryCount: 6,
    })
  })
})

describe('WorktreeDependencySnapshotService', () => {
  test('Given a successful frozen install environment When captured and later prepared Then a private dependency tree is atomically materialized with checkout-local workspace junctions', async () => {
    const fixture = await createFixture()
    const snapshots = service()

    const captured = await snapshots.capture({
      projectRoot: fixture.projectRoot,
      localRoot: fixture.localRoot,
      runtime,
    })
    expect(captured.status).toBe('published')

    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })
    const prepared = await snapshots.prepare({
      projectRoot: fixture.projectRoot,
      localRoot: fixture.localRoot,
      runtime,
    })

    expect(prepared.status).toBe('ready')
    expect(await readFile(fixture.dependencyFile, 'utf8')).toBe('module.exports = 42\n')
    const workspaceLink = join(fixture.projectRoot, 'node_modules', '@fixture', 'shared')
    expect((await lstat(workspaceLink)).isSymbolicLink()).toBe(true)
    expect(await realpath(workspaceLink)).toBe(await realpath(join(fixture.projectRoot, 'packages', 'shared')))

    const cacheRoot = join(fixture.root, 'managed-worktrees', '.domi-dependency-snapshots')
    const cacheDependency = join(cacheRoot, 'v1')
    expect(relative(fixture.projectRoot, await realpath(workspaceLink)).startsWith('..')).toBe(false)
    expect(await realpath(cacheDependency)).not.toBe(await realpath(join(fixture.projectRoot, 'node_modules')))
  })

  test('Given node_modules is a junction When preparing Then the service refuses to treat shared mutable dependencies as a safe existing environment', async () => {
    const fixture = await createFixture()
    const external = join(fixture.root, 'external-node-modules')
    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })
    await mkdir(external)
    await writeFile(join(external, 'external.txt'), 'shared mutable\n')
    await symlink(external, join(fixture.projectRoot, 'node_modules'), 'junction')

    const prepared = await service().prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(prepared).toMatchObject({ status: 'unavailable', reason: 'unsafe_existing_node_modules' })
    expect(await readFile(join(external, 'external.txt'), 'utf8')).toBe('shared mutable\n')
  })

  test('Given node_modules already exists When a snapshot is available Then prepare never overwrites the checkout environment', async () => {
    const fixture = await createFixture()
    const snapshots = service()
    expect((await snapshots.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('published')
    await writeFile(fixture.dependencyFile, 'user-owned environment\n')

    const prepared = await snapshots.prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(prepared.status).toBe('existing')
    expect(await readFile(fixture.dependencyFile, 'utf8')).toBe('user-owned environment\n')
  })

  test('Given a snapshot receipt is corrupt When a fresh Worktree prepares Then the cache is quarantined and the result falls back to miss', async () => {
    const fixture = await createFixture()
    const snapshots = service()
    expect((await snapshots.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('published')
    const [key] = await snapshotDirectories(fixture)
    const repositoryRoot = await repositorySnapshotRoot(fixture)
    await writeFile(join(repositoryRoot, key!, 'receipt.json'), '{broken')
    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })

    const prepared = await snapshots.prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(prepared).toMatchObject({ status: 'miss', reason: 'corrupt_snapshot' })
    expect(await snapshotDirectories(fixture)).toEqual([])
  })

  test('Given the lockfile changes When preparing Then the old exact snapshot is not reused or mislabeled corrupt', async () => {
    const fixture = await createFixture()
    const snapshots = service()
    expect((await snapshots.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('published')
    const [oldKey] = await snapshotDirectories(fixture)
    if (!oldKey) throw new Error('old snapshot missing')
    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })
    await writeFile(join(fixture.projectRoot, 'bun.lock'), 'lock-v2\n')

    const prepared = await snapshots.prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(prepared.status).toBe('miss')
    expect(await snapshotDirectories(fixture)).toEqual([oldKey])
  })

  test('Given snapshot publication is cancelled during copy When capture settles Then staging is removed and no cache is published', async () => {
    const fixture = await createFixture()
    const controller = new AbortController()
    let signalCopyStarted = (): void => {}
    const copyStarted = new Promise<void>((resolveStarted) => { signalCopyStarted = resolveStarted })
    const snapshots = service({
      copyDirectory: async ({ signal }) => {
        signalCopyStarted()
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    })

    const capture = snapshots.capture({
      projectRoot: fixture.projectRoot,
      localRoot: fixture.localRoot,
      runtime,
      signal: controller.signal,
    })
    await copyStarted
    controller.abort()

    expect((await capture).status).toBe('cancelled')
    expect(await readdir(await repositorySnapshotRoot(fixture))).toEqual([])
  })

  test('Given concurrent captures for the same checkout When both run Then one shared publication operation owns the cache', async () => {
    const fixture = await createFixture()
    let copyCount = 0
    const snapshots = service({
      copyDirectory: async (input) => {
        copyCount += 1
        return portableCopy(input)
      },
    })
    const input = { projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime }

    const first = snapshots.capture(input)
    const second = snapshots.capture(input)
    const [left, right] = await Promise.all([first, second])

    expect(first).toBe(second)
    expect(left).toEqual(right)
    expect(left.status).toBe('published')
    expect(copyCount).toBe(1)
    expect((await snapshotDirectories(fixture))).toHaveLength(1)
  })

  test('Given a materialized copy does not match the receipt When preparing Then staging is discarded and no partial node_modules is exposed', async () => {
    const fixture = await createFixture()
    const publisher = service()
    expect((await publisher.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('published')
    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })
    const mismatching = service({
      copyDirectory: async (input) => {
        const copied = await portableCopy(input)
        return { ...copied, tree: { ...copied.tree, fileCount: copied.tree.fileCount - 1 } }
      },
    })

    const prepared = await mismatching.prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(prepared).toMatchObject({ status: 'unavailable', reason: 'materialized_tree_mismatch' })
    await expect(lstat(join(fixture.projectRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(await repositorySnapshotRoot(fixture))).some((name) => name.startsWith('.materializing-')))
      .toBe(false)
  })

  test('Given another process creates node_modules before atomic rename When preparing Then the new environment wins and the snapshot never overwrites it', async () => {
    const fixture = await createFixture()
    const publisher = service()
    expect((await publisher.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('published')
    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })
    const racing = service({
      copyDirectory: async (input) => {
        const copied = await portableCopy(input)
        await mkdir(join(fixture.projectRoot, 'node_modules'), { recursive: true })
        await writeFile(join(fixture.projectRoot, 'node_modules', 'winner.txt'), 'external winner\n')
        return copied
      },
    })

    const prepared = await racing.prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(prepared.status).toBe('existing')
    expect(await readFile(join(fixture.projectRoot, 'node_modules', 'winner.txt'), 'utf8')).toBe('external winner\n')
  })

  test('Given a crash left an old Domi staging directory When the service is used again Then only stale owned staging is cleaned', async () => {
    const fixture = await createFixture()
    const snapshots = service({ now: () => 3 * 24 * 60 * 60 * 1000 })
    expect((await snapshots.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('published')
    const repositoryRoot = await repositorySnapshotRoot(fixture)
    const stale = join(repositoryRoot, '.publishing-crashed')
    const unknown = join(repositoryRoot, 'user-unknown-directory')
    await mkdir(stale)
    await mkdir(unknown)
    await utimes(stale, new Date(0), new Date(0))
    await utimes(unknown, new Date(0), new Date(0))
    await rm(join(fixture.projectRoot, 'node_modules'), { recursive: true, force: true })
    await writeFile(join(fixture.projectRoot, 'bun.lock'), 'lock-v2\n')

    expect((await snapshots.prepare({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })).status)
      .toBe('miss')
    expect(await readdir(repositoryRoot)).not.toContain('.publishing-crashed')
    expect(await readdir(repositoryRoot)).toContain('user-unknown-directory')
  })

  test('Given the Domi cache container was replaced by a junction When capturing Then the service fails closed without writing through it', async () => {
    const fixture = await createFixture()
    const external = join(fixture.root, 'external-target')
    const cacheContainer = join(fixture.root, 'managed-worktrees', '.domi-dependency-snapshots')
    await mkdir(external)
    await symlink(external, cacheContainer, 'junction')

    const captured = await service().capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })

    expect(captured).toMatchObject({ status: 'unavailable', reason: 'unsafe_cache_directory' })
    expect(await readdir(external)).toEqual([])
  })

  test('Given WSL or a copy failure When preparing or capturing Then the service skips or falls back without mutating checkout dependencies', async () => {
    const fixture = await createFixture()
    const wsl = service()
    expect(await wsl.prepare({
      projectRoot: fixture.projectRoot,
      localRoot: fixture.localRoot,
      runtime: { ...runtime, shellKind: 'wsl' },
    })).toMatchObject({ status: 'skipped', reason: 'unsupported_wsl' })

    const failing = service({ copyDirectory: async () => { throw new Error('disk locked') } })
    const captured = await failing.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })
    expect(captured).toMatchObject({ status: 'unavailable', reason: 'disk locked' })
    expect(await readFile(fixture.dependencyFile, 'utf8')).toBe('module.exports = 42\n')
  })

  test('Given more exact profiles than the repository cap When publishing Then only current and newest valid snapshots remain', async () => {
    const fixture = await createFixture()
    let now = 1_000
    const snapshots = service({ now: () => now, maxSnapshotsPerRepository: 2 })
    for (const lock of ['lock-v1\n', 'lock-v2\n', 'lock-v3\n']) {
      await writeFile(join(fixture.projectRoot, 'bun.lock'), lock)
      const result = await snapshots.capture({ projectRoot: fixture.projectRoot, localRoot: fixture.localRoot, runtime })
      expect(result.status).toBe('published')
      now += 1_000
    }

    expect((await snapshotDirectories(fixture))).toHaveLength(2)
  })
})
