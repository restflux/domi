#!/usr/bin/env bun
/**
 * Windows 双通道打包脚本。
 *
 * fast：本地快速验证。跳过 Electron Builder 的 executable edit/sign，使用
 * Electron Builder 缓存中的原生 rcedit 注入图标与版本元数据，并使用 store 压缩生成 NSIS。
 * release：正式发布。保留 Electron Builder 标准 executable edit 与代码签名流程。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPiCompactionRuntime } from './verify-pi-compaction-runtime'

type DistWinMode = 'fast' | 'release'

export interface DistWinOptions {
  mode: DistWinMode
  dryRun: boolean
  /** 强制全量重建（忽略 win-unpacked 复用指纹）。 */
  full: boolean
  /** 构建阶段是否并行执行（fast 通道默认 true）。 */
  parallel: boolean
  /** fast 通道关闭 asar（默认启用 asar 以保证安装速度；--no-asar 可关闭以加速打包但安装会显著变慢）。 */
  noAsar: boolean
}

export interface DistWinContext {
  appDir: string
  electronBuilderPath: string
  rceditPath?: string
  version: string
  productName: string
  description: string
  copyright: string
}

export interface DistWinStep {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface DistWinPlan {
  mode: DistWinMode
  outputDir: string
  artifactPath: string
  /** 强制全量重建（忽略 win-unpacked 复用指纹）。 */
  full: boolean
  /** 本次打包是否启用 asar（fast 通道默认 false；release 恒为 true）。 */
  asarMode: boolean
  steps: DistWinStep[]
}

interface PackageManifest {
  version: string
  description?: string
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultAppDir = resolve(scriptDir, '..')
const defaultRepoRoot = resolve(defaultAppDir, '../..')

/** win-unpacked 复用指纹文件名（存于 outputDir 下，与 win-unpacked 同生命周期）。 */
const SOURCE_FINGERPRINT_FILE = '.source-fingerprint'

export function parseDistWinArgs(args: string[]): DistWinOptions {
  const fast = args.includes('--fast')
  const release = args.includes('--release')
  if (fast && release) {
    throw new Error('不能同时指定 --fast 和 --release')
  }
  const unknown = args.filter((arg) => !['--fast', '--release', '--dry-run', '--full', '--no-parallel', '--no-asar', '--help', '-h'].includes(arg))
  if (unknown.length > 0) {
    throw new Error(`未知参数: ${unknown.join(', ')}`)
  }
  return {
    mode: fast ? 'fast' : 'release',
    dryRun: args.includes('--dry-run'),
    full: args.includes('--full'),
    parallel: !args.includes('--no-parallel'),
    noAsar: args.includes('--no-asar'),
  }
}

function readTopLevelYamlValue(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))
  if (!match?.[1]) return undefined
  const value = match[1].trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function findCachedRceditPath(): string | undefined {
  const explicitPath = process.env.DOMI_RCEDIT_PATH
  if (explicitPath && existsSync(explicitPath)) return resolve(explicitPath)

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const cacheRoot = join(localAppData, 'electron-builder', 'Cache', 'winCodeSign')
  if (!existsSync(cacheRoot)) return undefined

  const candidates: string[] = []
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(cacheRoot, entry.name, 'rcedit-x64.exe')
    if (existsSync(candidate)) candidates.push(candidate)
  }
  candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return candidates[0]
}

function createDefaultContext(): DistWinContext {
  const manifest = JSON.parse(
    readFileSync(join(defaultAppDir, 'package.json'), 'utf8'),
  ) as PackageManifest
  const builderConfig = readFileSync(join(defaultAppDir, 'electron-builder.yml'), 'utf8')
  const electronBuilderPath = join(
    defaultRepoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.exe' : 'electron-builder',
  )

  return {
    appDir: defaultAppDir,
    electronBuilderPath,
    rceditPath: findCachedRceditPath(),
    version: manifest.version,
    productName: readTopLevelYamlValue(builderConfig, 'productName') ?? 'Domi',
    description: manifest.description ?? 'Domi personal coding workbench',
    copyright: readTopLevelYamlValue(builderConfig, 'copyright') ?? '',
  }
}

