import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildWorktreeDependencyPreparationPrompt,
  hashDependencyInstallEnvironment,
  inspectBunDependencySnapshotProfile,
  isExactFrozenBunInstallCommand,
  resolveAgentWorktreeDependencySnapshotRuntime,
} from './worktree-dependency-snapshot.ts'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createBunWorkspace(options: { linker?: 'hoisted' | 'isolated'; workspaces?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'domi-dependency-profile-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'packages', 'shared'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-root',
    private: true,
    workspaces: options.workspaces ?? ['packages/*'],
  }))
  writeFileSync(join(root, 'bun.lock'), 'lock-v1\n')
  writeFileSync(join(root, 'packages', 'shared', 'package.json'), JSON.stringify({
    name: '@fixture/shared',
    version: '1.0.0',
  }))
  if (options.linker) {
    writeFileSync(join(root, 'bunfig.toml'), `[install]\nlinker = "${options.linker}"\n`)
  }
  return root
}

const WINDOWS_RUNTIME = {
  platform: 'win32' as const,
  arch: 'x64',
  bunVersion: '1.3.14',
  installEnvHash: 'fixture-install-env',
}

describe('Bun Worktree dependency snapshot profile', () => {
  test('Given an exact Bun workspace When inspected Then the profile binds lock, manifests, runtime and workspace links', async () => {
    const root = createBunWorkspace()

    const result = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error(result.reason)
    expect(result.profile).toMatchObject({
      schemaVersion: 1,
      platform: 'win32',
      arch: 'x64',
      bunVersion: '1.3.14',
      installEnvHash: 'fixture-install-env',
      linker: 'hoisted',
      workspaceLinks: [{ name: '@fixture/shared', relativePath: 'packages/shared' }],
    })
    expect(result.profile.key).toMatch(/^[a-f0-9]{64}$/)
  })

  test('Given lock, workspace manifest, OS arch or Bun version changes When inspected Then each produces a different exact key', async () => {
    const root = createBunWorkspace()
    const baseline = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })
    if (baseline.status !== 'ready') throw new Error(baseline.reason)

    writeFileSync(join(root, 'bun.lock'), 'lock-v2\n')
    const changedLock = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })
    writeFileSync(join(root, 'bun.lock'), 'lock-v1\n')
    writeFileSync(join(root, 'packages', 'shared', 'package.json'), JSON.stringify({
      name: '@fixture/shared', version: '1.0.1',
    }))
    const changedManifest = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })
    const changedRuntime = await inspectBunDependencySnapshotProfile({
      projectRoot: root,
      platform: 'win32',
      arch: 'arm64',
      bunVersion: '1.3.15',
      installEnvHash: 'fixture-install-env',
    })

    for (const candidate of [changedLock, changedManifest, changedRuntime]) {
      expect(candidate.status).toBe('ready')
      if (candidate.status === 'ready') expect(candidate.profile.key).not.toBe(baseline.profile.key)
    }
  })

  test('Given referenced patch or Bun config content changes When inspected Then the exact profile key changes', async () => {
    const root = createBunWorkspace({ linker: 'hoisted' })
    mkdirSync(join(root, 'patches'), { recursive: true })
    writeFileSync(join(root, 'patches', 'dependency.patch'), 'patch-v1\n')
    const manifest = JSON.parse(await Bun.file(join(root, 'package.json')).text())
    manifest.patchedDependencies = { 'dependency@1.0.0': 'patches/dependency.patch' }
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    const baseline = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })
    if (baseline.status !== 'ready') throw new Error(baseline.reason)

    writeFileSync(join(root, 'patches', 'dependency.patch'), 'patch-v2\n')
    const patchChanged = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })
    writeFileSync(join(root, 'patches', 'dependency.patch'), 'patch-v1\n')
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nlinker = "hoisted"\ncache = false\n')
    const configChanged = await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME })

    expect(patchChanged.status).toBe('ready')
    expect(configChanged.status).toBe('ready')
    if (patchChanged.status === 'ready') expect(patchChanged.profile.key).not.toBe(baseline.profile.key)
    if (configChanged.status === 'ready') expect(configChanged.profile.key).not.toBe(baseline.profile.key)
  })

  test('Given workspace metadata exceeds the bounded scan budget When inspected Then the main process skips snapshot work', async () => {
    const root = createBunWorkspace({
      workspaces: Array.from({ length: 33 }, (_, index) => `packages/workspace-${index}`),
    })

    expect(await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME }))
      .toEqual({ status: 'skipped', reason: 'resource_limit' })
  })

  test('Given isolated linker or an unsafe workspace pattern When inspected Then snapshot reuse is conservatively skipped', async () => {
    const isolated = createBunWorkspace({ linker: 'isolated' })
    const unsafe = createBunWorkspace({ workspaces: ['../outside/*'] })

    expect(await inspectBunDependencySnapshotProfile({ projectRoot: isolated, ...WINDOWS_RUNTIME }))
      .toEqual({ status: 'skipped', reason: 'unsupported_linker' })
    expect(await inspectBunDependencySnapshotProfile({ projectRoot: unsafe, ...WINDOWS_RUNTIME }))
      .toEqual({ status: 'skipped', reason: 'unsafe_workspace_pattern' })
  })

  test('Given a non-Windows runtime or missing Bun lock When inspected Then no snapshot is claimed', async () => {
    const root = createBunWorkspace()
    rmSync(join(root, 'bun.lock'))

    expect(await inspectBunDependencySnapshotProfile({
      projectRoot: root,
      platform: 'linux',
      arch: 'x64',
      bunVersion: '1.3.14',
      installEnvHash: 'fixture-install-env',
    })).toEqual({ status: 'skipped', reason: 'unsupported_platform' })
    expect(await inspectBunDependencySnapshotProfile({ projectRoot: root, ...WINDOWS_RUNTIME }))
      .toEqual({ status: 'skipped', reason: 'bun_lock_missing' })
  })
})

