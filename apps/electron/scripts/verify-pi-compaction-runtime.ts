#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { extractFile } from '@electron/asar'

const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent'
const PI_AGENT_CORE_PACKAGE = '@earendil-works/pi-agent-core'
const PI_AI_PACKAGE = '@earendil-works/pi-ai'
const PI_MCP_PACKAGE = '@earendil-works/pi-mcp'
const PI_AI_RETRY_PATCH_NAME = '@earendil-works%2Fpi-ai@1.0.4.patch'

export const PI_COMPACTION_RUNTIME_FILES = [
  'dist/core/agent-session.js',
  'dist/core/session-manager.js',
  'dist/core/compaction/compaction.js',
  'dist/core/compaction/utils.js',
] as const

export const PI_COMPACTION_REQUIRED_MARKERS = [
  '_compactBeforeNextAssistantResponse',
  'prepareNextTurnWithContext',
  'session_before_compact',
  'agent_before_settle',
  'auto_retry_start',
] as const

// Pi 1.0 仍可在自身 compaction 算法中使用 turn-prefix summary；这里只拦截
// Domi 0.85.1 patch 曾注入的 provider-context projection helper。
export const PI_COMPACTION_FORBIDDEN_MARKERS = [
  'projectProviderContextMessages',
] as const

export const PI_TERMINATION_RUNTIME_FILES = [
  'dist/agent-loop.js',
  'dist/types.d.ts',
] as const

export const PI_TERMINATION_REQUIRED_MARKERS = [
  'shouldTerminateToolBatch',
  'terminate: true',
  'finishTurn',
] as const

export const PI_RETRY_RUNTIME_FILES = [
  'dist/utils/retry.js',
] as const

export const PI_RETRY_REQUIRED_MARKERS = [
  'unexpected non-whitespace character after JSON',
  'failed to fetch',
] as const

export const PI_RESPONSE_RUNTIME_FILES = [
  'dist/api/openai-responses-shared.js',
] as const

export const PI_RESPONSE_REQUIRED_MARKERS = [
  'textSlotsById',
  'recoveredTextBlocks',
  'domiResponsesDiagnostics',
] as const

export const PI_MCP_RUNTIME_FILES = [
  'package.json',
  'dist/index.js',
  'dist/client.js',
  'dist/transports/stdio.js',
  'dist/transports/streamable-http.js',
] as const

export const PI_MCP_REQUIRED_MARKERS = [
  'class McpClient', 'class StdioTransport', 'class StreamableHttpTransport', 'notifications/cancelled',
] as const

const PI_AI_PATCH_REQUIRED_MARKERS = [
  ...PI_RETRY_REQUIRED_MARKERS,
  ...PI_RESPONSE_REQUIRED_MARKERS,
] as const

export interface VerifyPiCompactionRuntimeOptions {
  repoRoot: string
  appDir?: string
  packagedResourcesDir?: string
}

export interface VerifyPiCompactionRuntimeResult {
  sourceFiles: number
  syncedFiles: number
  packagedFiles: number
  packagedLayout?: 'asar' | 'unpacked'
}

function packagePath(nodeModulesDir: string, packageName: string, relativePath: string): string {
  return join(nodeModulesDir, packageName, ...relativePath.split('/'))
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function readPackageFiles(
  nodeModulesDir: string,
  label: string,
  packageName: string,
  relativePaths: readonly string[],
): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const relativePath of relativePaths) {
    const filePath = packagePath(nodeModulesDir, packageName, relativePath)
    if (!existsSync(filePath)) {
      throw new Error(`[pi-runtime] ${label} 缺少 ${relativePath}: ${filePath}`)
    }
    files.set(relativePath, readFileSync(filePath))
  }
  return files
}