function createRceditArgs(context: DistWinContext, executablePath: string): string[] {
  const iconPath = join(context.appDir, 'resources', 'icon.ico')
  const args = [
    executablePath,
    '--set-version-string',
    'FileDescription',
    context.description,
    '--set-version-string',
    'ProductName',
    context.productName,
    '--set-file-version',
    context.version,
    '--set-product-version',
    context.version,
    '--set-icon',
    iconPath,
  ]
  if (context.copyright) {
    args.push('--set-version-string', 'LegalCopyright', context.copyright)
  }
  return args
}

/**
 * 计算 fast 通道打包输入指纹：dist/ 内容 hash + node_modules 结构指纹 +
 * 关键配置文本 + asar 模式。指纹不变时 win-unpacked 可复用，跳过 electron-builder --dir。
 */
export function computeSourceFingerprint(context: DistWinContext, asarMode = true): string {
  const hash = createHash('sha256')
  hash.update(`asar:${asarMode ? 'true' : 'false'}:`)

  const distDir = join(context.appDir, 'dist')
  if (existsSync(distDir)) {
    hash.update('dist:')
    for (const file of walkFiles(distDir)) {
      const relPath = file.slice(distDir.length).replaceAll('\\', '/')
      const stat = statSync(file)
      hash.update(`${relPath}:${stat.size}:`)
      hash.update(readFileSync(file))
    }
  }

  const nodeModulesDir = join(context.appDir, 'node_modules')
  if (existsSync(nodeModulesDir)) {
    hash.update('node_modules:')
    for (const file of walkFiles(nodeModulesDir, { skipTopLevel: ['.vite'] })) {
      const relPath = file.slice(nodeModulesDir.length).replaceAll('\\', '/')
      const stat = statSync(file)
      hash.update(`${relPath}:${stat.size}:${stat.mtimeMs}`)
    }
  }

  for (const configFile of ['package.json', 'electron-builder.yml', 'vite.config.ts']) {
    const configPath = join(context.appDir, configFile)
    if (existsSync(configPath)) {
      hash.update(`${configFile}:`)
      hash.update(readFileSync(configPath))
    }
  }

  return hash.digest('hex')
}

function walkFiles(root: string, options: { skipTopLevel?: string[] } = {}): string[] {
  const result: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries = readdirSync(current)
    if (current === root && options.skipTopLevel) {
      const skip = new Set(options.skipTopLevel)
      entries = entries.filter((entry) => !skip.has(entry))
    }
    for (const entry of entries) {
      const fullPath = join(current, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) stack.push(fullPath)
      else result.push(fullPath)
    }
  }
  return result.sort()
}

function readStoredFingerprint(outputDir: string): string {
  const fingerprintPath = join(outputDir, SOURCE_FINGERPRINT_FILE)
  if (!existsSync(fingerprintPath)) return ''
  return readFileSync(fingerprintPath, 'utf8').trim()
}

function writeStoredFingerprint(outputDir: string, fingerprint: string): void {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, SOURCE_FINGERPRINT_FILE), fingerprint)
}