describe('dependency install environment profile', () => {
  test('Given install-relevant and irrelevant environment values When hashing Then only relevant values invalidate the snapshot without exposing them', () => {
    const baseline = hashDependencyInstallEnvironment({
      PATH: 'C:\\tools',
      NODE_ENV: 'development',
      BUN_INSTALL_CACHE_DIR: 'C:\\cache-a',
      API_SECRET: 'do-not-profile',
    })
    const relevantChanged = hashDependencyInstallEnvironment({
      PATH: 'C:\\tools',
      NODE_ENV: 'development',
      BUN_INSTALL_CACHE_DIR: 'C:\\cache-b',
      API_SECRET: 'do-not-profile',
    })
    const irrelevantChanged = hashDependencyInstallEnvironment({
      PATH: 'C:\\tools',
      NODE_ENV: 'development',
      BUN_INSTALL_CACHE_DIR: 'C:\\cache-a',
      API_SECRET: 'changed-secret',
    })

    expect(baseline).toMatch(/^[a-f0-9]{64}$/)
    expect(relevantChanged).not.toBe(baseline)
    expect(irrelevantChanged).toBe(baseline)
    expect(baseline).not.toContain('do-not-profile')
  })
})

describe('Agent Worktree dependency snapshot eligibility', () => {
  test('Given Session Target, Workflow and runtime combinations When resolving snapshot runtime Then only native Windows owner Isolated Direct sessions are eligible', () => {
    const eligible = resolveAgentWorktreeDependencySnapshotRuntime({
      platform: 'win32',
      arch: 'x64',
      targetKind: 'isolated',
      ownership: 'owner',
      workflow: 'direct',
      followupOnly: false,
      shellKind: 'git-bash',
      bun: { available: true, version: '1.3.14' },
      environment: { PATH: 'C:\\tools', BUN_INSTALL_CACHE_DIR: 'C:\\cache' },
    })
    expect(eligible).toEqual({
      platform: 'win32',
      arch: 'x64',
      bunVersion: '1.3.14',
      installEnvHash: hashDependencyInstallEnvironment({ PATH: 'C:\\tools', BUN_INSTALL_CACHE_DIR: 'C:\\cache' }),
      shellKind: 'git-bash',
    })

    for (const input of [
      { platform: 'linux', targetKind: 'isolated', ownership: 'owner', workflow: 'direct', followupOnly: false, shellKind: undefined },
      { platform: 'win32', targetKind: 'local', ownership: 'owner', workflow: 'direct', followupOnly: false, shellKind: 'git-bash' },
      { platform: 'win32', targetKind: 'isolated', ownership: 'inherited', workflow: 'direct', followupOnly: false, shellKind: 'git-bash' },
      { platform: 'win32', targetKind: 'isolated', ownership: 'owner', workflow: 'direct', followupOnly: true, shellKind: 'git-bash' },
      { platform: 'win32', targetKind: 'isolated', ownership: 'owner', workflow: 'direct', followupOnly: false, shellKind: 'wsl' },
      { platform: 'win32', targetKind: 'isolated', ownership: 'owner', workflow: 'plan-first', followupOnly: false, shellKind: 'git-bash' },
      { platform: 'win32', targetKind: 'isolated', ownership: 'owner', workflow: 'read-only', followupOnly: false, shellKind: 'git-bash' },
    ] as const) {
      expect(resolveAgentWorktreeDependencySnapshotRuntime({
        arch: 'x64',
        bun: { available: true, version: '1.3.14' },
        environment: {},
        ...input,
      })).toBeUndefined()
    }
    expect(resolveAgentWorktreeDependencySnapshotRuntime({
      platform: 'win32',
      arch: 'x64',
      targetKind: 'isolated',
      ownership: 'owner',
      workflow: 'direct',
      followupOnly: false,
      shellKind: 'git-bash',
      bun: { available: false, version: null },
      environment: {},
    })).toBeUndefined()
    expect(resolveAgentWorktreeDependencySnapshotRuntime({
      platform: 'win32',
      arch: 'x64',
      targetKind: 'isolated',
      ownership: 'owner',
      workflow: 'direct',
      followupOnly: false,
      shellKind: 'git-bash',
      bun: { available: true, version: '1.3.14' },
      environment: { BUN_INSTALL_GLOBAL_STORE: '1' },
    })).toBeUndefined()
  })
})

