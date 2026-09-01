#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'

const PI_PACKAGE = '@earendil-works/pi-coding-agent'
const PI_PATCH_NAME = '@earendil-works%2Fpi-coding-agent@0.84.4.patch'
const PI_AGENT_CORE_PACKAGE = '@earendil-works/pi-agent-core'
const PI_AGENT_CORE_PATCH_NAME = '@earendil-works%2Fpi-agent-core@0.84.4.patch'

export const PI_COMPACTION_RUNTIME_FILES = [
  'dist/core/agent-session.js',
  'dist/core/compaction/compaction.js',
  'dist/core/compaction/utils.js',
  'dist/core/messages.js',
] as const

export const PI_COMPACTION_REQUIRED_MARKERS = [
  'estimatePreparedRequestTokens',
  'compactionAttempts < 2',
  'Use one physical summarization request',
  'COMPACTION_SUMMARY_HARD_MAX_TOKENS = 6144',
  'PROVIDER_RETAINED_HISTORY_MAX_TOKENS = 20000',
  'CHECKPOINT_TARGET_MIN_TOKENS = 2500',
  'projectProviderContextMessages',
  'complete list stored in compaction details',
  '_lastAgentEndedByTool',
  'endedByTerminatingTool',
] as const

export const PI_COMPACTION_FORBIDDEN_MARKERS = [
  'generateTurnPrefixSummary(',
  '**Turn Context (split turn):**',
] as const

export const PI_TERMINATION_RUNTIME_FILES = [
  'dist/agent-loop.js',
  'dist/types.d.ts',
] as const