export function createDistWinPlan(
  options: DistWinOptions,
  context: DistWinContext,
): DistWinPlan {
  const outputDir = options.mode === 'fast'
    ? join(context.appDir, 'out', 'fast')
    : join(context.appDir, 'out')
  const unpackedDir = join(outputDir, 'win-unpacked')
  const executablePath = join(unpackedDir, `${context.productName}.exe`)
  const artifactPath = join(outputDir, `${context.productName} Setup ${context.version}.exe`)
  const unsignedEnv = {
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    CSC_LINK: '',
    CSC_KEY_PASSWORD: '',
    WIN_CSC_LINK: '',
    WIN_CSC_KEY_PASSWORD: '',
    // 清空发布 token：Domi 无自动更新通道，避免 electron-builder 检测到
    // GITHUB_TOKEN 后尝试解析 github publish provider（repository 不可检测时
    // 会得到 [null] 配置导致生成 update info 崩溃）
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  }
  const buildArgs = options.parallel ? ['run', 'build:parallel'] : ['run', 'build']
  const commonSteps: DistWinStep[] = [
    {
      id: 'build',
      name: options.parallel ? '构建 Electron 应用（并行）' : '构建 Electron 应用',
      command: process.execPath,
      args: buildArgs,
    },
    {
      id: 'sync-runtime-deps',
      name: '同步主进程运行时依赖',
      command: process.execPath,
      args: options.mode === 'fast' ? ['run', 'sync:runtime-deps', '--incremental'] : ['run', 'sync:runtime-deps'],
    },
  ]

  if (options.mode === 'release') {
    return {
      mode: options.mode,
      outputDir,
      artifactPath,
      full: options.full,
      asarMode: true,
      steps: [
        ...commonSteps,
        {
          id: 'package-release',
          name: '生成正式 Windows 安装包',
          command: context.electronBuilderPath,
          args: ['--win', '--x64', '--publish', 'never'],
        },
      ],
    }
  }

  if (!context.rceditPath) {
    throw new Error(
      '未找到 rcedit-x64.exe。可设置 DOMI_RCEDIT_PATH，或先在启用 Windows Developer Mode 的环境运行一次正式打包以初始化 electron-builder 缓存。',
    )
  }

  const outputArg = `--config.directories.output=${outputDir}`
  // fast 通道默认启用 asar：保证 NSIS 安装器快速（单文件）且安装体验正常。
  // --no-asar 可关闭（--dir 从 ~13min 降至 ~20s），但安装会因 2 万+ 平铺小文件显著变慢。
  const useAsar = !options.noAsar
  const asarArgs = useAsar ? [] : ['--config.asar=false']
  return {
    mode: options.mode,
    outputDir,
    artifactPath,
    full: options.full,
    asarMode: useAsar,
    steps: [
      ...commonSteps,
      {
        id: 'package-unpacked',
        name: useAsar ? '生成本地 Windows unpacked 目录（源未变化时复用缓存）' : '生成本地 Windows unpacked 目录（无 asar，源未变化时复用缓存）',
        command: context.electronBuilderPath,
        args: [
          '--win',
          '--x64',
          '--dir',
          '--config.win.signAndEditExecutable=false',
          outputArg,
          ...asarArgs,
        ],
        env: unsignedEnv,
      },
      {
        id: 'edit-executable',
        name: '注入 Windows 图标与版本元数据',
        command: context.rceditPath,
        args: createRceditArgs(context, executablePath),
        env: unsignedEnv,
      },
      {
        id: 'package-nsis',
        name: '生成本地快速 NSIS 安装包',
        command: context.electronBuilderPath,
        args: [
          '--win',
          '--x64',
          '--prepackaged',
          unpackedDir,
          '--publish',
          'never',
          '--config.win.signAndEditExecutable=false',
          '--config.compression=store',
          outputArg,
          ...asarArgs,
        ],
        env: unsignedEnv,
      },
    ],
  }
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function quoteArg(value: string): string {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value
}

function printPlan(plan: DistWinPlan): void {
  console.log(`\n[dist:win] 通道: ${plan.mode}`)
  console.log(`[dist:win] 输出: ${plan.outputDir}`)
  for (const [index, step] of plan.steps.entries()) {
    console.log(
      `[dist:win] ${index + 1}/${plan.steps.length} ${step.name}\n  ${quoteArg(step.command)} ${step.args.map(quoteArg).join(' ')}`,
    )
  }
  if (plan.mode === 'fast') {
    console.log('[dist:win] 注意: fast 产物未签名且使用 store 压缩，文件会更大，仅用于本地验证。')
    console.log(`[dist:win] 提示: ${plan.asarMode ? 'asar 已启用' : 'asar 已关闭（--no-asar 已指定，安装会显著变慢）'}；源未变化时复用上次 win-unpacked（--full 可强制全量重建）。`)
  }
}

export function preservePreviousFastArtifacts(outputDir: string, artifactPath: string): string | undefined {
  if (!existsSync(outputDir)) return undefined
  const setupPrefix = basename(artifactPath).split(' Setup ')[0] + ' Setup '
  const previousArtifacts = readdirSync(outputDir)
    .filter((name) => (
      name.startsWith(setupPrefix) &&
      (name.endsWith('.exe') || name.endsWith('.exe.blockmap'))
    ))
    .map((name) => join(outputDir, name))
    .filter((path) => existsSync(path))
  if (previousArtifacts.length === 0) return undefined

  const historyRoot = join(dirname(outputDir), 'fast-history')
  mkdirSync(historyRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[.:]/gu, '-')
  let archiveDir = join(historyRoot, stamp)
  let suffix = 2
  while (existsSync(archiveDir)) {
    archiveDir = join(historyRoot, `${stamp}-${suffix}`)
    suffix += 1
  }
  mkdirSync(archiveDir)

  for (const sourcePath of previousArtifacts) {
    renameSync(sourcePath, join(archiveDir, basename(sourcePath)))
  }
  return archiveDir
}

function runPlan(plan: DistWinPlan, context: DistWinContext): void {
  if (process.platform !== 'win32') {
    throw new Error('Windows 打包脚本只能在 Windows 上执行')
  }
  const requiredPaths = plan.mode === 'fast'
    ? [context.electronBuilderPath, context.rceditPath]
    : [context.electronBuilderPath]
  for (const requiredPath of requiredPaths) {
    if (!requiredPath) throw new Error('fast 通道缺少 rcedit-x64.exe')
    if (!existsSync(requiredPath)) {
      throw new Error(`缺少打包工具: ${requiredPath}`)
    }
  }
  if (plan.mode === 'fast') {
    const archiveDir = preservePreviousFastArtifacts(plan.outputDir, plan.artifactPath)
    // 保留 win-unpacked 与指纹文件：源未变化时复用，跳过 electron-builder --dir。
    mkdirSync(plan.outputDir, { recursive: true })
    if (archiveDir) {
      console.log(`[dist:win] 已保留上一份安装包: ${archiveDir}`)
    }
  }

  const totalStarted = Date.now()
  for (const [index, step] of plan.steps.entries()) {
    console.log(`\n[dist:win] ${index + 1}/${plan.steps.length} ${step.name}`)

    if (step.id === 'package-unpacked' && !plan.full) {
      const fingerprint = computeSourceFingerprint(context, plan.asarMode)
      const unpackedExecutable = join(plan.outputDir, 'win-unpacked', `${context.productName}.exe`)
      if (readStoredFingerprint(plan.outputDir) === fingerprint && existsSync(unpackedExecutable)) {
        verifyPiCompactionRuntime({
          repoRoot: defaultRepoRoot,
          appDir: context.appDir,
          packagedResourcesDir: join(plan.outputDir, 'win-unpacked', 'resources'),
        })
        console.log('[dist:win] ✓ 源未变化，复用上次 win-unpacked（--full 可强制重建）')
        continue
      }
      rmSync(join(plan.outputDir, 'win-unpacked'), { recursive: true, force: true })
    }

    const started = Date.now()
    const result = spawnSync(step.command, step.args, {
      cwd: context.appDir,
      env: { ...process.env, ...step.env },
      stdio: 'inherit',
      shell: false,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`${step.name}失败，退出码 ${result.status ?? 'unknown'}`)
    }

    if (step.id === 'package-unpacked') {
      verifyPiCompactionRuntime({
        repoRoot: defaultRepoRoot,
        appDir: context.appDir,
        packagedResourcesDir: join(plan.outputDir, 'win-unpacked', 'resources'),
      })
      writeStoredFingerprint(plan.outputDir, computeSourceFingerprint(context, plan.asarMode))
    }
    console.log(`[dist:win] ✓ ${step.name} (${formatDuration(Date.now() - started)})`)
  }

  if (plan.mode === 'release') {
    verifyPiCompactionRuntime({
      repoRoot: defaultRepoRoot,
      appDir: context.appDir,
      packagedResourcesDir: join(plan.outputDir, 'win-unpacked', 'resources'),
    })
  }
  if (!existsSync(plan.artifactPath)) {
    throw new Error(`打包完成但未找到预期产物: ${plan.artifactPath}`)
  }
  console.log(`\n[dist:win] ✓ 完成 (${formatDuration(Date.now() - totalStarted)})`)
  console.log(`[dist:win] 安装包: ${plan.artifactPath}`)
}

function printHelp(): void {
  console.log(`Windows 双通道打包\n\n用法:\n  bun run scripts/dist-win.ts --fast [--dry-run]\n  bun run scripts/dist-win.ts --release [--dry-run]\n\n通道:\n  --fast     本地无签名快速包，独立输出到 out/fast，使用 store 压缩\n  --release      正式发布包，使用 Electron Builder 标准编辑和签名流程（默认）\n\n选项:\n  --dry-run      只打印计划不执行\n  --full         强制全量重建（忽略 win-unpacked 复用指纹）\n  --no-parallel  构建阶段使用顺序构建（默认并行）\n  --no-asar      fast 通道关闭 asar 归档（加速打包但安装显著变慢，默认启用 asar）`)
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }
  const options = parseDistWinArgs(args)
  const context = createDefaultContext()
  const plan = createDistWinPlan(options, context)
  printPlan(plan)
  if (!options.dryRun) runPlan(plan, context)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(`\n[dist:win] ✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
