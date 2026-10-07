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
  PI_MCP_RUNTIME_FILES,
  PI_MCP_REQUIRED_MARKERS,
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

function writePiMcpRuntime(nodeModulesDir: string): void {
  writeFiles(nodeModulesDir, '@earendil-works/pi-mcp', ['package.json'], JSON.stringify({ version: '1.0.4', type: 'module' }))
  writeFiles(nodeModulesDir, '@earendil-works/pi-mcp', PI_MCP_RUNTIME_FILES.filter(file => file !== 'package.json'), PI_MCP_REQUIRED_MARKERS.join('\n'))
}

function writePatch(repoRoot: string): void {
  const patchPath = join(repoRoot, 'patches', '@earendil-works%2Fpi-ai@1.0.4.patch')
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
    writePiMcpRuntime(nodeModulesDir)
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
      PI_COMPACTION_RUNTIME_FILES.length + PI_TERMINATION_RUNTIME_FILES.length + PI_RETRY_RUNTIME_FILES.length + PI_RESPONSE_RUNTIME_FILES.length + PI_MCP_RUNTIME_FILES.length,
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
    writePiMcpRuntime(packagedNodeModules)

    expect(verifyPiCompactionRuntime({ repoRoot, appDir, packagedResourcesDir: resourcesDir }).packagedLayout)
      .toBe('unpacked')
  })

  test('accepts builder-normalized MCP metadata but rejects changed runtime exports', async () => {
    const { root, repoRoot, appDir } = createFixture()
    const manifest = {
      name: '@earendil-works/pi-mcp', version: '1.0.4', type: 'module',
      exports: { '.': { import: './dist/index.js' } }, dependencies: { 'cross-spawn': '7.0.6' },
    }
    const rootManifest = join(repoRoot, 'node_modules/@earendil-works/pi-mcp/package.json')
    const appManifest = join(appDir, 'node_modules/@earendil-works/pi-mcp/package.json')
    writeFileSync(rootManifest, JSON.stringify({ ...manifest, scripts: { build: 'tsc' }, keywords: ['mcp'] }, null, 2))
    writeFileSync(appManifest, JSON.stringify(manifest))
    const resourcesDir = join(root, 'resources')
    await createAsar(appDir, resourcesDir)
    expect(() => verifyPiCompactionRuntime({ repoRoot, packagedResourcesDir: resourcesDir })).not.toThrow()
    writeFileSync(appManifest, JSON.stringify({ ...manifest, exports: { '.': { import: './dist/wrong.js' } } }))
    await createAsar(appDir, resourcesDir)
    expect(() => verifyPiCompactionRuntime({ repoRoot, packagedResourcesDir: resourcesDir })).toThrow('package.json (exports)')
  })

  test('rejects changed conditional-export priority even when values are identical', async () => {
    const { root, repoRoot, appDir } = createFixture()
    const base = { version: '1.0.4', type: 'module' }
    writeFileSync(join(repoRoot, 'node_modules/@earendil-works/pi-mcp/package.json'), JSON.stringify({
      ...base, exports: { '.': { import: './dist/index.js', default: './dist/fallback.js' } },
    }))
    writeFileSync(join(appDir, 'node_modules/@earendil-works/pi-mcp/package.json'), JSON.stringify({
      ...base, exports: { '.': { default: './dist/fallback.js', import: './dist/index.js' } },
    }))
    const resourcesDir = join(root, 'resources')
    await createAsar(appDir, resourcesDir)
    expect(() => verifyPiCompactionRuntime({ repoRoot, packagedResourcesDir: resourcesDir })).toThrow('package.json (exports)')
  })

  test('rejects a synced native MCP package with a stale version', () => {
    const { repoRoot, appDir } = createFixture()
    writeFiles(join(repoRoot, 'node_modules'), '@earendil-works/pi-mcp', ['package.json'], JSON.stringify({ version: '1.0.4', type: 'module' }))
    writeFiles(join(appDir, 'node_modules'), '@earendil-works/pi-mcp', ['package.json'], JSON.stringify({ version: '1.0.0', type: 'module' }))
    expect(() => verifyPiCompactionRuntime({ repoRoot, appDir })).toThrow('Pi MCP 版本')
  })

  test('rejects missing MCP runtime files and mismatched packaged MCP content', async () => {
    const { root, repoRoot, appDir } = createFixture()
    const clientPath = join(appDir, 'node_modules', '@earendil-works/pi-mcp/dist/client.js')
    rmSync(clientPath)
    expect(() => verifyPiCompactionRuntime({ repoRoot, appDir })).toThrow('缺少 dist/client.js')
    writePiMcpRuntime(join(appDir, 'node_modules'))
    writeFileSync(clientPath, `${PI_MCP_REQUIRED_MARKERS.join('\n')}\nchanged`)
    const resourcesDir = join(root, 'resources')
    await createAsar(appDir, resourcesDir)
    expect(() => verifyPiCompactionRuntime({ repoRoot, packagedResourcesDir: resourcesDir })).toThrow('packaged Pi MCP runtime 与根 Pi runtime 不一致')
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