describe('successful frozen Bun install capture boundary', () => {
  test('Given shell commands When classifying a snapshot publication source Then only the exact frozen install is accepted', () => {
    expect(isExactFrozenBunInstallCommand('bun install --frozen-lockfile')).toBe(true)
    expect(isExactFrozenBunInstallCommand('bun.exe install --frozen-lockfile')).toBe(true)

    for (const command of [
      'bun install',
      'bun install --frozen-lockfile --production',
      'bun add react --frozen-lockfile',
      'cd app && bun install --frozen-lockfile',
      'bun install --frozen-lockfile && echo done',
      'npm install --frozen-lockfile',
    ]) {
      expect(isExactFrozenBunInstallCommand(command), command).toBe(false)
    }
  })
})

describe('dependency preparation prompt', () => {
  test('Given ready, miss and unavailable preparation states When building prompt Then it never claims validation passed', () => {
    expect(buildWorktreeDependencyPreparationPrompt({ status: 'ready', durationMs: 17_120 }))
      .toContain('依赖快照已物化')
    expect(buildWorktreeDependencyPreparationPrompt({ status: 'miss', durationMs: 4 }))
      .toContain('仍可能需要')
    expect(buildWorktreeDependencyPreparationPrompt({ status: 'unavailable', durationMs: 5, reason: 'corrupt' }))
      .toContain('未能使用')

    for (const status of ['ready', 'miss', 'unavailable'] as const) {
      expect(buildWorktreeDependencyPreparationPrompt({ status, durationMs: 1 })).not.toContain('测试通过')
    }
  })
})