function readPackagedFiles(
  resourcesDir: string,
  packageName: string,
  relativePaths: readonly string[],
): { files: Map<string, Buffer>; layout: 'asar' | 'unpacked' } {
  const asarPath = join(resourcesDir, 'app.asar')
  if (existsSync(asarPath)) {
    const files = new Map<string, Buffer>()
    for (const relativePath of relativePaths) {
      const archivePath = join('node_modules', packageName, ...relativePath.split('/'))
      try {
        files.set(relativePath, extractFile(asarPath, archivePath))
      } catch (error) {
        throw new Error(`[pi-runtime] app.asar 缺少 ${archivePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { files, layout: 'asar' }
  }

  const unpackedNodeModules = join(resourcesDir, 'app', 'node_modules')
  if (!existsSync(unpackedNodeModules)) {
    throw new Error(`[pi-runtime] 未找到 app.asar 或 unpacked app runtime: ${resourcesDir}`)
  }
  return {
    files: readPackageFiles(unpackedNodeModules, 'packaged unpacked runtime', packageName, relativePaths),
    layout: 'unpacked',
  }
}

function runtimeText(files: Map<string, Buffer>): string {
  return [...files.values()].map(content => content.toString('utf8')).join('\n')
}

function assertRuntimeMarkers(
  files: Map<string, Buffer>,
  label: string,
  requiredMarkers: readonly string[],
  forbiddenMarkers: readonly string[] = [],
): void {
  const source = runtimeText(files)
  const missing = requiredMarkers.filter(marker => !source.includes(marker))
  if (missing.length > 0) {
    throw new Error(`[pi-runtime] ${label} 缺少运行时契约标识: ${missing.join(', ')}`)
  }
  const forbidden = forbiddenMarkers.filter(marker => source.includes(marker))
  if (forbidden.length > 0) {
    throw new Error(`[pi-runtime] ${label} 仍包含旧 provider-context projection 标识: ${forbidden.join(', ')}`)
  }
}

function assertSameFiles(expected: Map<string, Buffer>, actual: Map<string, Buffer>, label: string): void {
  const mismatched = [...expected.keys()].filter((relativePath) => {
    const expectedContent = expected.get(relativePath)
    const actualContent = actual.get(relativePath)
    return !expectedContent || !actualContent || sha256(expectedContent) !== sha256(actualContent)
  })
  if (mismatched.length > 0) {
    throw new Error(`[pi-runtime] ${label} 与根 Pi runtime 不一致: ${mismatched.join(', ')}`)
  }
}

function assertMcpVersion(files: Map<string, Buffer>, label: string): void {
  const manifest: unknown = JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}')
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== '1.0.4'
    || !('type' in manifest) || manifest.type !== 'module') {
    throw new Error(`[pi-runtime] ${label} 不满足 Pi MCP 版本/ESM 契约 (1.0.4)`)
  }
}

function addedPatchText(patch: string): string {
  return patch
    .split(/\r?\n/u)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n')
}

function assertSamePackagedMcpFiles(expected: Map<string, Buffer>, actual: Map<string, Buffer>, label: string): void {
  assertSameFiles(new Map([...expected].filter(([name]) => name !== 'package.json')), actual, label)
  // builder 会移除 scripts/keywords 并重写 JSON；代码仍逐字节一致，manifest 按加载契约比对。
  // exports/imports 的条件顺序影响 Node 解析，不能仅按无序对象深比较。
  const source: Record<string, unknown> = JSON.parse(expected.get('package.json')!.toString('utf8'))
  const packaged: Record<string, unknown> = JSON.parse(actual.get('package.json')!.toString('utf8'))
  for (const key of ['name', 'version', 'type', 'main', 'exports', 'imports', 'dependencies', 'optionalDependencies', 'peerDependencies', 'engines', 'bin', 'os', 'cpu']) {
    const same = key === 'exports' || key === 'imports'
      ? JSON.stringify(source[key]) === JSON.stringify(packaged[key])
      : isDeepStrictEqual(source[key], packaged[key])
    if (!same) throw new Error(`[pi-runtime] ${label} 与根 Pi runtime 不一致: package.json (${key})`)
  }
}

function assertPatchMarkers(repoRoot: string): void {
  const patchPath = join(repoRoot, 'patches', PI_AI_RETRY_PATCH_NAME)
  if (!existsSync(patchPath)) throw new Error(`[pi-runtime] 缺少 Pi 1.0 retry patch: ${patchPath}`)
  const additions = addedPatchText(readFileSync(patchPath, 'utf8'))
  const missing = PI_AI_PATCH_REQUIRED_MARKERS.filter(marker => !additions.includes(marker))
  if (missing.length > 0) {
    throw new Error(`[pi-runtime] Pi 1.0 AI patch 缺少标识: ${missing.join(', ')}`)
  }
}

export function verifyPiCompactionRuntime(
  options: VerifyPiCompactionRuntimeOptions,
): VerifyPiCompactionRuntimeResult {
  const repoRoot = resolve(options.repoRoot)
  assertPatchMarkers(repoRoot)

  const rootCompactionFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root Pi coding-agent runtime', PI_CODING_AGENT_PACKAGE, PI_COMPACTION_RUNTIME_FILES,
  )
  const rootTerminationFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root Pi agent-core runtime', PI_AGENT_CORE_PACKAGE, PI_TERMINATION_RUNTIME_FILES,
  )
  const rootRetryFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root Pi AI retry runtime', PI_AI_PACKAGE, PI_RETRY_RUNTIME_FILES,
  )
  const rootResponseFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root Pi AI Responses runtime', PI_AI_PACKAGE, PI_RESPONSE_RUNTIME_FILES,
  )
  const rootMcpFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root Pi MCP runtime', PI_MCP_PACKAGE, PI_MCP_RUNTIME_FILES,
  )
  assertMcpVersion(rootMcpFiles, 'root Pi MCP runtime')
  assertRuntimeMarkers(rootMcpFiles, 'root Pi MCP runtime', PI_MCP_REQUIRED_MARKERS)
  assertRuntimeMarkers(rootCompactionFiles, 'root Pi coding-agent runtime', PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS)
  assertRuntimeMarkers(rootTerminationFiles, 'root Pi agent-core runtime', PI_TERMINATION_REQUIRED_MARKERS)
  assertRuntimeMarkers(rootRetryFiles, 'root Pi AI retry runtime', PI_RETRY_REQUIRED_MARKERS)
  assertRuntimeMarkers(rootResponseFiles, 'root Pi AI Responses runtime', PI_RESPONSE_REQUIRED_MARKERS)

  let syncedFiles = 0
  if (options.appDir) {
    const appNodeModules = join(resolve(options.appDir), 'node_modules')
    const appCompactionFiles = readPackageFiles(
      appNodeModules, 'Electron synced Pi coding-agent runtime', PI_CODING_AGENT_PACKAGE, PI_COMPACTION_RUNTIME_FILES,
    )
    const appTerminationFiles = readPackageFiles(
      appNodeModules, 'Electron synced Pi agent-core runtime', PI_AGENT_CORE_PACKAGE, PI_TERMINATION_RUNTIME_FILES,
    )
    const appRetryFiles = readPackageFiles(
      appNodeModules, 'Electron synced Pi AI retry runtime', PI_AI_PACKAGE, PI_RETRY_RUNTIME_FILES,
    )
    const appResponseFiles = readPackageFiles(
      appNodeModules, 'Electron synced Pi AI Responses runtime', PI_AI_PACKAGE, PI_RESPONSE_RUNTIME_FILES,
    )
    const appMcpFiles = readPackageFiles(appNodeModules, 'Electron synced Pi MCP runtime', PI_MCP_PACKAGE, PI_MCP_RUNTIME_FILES)
    assertMcpVersion(appMcpFiles, 'Electron synced Pi MCP runtime')
    assertRuntimeMarkers(appMcpFiles, 'Electron synced Pi MCP runtime', PI_MCP_REQUIRED_MARKERS)
    assertSameFiles(rootMcpFiles, appMcpFiles, 'Electron synced Pi MCP runtime')
    assertRuntimeMarkers(appCompactionFiles, 'Electron synced Pi coding-agent runtime', PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS)
    assertRuntimeMarkers(appTerminationFiles, 'Electron synced Pi agent-core runtime', PI_TERMINATION_REQUIRED_MARKERS)
    assertRuntimeMarkers(appRetryFiles, 'Electron synced Pi AI retry runtime', PI_RETRY_REQUIRED_MARKERS)
    assertRuntimeMarkers(appResponseFiles, 'Electron synced Pi AI Responses runtime', PI_RESPONSE_REQUIRED_MARKERS)
    assertSameFiles(rootCompactionFiles, appCompactionFiles, 'Electron synced Pi coding-agent runtime')
    assertSameFiles(rootTerminationFiles, appTerminationFiles, 'Electron synced Pi agent-core runtime')
    assertSameFiles(rootRetryFiles, appRetryFiles, 'Electron synced Pi AI retry runtime')
    assertSameFiles(rootResponseFiles, appResponseFiles, 'Electron synced Pi AI Responses runtime')
    syncedFiles = appCompactionFiles.size + appTerminationFiles.size + appRetryFiles.size + appResponseFiles.size + appMcpFiles.size
  }

  let packagedFiles = 0
  let packagedLayout: 'asar' | 'unpacked' | undefined
  if (options.packagedResourcesDir) {
    const resourcesDir = resolve(options.packagedResourcesDir)
    const packagedCompaction = readPackagedFiles(resourcesDir, PI_CODING_AGENT_PACKAGE, PI_COMPACTION_RUNTIME_FILES)
    const packagedTermination = readPackagedFiles(resourcesDir, PI_AGENT_CORE_PACKAGE, PI_TERMINATION_RUNTIME_FILES)
    const packagedRetry = readPackagedFiles(resourcesDir, PI_AI_PACKAGE, PI_RETRY_RUNTIME_FILES)
    const packagedResponse = readPackagedFiles(resourcesDir, PI_AI_PACKAGE, PI_RESPONSE_RUNTIME_FILES)
    const packagedMcp = readPackagedFiles(resourcesDir, PI_MCP_PACKAGE, PI_MCP_RUNTIME_FILES)
    assertMcpVersion(packagedMcp.files, 'packaged Pi MCP runtime')
    assertRuntimeMarkers(packagedMcp.files, 'packaged Pi MCP runtime', PI_MCP_REQUIRED_MARKERS)
    assertSamePackagedMcpFiles(rootMcpFiles, packagedMcp.files, 'packaged Pi MCP runtime')
    assertRuntimeMarkers(packagedCompaction.files, 'packaged Pi coding-agent runtime', PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS)
    assertRuntimeMarkers(packagedTermination.files, 'packaged Pi agent-core runtime', PI_TERMINATION_REQUIRED_MARKERS)
    assertRuntimeMarkers(packagedRetry.files, 'packaged Pi AI retry runtime', PI_RETRY_REQUIRED_MARKERS)
    assertRuntimeMarkers(packagedResponse.files, 'packaged Pi AI Responses runtime', PI_RESPONSE_REQUIRED_MARKERS)
    assertSameFiles(rootCompactionFiles, packagedCompaction.files, 'packaged Pi coding-agent runtime')
    assertSameFiles(rootTerminationFiles, packagedTermination.files, 'packaged Pi agent-core runtime')
    assertSameFiles(rootRetryFiles, packagedRetry.files, 'packaged Pi AI retry runtime')
    assertSameFiles(rootResponseFiles, packagedResponse.files, 'packaged Pi AI Responses runtime')
    if (new Set([packagedCompaction.layout, packagedTermination.layout, packagedRetry.layout, packagedResponse.layout, packagedMcp.layout]).size !== 1) {
      throw new Error('[pi-runtime] packaged Pi runtime layout 不一致')
    }
    packagedFiles = packagedCompaction.files.size + packagedTermination.files.size + packagedRetry.files.size + packagedResponse.files.size + packagedMcp.files.size
    packagedLayout = packagedCompaction.layout
  }

  return {
    sourceFiles: rootCompactionFiles.size + rootTerminationFiles.size + rootRetryFiles.size + rootResponseFiles.size + rootMcpFiles.size,
    syncedFiles,
    packagedFiles,
    packagedLayout,
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

function main(): void {
  const appDir = resolve(import.meta.dir, '..')
  const repoRoot = resolve(appDir, '../..')
  const packagedResourcesDir = readArg('packaged-resources')
  const result = verifyPiCompactionRuntime({ repoRoot, appDir, packagedResourcesDir })
  const packaged = result.packagedLayout
    ? `，packaged ${result.packagedFiles} files (${result.packagedLayout})`
    : ''
  console.log(`[pi-runtime] ✓ Pi 1.0 native contracts/root/synced ${result.sourceFiles}/${result.syncedFiles} files 一致${packaged}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
