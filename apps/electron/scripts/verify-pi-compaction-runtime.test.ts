import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createPackageWithOptions } from '@electron/asar'
import {
  PI_COMPACTION_FORBIDDEN_MARKERS,
  PI_COMPACTION_REQUIRED_MARKERS,
  PI_COMPACTION_RUNTIME_FILES,
  PI_TERMINATION_REQUIRED_MARKERS,
  PI_TERMINATION_RUNTIME_FILES,
  verifyPiCompactionRuntime,
} from './verify-pi-compaction-runtime'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runtimeText(relativePath: string): string {
  if (relativePath.endsWith('agent-session.js')) {
    return [
      'estimatePreparedRequestTokens',
      'compactionAttempts < 2',
      'projectProviderContextMessages',
      '_lastAgentEndedByTool',
      'endedByTerminatingTool',
    ].join('\n')
  }
  if (relativePath.endsWith('compaction.js')) {
    return [
      'Use one physical summarization request',
      'COMPACTION_SUMMARY_HARD_MAX_TOKENS = 6144',
      'PROVIDER_RETAINED_HISTORY_MAX_TOKENS = 20000',
      'CHECKPOINT_TARGET_MIN_TOKENS = 2500',
      'projectProviderContextMessages',
    ].join('\n')
  }
  if (relativePath.endsWith('utils.js')) {
    return 'complete list stored in compaction details'
  }
  return 'projectProviderContextMessages'
}

function writeRuntime(nodeModulesDir: string, overrides: Partial<Record<string, string>> = {}): void {
  for (const relativePath of PI_COMPACTION_RUNTIME_FILES) {
    const filePath = join(nodeModulesDir, '@earendil-works', 'pi-coding-agent', ...relativePath.split('/'))
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, overrides[relativePath] ?? runtimeText(relativePath))
  }
}

function writePatch(repoRoot: string): void {
  const patchPath = join(repoRoot, 'patches', '@earendil-works%2Fpi-coding-agent@0.84.4.patch')
  const corePatchPath = join(repoRoot, 'patches', '@earendil-works%2Fpi-agent-core@0.84.4.patch')
  mkdirSync(join(patchPath, '..'), { recursive: true })
  writeFileSync(patchPath, PI_COMPACTION_REQUIRED_MARKERS.map(marker => `+${marker}`).join('\n'))
  writeFileSync(corePatchPath, PI_TERMINATION_REQUIRED_MARKERS.map(marker => `+${marker}`).join('\n'))
}

function writeTerminationRuntime(nodeModulesDir: string): void {
  for (const relativePath of PI_TERMINATION_RUNTIME_FILES) {
    const filePath = join(nodeModulesDir, '@earendil-works', 'pi-agent-core', ...relativePath.split('/'))
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, relativePath.endsWith('agent-loop.js') ? 'terminatedByTool: true' : 'terminatedByTool?: true')
  }
}

function createFixture(): { root: string; repoRoot: string; appDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-verify-'))
  tempRoots.push(root)
  const repoRoot = join(root, 'repo')
  const appDir = join(repoRoot, 'apps', 'electron')
  writePatch(repoRoot)
  writeRuntime(join(repoRoot, 'node_modules'))
  writeTerminationRuntime(join(repoRoot, 'node_modules'))
  writeRuntime(join(appDir, 'node_modules'))
  writeTerminationRuntime(join(appDir, 'node_modules'))
  return { root, repoRoot, appDir }
}

async function createAsar(appDir: string, resourcesDir: string): Promise<void> {
  mkdirSync(resourcesDir, { recursive: true })
  const stream = await createPackageWithOptions(appDir, join(resourcesDir, 'app.asar'), {})
  if (!('writableFinished' in stream) || !stream.writableFinished) {
    await once(stream, 'close')
  }
}

describe('verifyPiCompactionRuntime', () => {
  test('accepts matching root, synced and ASAR runtime with only the new single-request markers', async () => {
    const { root, repoRoot, appDir } = createFixture()
    const packagedAppDir = join(root, 'packaged-app')
    const resourcesDir = join(root, 'resources')
    writeRuntime(join(packagedAppDir, 'node_modules'))
    writeTerminationRuntime(join(packagedAppDir, 'node_modules'))
    await createAsar(packagedAppDir, resourcesDir)

    expect(verifyPiCompactionRuntime({ repoRoot, appDir, packagedResourcesDir: resourcesDir })).toEqual({
      sourceFiles: PI_COMPACTION_RUNTIME_FILES.length + PI_TERMINATION_RUNTIME_FILES.length,
      syncedFiles: PI_COMPACTION_RUNTIME_FILES.length + PI_TERMINATION_RUNTIME_FILES.length,
      packagedFiles: PI_COMPACTION_RUNTIME_FILES.length + PI_TERMINATION_RUNTIME_FILES.length,
      packagedLayout: 'asar',
    })
  })

  test('supports unpacked Electron layouts', () => {
    const { root, repoRoot, appDir } = createFixture()
    const resourcesDir = join(root, 'resources')
    writeRuntime(join(resourcesDir, 'app', 'node_modules'))
    writeTerminationRuntime(join(resourcesDir, 'app', 'node_modules'))

    expect(verifyPiCompactionRuntime({ repoRoot, appDir, packagedResourcesDir: resourcesDir }).packagedLayout)
      .toBe('unpacked')
  })

  test('rejects stale synced dependencies and old split-turn packaged artifacts', async () => {
    const stale = createFixture()
    writeRuntime(join(stale.appDir, 'node_modules'), {
      'dist/core/agent-session.js': 'estimatePreparedRequestTokens but stale',
    })
    expect(() => verifyPiCompactionRuntime({ repoRoot: stale.repoRoot, appDir: stale.appDir }))
      .toThrow('缺少压缩补丁标识')

    const staleTermination = createFixture()
    const staleCorePath = join(
      staleTermination.appDir,
      'node_modules',
      '@earendil-works',
      'pi-agent-core',
      'dist',
      'agent-loop.js',
    )
    writeFileSync(staleCorePath, 'old terminating loop')
    expect(() => verifyPiCompactionRuntime({ repoRoot: staleTermination.repoRoot, appDir: staleTermination.appDir }))
      .toThrow('缺少压缩补丁标识')

    const packaged = createFixture()
    const packagedAppDir = join(packaged.root, 'packaged-app')
    const resourcesDir = join(packaged.root, 'resources')
    writeRuntime(join(packagedAppDir, 'node_modules'), {
      'dist/core/compaction/compaction.js': `${runtimeText('dist/core/compaction/compaction.js')}\n${PI_COMPACTION_FORBIDDEN_MARKERS[0]}`,
    })
    writeTerminationRuntime(join(packagedAppDir, 'node_modules'))
    await createAsar(packagedAppDir, resourcesDir)
    expect(() => verifyPiCompactionRuntime({
      repoRoot: packaged.repoRoot,
      appDir: packaged.appDir,
      packagedResourcesDir: resourcesDir,
    })).toThrow('旧 split-turn 双请求标识')
  })
})
