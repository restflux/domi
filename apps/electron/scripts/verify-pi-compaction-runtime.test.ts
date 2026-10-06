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
  PI_RESPONSE_REQUIRED_MARKERS,
  PI_RESPONSE_RUNTIME_FILES,
  PI_RETRY_REQUIRED_MARKERS,
  PI_RETRY_RUNTIME_FILES,
  PI_TERMINATION_REQUIRED_MARKERS,
  PI_TERMINATION_RUNTIME_FILES,
  verifyPiCompactionRuntime,
} from './verify-pi-compaction-runtime'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeFiles(
  nodeModulesDir: string,
  packageName: string,
  relativePaths: readonly string[],
  content: string,
): void {
  for (const relativePath of relativePaths) {
    const filePath = join(nodeModulesDir, packageName, ...relativePath.split('/'))
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, content)
  }
}

function writeCodingAgentRuntime(nodeModulesDir: string, overrides: Partial<Record<string, string>> = {}): void {
  const common = [...PI_COMPACTION_REQUIRED_MARKERS].join('\n')
  for (const relativePath of PI_COMPACTION_RUNTIME_FILES) {
    writeFiles(
      nodeModulesDir,
      '@earendil-works/pi-coding-agent',
      [relativePath],
      overrides[relativePath] ?? common,
    )
  }
}

function writeAgentCoreRuntime(nodeModulesDir: string): void {
  writeFiles(
    nodeModulesDir,
    '@earendil-works/pi-agent-core',
    PI_TERMINATION_RUNTIME_FILES,
    PI_TERMINATION_REQUIRED_MARKERS.join('\n'),
  )
}

function writePiAiRuntime(nodeModulesDir: string): void {
  writeFiles(
    nodeModulesDir,
    '@earendil-works/pi-ai',
    PI_RETRY_RUNTIME_FILES,
    PI_RETRY_REQUIRED_MARKERS.join('\n'),
  )
  writeFiles(
    nodeModulesDir,
    '@earendil-works/pi-ai',
    PI_RESPONSE_RUNTIME_FILES,
    PI_RESPONSE_REQUIRED_MARKERS.join('\n'),
  )
}

function writePatch(repoRoot: string): void {
  const patchPath = join(repoRoot, 'patches', '@earendil-works%2Fpi-ai@1.0.0.patch')
  mkdirSync(join(patchPath, '..'), { recursive: true })
  writeFileSync(patchPath, [...PI_RETRY_REQUIRED_MARKERS, ...PI_RESPONSE_REQUIRED_MARKERS].map(marker => `+${marker}`).join('\n'))
}

function createFixture(): { root: string; repoRoot: string; appDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-verify-'))
  tempRoots.push(root)
  const repoRoot = join(root, 'repo')
  const appDir = join(repoRoot, 'apps', 'electron')
  writePatch(repoRoot)
  for (const nodeModulesDir of [join(repoRoot, 'node_modules'), join(appDir, 'node_modules')]) {
    writeCodingAgentRuntime(nodeModulesDir)
    writeAgentCoreRuntime(nodeModulesDir)
    writePiAiRuntime(nodeModulesDir)
  }
  return { root, repoRoot, appDir }
}

async function createAsar(appDir: string, resourcesDir: string): Promise<void> {
  mkdirSync(resourcesDir, { recursive: true })
  const stream = await createPackageWithOptions(appDir, join(resourcesDir, 'app.asar'), {})
  if (!('writableFinished' in stream) || !stream.writableFinished) await once(stream, 'close')
}

describe('verifyPiCompactionRuntime', () => {
  test('accepts matching root, synced and ASAR Pi 1.0 runtime contracts', async () => {
    const { root, repoRoot, appDir } = createFixture()
    const resourcesDir = join(root, 'resources')
    await createAsar(appDir, resourcesDir)

    const result = verifyPiCompactionRuntime({ repoRoot, appDir, packagedResourcesDir: resourcesDir })
    expect(result.sourceFiles).toBe(
      PI_COMPACTION_RUNTIME_FILES.length + PI_TERMINATION_RUNTIME_FILES.length + PI_RETRY_RUNTIME_FILES.length + PI_RESPONSE_RUNTIME_FILES.length,
    )
    expect(result.syncedFiles).toBe(result.sourceFiles)
    expect(result.packagedFiles).toBe(result.sourceFiles)
    expect(result.packagedLayout).toBe('asar')
  })

  test('supports unpacked Electron layouts', () => {
    const { root, repoRoot, appDir } = createFixture()
    const resourcesDir = join(root, 'resources')
    const packagedNodeModules = join(resourcesDir, 'app', 'node_modules')
    writeCodingAgentRuntime(packagedNodeModules)
    writeAgentCoreRuntime(packagedNodeModules)
    writePiAiRuntime(packagedNodeModules)

    expect(verifyPiCompactionRuntime({ repoRoot, appDir, packagedResourcesDir: resourcesDir }).packagedLayout)
      .toBe('unpacked')
  })

  test('rejects a runtime that lost a native lifecycle marker', () => {
    const { repoRoot, appDir } = createFixture()
    for (const nodeModulesDir of [join(repoRoot, 'node_modules'), join(appDir, 'node_modules')]) {
      for (const relativePath of PI_COMPACTION_RUNTIME_FILES) {
        const stalePath = join(nodeModulesDir, '@earendil-works', 'pi-coding-agent', ...relativePath.split('/'))
        writeFileSync(stalePath, 'old runtime without native projection')
      }
    }

    expect(() => verifyPiCompactionRuntime({ repoRoot, appDir })).toThrow('缺少运行时契约标识')
  })

  test('rejects old split-turn compatibility markers in the synced runtime', () => {
    const { repoRoot, appDir } = createFixture()
    const stalePath = join(appDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'compaction', 'compaction.js')
    writeFileSync(stalePath, `${PI_COMPACTION_REQUIRED_MARKERS.join('\n')}\n${PI_COMPACTION_FORBIDDEN_MARKERS[0]}`)

    expect(() => verifyPiCompactionRuntime({ repoRoot, appDir })).toThrow('旧 provider-context projection 标识')
  })
})