export const PI_TERMINATION_REQUIRED_MARKERS = [
  'terminatedByTool: true',
  'terminatedByTool?: true',
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
  const [scope, name] = packageName.split('/')
  return join(nodeModulesDir, scope ?? '', name ?? '', ...relativePath.split('/'))
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
): {
  files: Map<string, Buffer>
  layout: 'asar' | 'unpacked'
} {
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

function assertRuntimeMarkers(
  files: Map<string, Buffer>,
  label: string,
  requiredMarkers: readonly string[],
  forbiddenMarkers: readonly string[] = [],
): void {
  const source = [...files.values()].map(content => content.toString('utf8')).join('\n')
  const missing = requiredMarkers.filter(marker => !source.includes(marker))
  if (missing.length > 0) {
    throw new Error(`[pi-runtime] ${label} 缺少压缩补丁标识: ${missing.join(', ')}`)
  }
  const forbidden = forbiddenMarkers.filter(marker => source.includes(marker))
  if (forbidden.length > 0) {
    throw new Error(`[pi-runtime] ${label} 仍包含旧 split-turn 双请求标识: ${forbidden.join(', ')}`)
  }
}

function assertSameFiles(expected: Map<string, Buffer>, actual: Map<string, Buffer>, label: string): void {
  const mismatched = [...expected.keys()].filter((relativePath) => {
    const expectedContent = expected.get(relativePath)
    const actualContent = actual.get(relativePath)
    return !expectedContent || !actualContent || sha256(expectedContent) !== sha256(actualContent)
  })
  if (mismatched.length > 0) {
    throw new Error(`[pi-runtime] ${label} 与根 patched dependency 不一致: ${mismatched.join(', ')}`)
  }
}

function addedPatchText(patch: string): string {
  return patch
    .split(/\r?\n/u)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n')
}

function assertPatchMarkers(
  repoRoot: string,
  patchName: string,
  requiredMarkers: readonly string[],
  forbiddenMarkers: readonly string[] = [],
): void {
  const patchPath = join(repoRoot, 'patches', patchName)
  if (!existsSync(patchPath)) {
    throw new Error(`[pi-runtime] 缺少 Pi patch: ${patchPath}`)
  }
  const additions = addedPatchText(readFileSync(patchPath, 'utf8'))
  const missing = requiredMarkers.filter(marker => !additions.includes(marker))
  if (missing.length > 0) {
    throw new Error(`[pi-runtime] Pi patch additions 缺少标识: ${missing.join(', ')}`)
  }
  const forbidden = forbiddenMarkers.filter(marker => additions.includes(marker))
  if (forbidden.length > 0) {
    throw new Error(`[pi-runtime] Pi patch additions 重新引入旧 split-turn 标识: ${forbidden.join(', ')}`)
  }
}

export function verifyPiCompactionRuntime(
  options: VerifyPiCompactionRuntimeOptions,
): VerifyPiCompactionRuntimeResult {
  const repoRoot = resolve(options.repoRoot)
  assertPatchMarkers(repoRoot, PI_PATCH_NAME, PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS)
  assertPatchMarkers(repoRoot, PI_AGENT_CORE_PATCH_NAME, PI_TERMINATION_REQUIRED_MARKERS)

  const rootCompactionFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root patched dependency', PI_PACKAGE, PI_COMPACTION_RUNTIME_FILES,
  )
  const rootTerminationFiles = readPackageFiles(
    join(repoRoot, 'node_modules'), 'root patched dependency', PI_AGENT_CORE_PACKAGE, PI_TERMINATION_RUNTIME_FILES,
  )
  assertRuntimeMarkers(
    rootCompactionFiles, 'root patched dependency', PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS,
  )
  assertRuntimeMarkers(rootTerminationFiles, 'root termination dependency', PI_TERMINATION_REQUIRED_MARKERS)

  let syncedFiles = 0
  if (options.appDir) {
    const appNodeModules = join(resolve(options.appDir), 'node_modules')
    const appCompactionFiles = readPackageFiles(
      appNodeModules, 'Electron synced runtime', PI_PACKAGE, PI_COMPACTION_RUNTIME_FILES,
    )
    const appTerminationFiles = readPackageFiles(
      appNodeModules, 'Electron synced runtime', PI_AGENT_CORE_PACKAGE, PI_TERMINATION_RUNTIME_FILES,
    )
    assertRuntimeMarkers(
      appCompactionFiles, 'Electron synced runtime', PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS,
    )
    assertRuntimeMarkers(appTerminationFiles, 'Electron synced termination runtime', PI_TERMINATION_REQUIRED_MARKERS)
    assertSameFiles(rootCompactionFiles, appCompactionFiles, 'Electron synced runtime')
    assertSameFiles(rootTerminationFiles, appTerminationFiles, 'Electron synced termination runtime')
    syncedFiles = appCompactionFiles.size + appTerminationFiles.size
  }

  let packagedFiles = 0
  let packagedLayout: 'asar' | 'unpacked' | undefined
  if (options.packagedResourcesDir) {
    const resourcesDir = resolve(options.packagedResourcesDir)
    const packagedCompaction = readPackagedFiles(resourcesDir, PI_PACKAGE, PI_COMPACTION_RUNTIME_FILES)
    const packagedTermination = readPackagedFiles(resourcesDir, PI_AGENT_CORE_PACKAGE, PI_TERMINATION_RUNTIME_FILES)
    assertRuntimeMarkers(
      packagedCompaction.files, 'packaged Electron runtime', PI_COMPACTION_REQUIRED_MARKERS, PI_COMPACTION_FORBIDDEN_MARKERS,
    )
    assertRuntimeMarkers(packagedTermination.files, 'packaged Electron termination runtime', PI_TERMINATION_REQUIRED_MARKERS)
    assertSameFiles(rootCompactionFiles, packagedCompaction.files, 'packaged Electron runtime')
    assertSameFiles(rootTerminationFiles, packagedTermination.files, 'packaged Electron termination runtime')
    if (packagedCompaction.layout !== packagedTermination.layout) {
      throw new Error('[pi-runtime] packaged Pi runtime layout 不一致')
    }
    packagedFiles = packagedCompaction.files.size + packagedTermination.files.size
    packagedLayout = packagedCompaction.layout
  }

  return {
    sourceFiles: rootCompactionFiles.size + rootTerminationFiles.size,
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
  console.log(`[pi-runtime] ✓ patch/root/synced ${result.sourceFiles}/${result.syncedFiles} files 一致${packaged}`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
