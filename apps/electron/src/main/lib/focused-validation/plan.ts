import { lstat, opendir, readFile, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'

export interface FocusedValidationPlanInput {
  projectRoot: string
  changedFiles: readonly string[]
  signal?: AbortSignal
}

export interface FocusedValidationPackage {
  name: string
  path: string
  relation: 'direct' | 'dependent'
}

export interface FocusedValidationPlan {
  confidence: 'high' | 'medium' | 'none'
  testFiles: string[]
  command: string | null
  omittedTestCount: number
  affectedPackages: FocusedValidationPackage[]
  typecheckCommands: string[]
  omittedTypecheckCount: number
  reasons: string[]
}

export const FOCUSED_VALIDATION_MAX_TEST_FILES = 20
export const FOCUSED_VALIDATION_MAX_SCANNED_TEST_FILES = 500
export const FOCUSED_VALIDATION_MAX_SCANNED_DIRECTORIES = 5_000
export const FOCUSED_VALIDATION_MAX_SCANNED_ENTRIES = 50_000
export const FOCUSED_VALIDATION_MAX_SINGLE_TEST_BYTES = 1_000_000
export const FOCUSED_VALIDATION_MAX_TOTAL_TEST_BYTES = 16_000_000
export const FOCUSED_VALIDATION_MAX_COMMAND_LENGTH = 4_000
export const FOCUSED_VALIDATION_MAX_WORKSPACE_PATTERNS = 50
export const FOCUSED_VALIDATION_MAX_WORKSPACE_PACKAGES = 100
export const FOCUSED_VALIDATION_MAX_TYPECHECK_COMMANDS = 20

const TEST_FILE_PATTERN = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)|__tests__\/[^/]+\.[cm]?[jt]sx?)$/i
const SOURCE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/i
const TEST_SOURCE_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] as const
const ROOT_SCOPE_FILES = new Set([
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  'jsconfig.json',
])
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.context',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '.vite',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  'vendor',
  'venv',
])

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

function insertSortedPath(paths: string[], path: string): void {
  let low = 0
  let high = paths.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (comparePaths(paths[middle]!, path) < 0) low = middle + 1
    else high = middle
  }
  paths.splice(low, 0, path)
}

function normalizeChangedFile(path: string): string {
  if (!path || path.includes('\0') || posix.isAbsolute(path) || win32.isAbsolute(path)) {
    throw new Error('changedFiles must contain non-empty project-relative paths')
  }
  const portable = path.replace(/\\/g, '/')
  if (portable.split('/').includes('..')) {
    throw new Error('changedFiles must not contain parent traversal')
  }
  const normalized = posix.normalize(portable)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('changedFiles must contain project-relative file paths')
  }
  return normalized
}

function isCrossShellSafePath(value: string): boolean {
  // The generated command can run through Git Bash, WSL, cmd, or PowerShell.
  // Reject expansion/control metacharacters instead of pretending one quoting
  // dialect is portable across all four shells.
  return !/["'$`\\%!\r\n;&|<>^]/.test(value)
}

function quoteCommandArgument(value: string): string {
  return `"${value}"`
}

function moduleKeys(path: string): string[] {
  const keys = new Set([path, path.replace(SOURCE_EXTENSION_PATTERN, '')])
  if (/\/index\.[cm]?[jt]sx?$/i.test(path)) keys.add(posix.dirname(path))
  return [...keys]
}

function staticRelativeImports(source: string): string[] {
  const imports: string[] = []
  const pattern = /(?:^|[;\r\n])\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\r\n;]*?\s+from\s*)?(['"])(\.[^'"\r\n]+)\1/gm
  for (const match of source.matchAll(pattern)) imports.push(match[2]!)
  return imports
}

function importTargetsChangedFile(testFile: string, specifier: string, changedFile: string): boolean {
  const resolved = posix.normalize(posix.join(posix.dirname(testFile), specifier))
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) return false
  const changedKeys = new Set(moduleKeys(changedFile))
  return moduleKeys(resolved).some(key => changedKeys.has(key))
}

interface TestFileScanResult {
  testFiles: string[]
  truncated: boolean
}

async function listTestFiles(
  projectRoot: string,
  signal: AbortSignal | undefined,
): Promise<TestFileScanResult> {
  const testFiles: string[] = []
  const pendingDirectories = ['']
  let scannedDirectories = 0
  let scannedEntries = 0
  let truncated = false

  while (pendingDirectories.length > 0) {
    throwIfAborted(signal)
    if (scannedDirectories >= FOCUSED_VALIDATION_MAX_SCANNED_DIRECTORIES) {
      truncated = true
      break
    }
    const relativeDirectory = pendingDirectories.shift()!
    scannedDirectories += 1
    let directory
    try {
      directory = await opendir(
        relativeDirectory ? join(projectRoot, ...relativeDirectory.split('/')) : projectRoot,
      )
    } catch {
      truncated = true
      continue
    }

    try {
      for await (const entry of directory) {
        throwIfAborted(signal)
        scannedEntries += 1
        if (scannedEntries > FOCUSED_VALIDATION_MAX_SCANNED_ENTRIES) {
          truncated = true
          return { testFiles: testFiles.sort(comparePaths), truncated }
        }
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue
          if (scannedDirectories + pendingDirectories.length >= FOCUSED_VALIDATION_MAX_SCANNED_DIRECTORIES) {
            truncated = true
            continue
          }
          insertSortedPath(pendingDirectories, relativePath)
        } else if (entry.isFile() && TEST_FILE_PATTERN.test(relativePath)) {
          if (testFiles.length >= FOCUSED_VALIDATION_MAX_SCANNED_TEST_FILES) {
            truncated = true
            return { testFiles: testFiles.sort(comparePaths), truncated }
          }
          testFiles.push(relativePath)
        }
      }
    } catch (error) {
      throwIfAborted(signal)
      truncated = true
    }
  }
  return { testFiles: testFiles.sort(comparePaths), truncated }
}

async function directImportTests(
  projectRoot: string,
  changedFiles: readonly string[],
  signal: AbortSignal | undefined,
): Promise<TestFileScanResult> {
  if (changedFiles.length === 0) return { testFiles: [], truncated: false }
  const scan = await listTestFiles(projectRoot, signal)
  const selected: string[] = []
  let truncated = scan.truncated
  let totalReadBytes = 0
  for (const testFile of scan.testFiles) {
    throwIfAborted(signal)
    const absolutePath = join(projectRoot, ...testFile.split('/'))
    let fileSize: number
    try {
      fileSize = (await stat(absolutePath)).size
    } catch {
      truncated = true
      continue
    }
    if (
      fileSize > FOCUSED_VALIDATION_MAX_SINGLE_TEST_BYTES
      || totalReadBytes + fileSize > FOCUSED_VALIDATION_MAX_TOTAL_TEST_BYTES
    ) {
      truncated = true
      break
    }
    let source: string
    try {
      source = await readFile(absolutePath, { encoding: 'utf8', signal })
    } catch {
      throwIfAborted(signal)
      truncated = true
      continue
    }
    const readBytes = Buffer.byteLength(source)
    if (
      readBytes > FOCUSED_VALIDATION_MAX_SINGLE_TEST_BYTES
      || totalReadBytes + readBytes > FOCUSED_VALIDATION_MAX_TOTAL_TEST_BYTES
    ) {
      truncated = true
      break
    }
    totalReadBytes += readBytes
    if (staticRelativeImports(source).some(specifier => (
      changedFiles.some(changedFile => importTargetsChangedFile(testFile, specifier, changedFile))
    ))) selected.push(testFile)
  }
  return { testFiles: selected, truncated }
}

async function existingChangedTests(
  projectRoot: string,
  changedFiles: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const existing: string[] = []
  for (const changedFile of changedFiles) {
    if (!TEST_FILE_PATTERN.test(changedFile)) continue
    throwIfAborted(signal)
    try {
      if ((await stat(join(projectRoot, ...changedFile.split('/')))).isFile()) existing.push(changedFile)
    } catch {
      throwIfAborted(signal)
    }
  }
  return existing
}

async function existingSiblingTests(
  projectRoot: string,
  changedFile: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const match = changedFile.match(/^(.*)\.([cm]?[jt]sx?)$/i)
  if (!match || TEST_FILE_PATTERN.test(changedFile)) return []
  const candidates = TEST_SOURCE_EXTENSIONS.flatMap(extension => [
    `${match[1]}.test.${extension}`,
    `${match[1]}.spec.${extension}`,
  ])
  const existing: string[] = []
  for (const candidate of candidates) {
    throwIfAborted(signal)
    try {
      if ((await stat(join(projectRoot, ...candidate.split('/')))).isFile()) existing.push(candidate)
    } catch {
      throwIfAborted(signal)
      // Missing sibling tests are expected.
    }
  }
  return existing
}

function targetableBunTestScript(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const script = value.trim().replace(/\s+/g, ' ')
  if (!/^bun(?:\.exe)? test(?: [A-Za-z0-9][A-Za-z0-9._:/=-]*| --?[A-Za-z0-9][A-Za-z0-9._:/=-]*)*$/i.test(script)) {
    return null
  }
  if (/(?:^| )--?watch(?: |$)/i.test(script)) return null
  return script
}

interface PackageManifest {
  name?: unknown
  workspaces?: unknown
  scripts?: { test?: unknown; typecheck?: unknown }
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
}

async function readPackageManifest(
  absolutePath: string,
  signal: AbortSignal | undefined,
): Promise<PackageManifest | null> {
  try {
    if ((await stat(absolutePath)).size > FOCUSED_VALIDATION_MAX_SINGLE_TEST_BYTES) return null
    return JSON.parse(await readFile(absolutePath, { encoding: 'utf8', signal })) as PackageManifest
  } catch {
    throwIfAborted(signal)
    return null
  }
}

async function readTargetableBunTestScript(
  projectRoot: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const packageJson = await readPackageManifest(join(projectRoot, 'package.json'), signal)
  return targetableBunTestScript(packageJson?.scripts?.test)
}

function workspacePatterns(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)
      ? (value as { packages: unknown[] }).packages
      : []
  return candidates
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.replace(/\\/g, '/').replace(/\/$/, ''))
    .filter(item => item.length > 0)
    .slice(0, FOCUSED_VALIDATION_MAX_WORKSPACE_PATTERNS)
}

function safeWorkspacePattern(value: string): boolean {
  if (value.includes('\0') || posix.isAbsolute(value) || win32.isAbsolute(value)) return false
  const segments = value.split('/')
  if (segments.includes('..') || segments.includes('.') || segments.includes('')) return false
  const wildcardCount = segments.filter(segment => segment === '*').length
  return wildcardCount <= 1 && segments.every(segment => segment === '*' || !/[?\[\]{}]/.test(segment))
}

interface WorkspacePatternExpansion {
  paths: string[]
  truncated: boolean
}

async function expandWorkspacePattern(
  projectRoot: string,
  pattern: string,
  signal: AbortSignal | undefined,
): Promise<WorkspacePatternExpansion> {
  if (!safeWorkspacePattern(pattern)) return { paths: [], truncated: false }
  const segments = pattern.split('/')
  const wildcardIndex = segments.indexOf('*')
  if (wildcardIndex < 0) return { paths: [pattern], truncated: false }
  if (wildcardIndex !== segments.length - 1) return { paths: [], truncated: false }
  const basePath = segments.slice(0, -1).join('/')
  const absoluteBase = join(projectRoot, ...basePath.split('/'))
  try {
    const directory = await opendir(absoluteBase)
    const paths: string[] = []
    let truncated = false
    for await (const entry of directory) {
      throwIfAborted(signal)
      if (!entry.isDirectory()) continue
      if (paths.length >= FOCUSED_VALIDATION_MAX_WORKSPACE_PACKAGES) {
        truncated = true
        break
      }
      paths.push(`${basePath}/${entry.name}`)
    }
    return { paths: paths.sort(comparePaths), truncated }
  } catch {
    throwIfAborted(signal)
    return { paths: [], truncated: false }
  }
}

function targetableTypecheckScript(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const script = value.trim().replace(/\s+/g, ' ')
  return /^tsc(?:\.cmd|\.exe)? --noEmit(?: --(?:pretty false|incremental false|skipLibCheck))?$/i.test(script)
}

interface WorkspacePackage {
  name: string
  path: string
  hasTargetableTypecheck: boolean
  workspaceDependencies: string[]
}

interface WorkspacePackageDiscovery {
  packages: WorkspacePackage[]
  truncated: boolean
}

async function discoverWorkspacePackages(
  projectRoot: string,
  signal: AbortSignal | undefined,
): Promise<WorkspacePackageDiscovery> {
  const rootManifest = await readPackageManifest(join(projectRoot, 'package.json'), signal)
  const patterns = workspacePatterns(rootManifest?.workspaces)
  if (patterns.length === 0) return { packages: [], truncated: false }
  const packagePaths = new Set<string>()
  let truncated = false
  for (const pattern of patterns) {
    throwIfAborted(signal)
    const expansion = await expandWorkspacePattern(projectRoot, pattern, signal)
    truncated ||= expansion.truncated
    for (const packagePath of expansion.paths) {
      if (packagePaths.size >= FOCUSED_VALIDATION_MAX_WORKSPACE_PACKAGES) {
        truncated = true
        break
      }
      packagePaths.add(packagePath)
    }
  }
  const packages: WorkspacePackage[] = []
  for (const packagePath of [...packagePaths].sort(comparePaths)) {
    throwIfAborted(signal)
    const absolutePackagePath = join(projectRoot, ...packagePath.split('/'))
    try {
      const pathStats = await lstat(absolutePackagePath)
      if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) continue
    } catch {
      throwIfAborted(signal)
      continue
    }
    const manifest = await readPackageManifest(join(absolutePackagePath, 'package.json'), signal)
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name.trim()) continue
    packages.push({
      name: manifest.name.trim(),
      path: packagePath,
      hasTargetableTypecheck: targetableTypecheckScript(manifest.scripts?.typecheck),
      workspaceDependencies: [],
    })
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }
    packages[packages.length - 1]!.workspaceDependencies = Object.entries(dependencies)
      .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
      .map(([name]) => name)
      .sort(comparePaths)
  }
  return { packages, truncated }
}

function directAffectedPackages(
  packages: readonly WorkspacePackage[],
  changedFiles: readonly string[],
): WorkspacePackage[] {
  return packages.filter(pkg => changedFiles.some(file => file === pkg.path || file.startsWith(`${pkg.path}/`)))
}

function affectedPackageClosure(
  packages: readonly WorkspacePackage[],
  directPackages: readonly WorkspacePackage[],
): Array<WorkspacePackage & { relation: 'direct' | 'dependent' }> {
  const directNames = new Set(directPackages.map(pkg => pkg.name))
  const affectedNames = new Set(directNames)
  let changed = true
  while (changed) {
    changed = false
    for (const pkg of packages) {
      if (affectedNames.has(pkg.name)) continue
      if (pkg.workspaceDependencies.some(name => affectedNames.has(name))) {
        affectedNames.add(pkg.name)
        changed = true
      }
    }
  }

  const remaining = packages.filter(pkg => affectedNames.has(pkg.name))
  const ordered: Array<WorkspacePackage & { relation: 'direct' | 'dependent' }> = []
  const emitted = new Set<string>()
  while (remaining.length > 0) {
    const ready = remaining.filter(pkg => pkg.workspaceDependencies.every(name => !affectedNames.has(name) || emitted.has(name)))
    const next = (ready.length > 0 ? ready : [remaining[0]!]).sort((left, right) => comparePaths(left.path, right.path))[0]!
    ordered.push({ ...next, relation: directNames.has(next.name) ? 'direct' : 'dependent' })
    emitted.add(next.name)
    remaining.splice(remaining.indexOf(next), 1)
  }
  return ordered
}

export async function planFocusedValidation(input: FocusedValidationPlanInput): Promise<FocusedValidationPlan> {
  throwIfAborted(input.signal)
  const changedFiles = input.changedFiles.map(normalizeChangedFile)
  const rootScopeChange = changedFiles.some(path => ROOT_SCOPE_FILES.has(path))
  const workspaceDiscovery = await discoverWorkspacePackages(input.projectRoot, input.signal)
  const workspacePlanningBlocked = rootScopeChange || workspaceDiscovery.truncated
  const directPackages = workspacePlanningBlocked
    ? []
    : directAffectedPackages(workspaceDiscovery.packages, changedFiles)
  const packageClosure = affectedPackageClosure(workspaceDiscovery.packages, directPackages)
  const targetablePackages = packageClosure.filter(pkg => pkg.hasTargetableTypecheck && isCrossShellSafePath(pkg.path))
  const selectedTypecheckPackages = targetablePackages.slice(0, FOCUSED_VALIDATION_MAX_TYPECHECK_COMMANDS)
  const affectedPackages: FocusedValidationPackage[] = packageClosure.map(pkg => ({
    name: pkg.name,
    path: pkg.path,
    relation: pkg.relation,
  }))
  const typecheckCommands = selectedTypecheckPackages.map(pkg => `bun run --cwd ${quoteCommandArgument(pkg.path)} typecheck`)
  const omittedTypecheckCount = packageClosure.length - typecheckCommands.length
  const selected = await existingChangedTests(input.projectRoot, changedFiles, input.signal)
  for (const changedFile of changedFiles) {
    selected.push(...await existingSiblingTests(input.projectRoot, changedFile, input.signal))
  }
  const directSelections = new Set(selected)
  const directImportSelection = await directImportTests(
    input.projectRoot,
    changedFiles.filter(path => !TEST_FILE_PATTERN.test(path)),
    input.signal,
  )
  selected.push(...directImportSelection.testFiles)
  const matchingTests = [...new Set(selected)].sort(comparePaths)
  const countCappedTests = matchingTests.slice(0, FOCUSED_VALIDATION_MAX_TEST_FILES)
  const testScript = await readTargetableBunTestScript(input.projectRoot, input.signal)
  const testFiles: string[] = []
  let command: string | null = null
  let unsafePathOmitted = 0
  let commandLengthCapped = false
  if (testScript) {
    for (const testFile of countCappedTests) {
      if (!isCrossShellSafePath(testFile)) {
        unsafePathOmitted += 1
        continue
      }
      const nextFiles = [...testFiles, testFile]
      const candidate = `${testScript} ${nextFiles.map(quoteCommandArgument).join(' ')}`
      if (candidate.length > FOCUSED_VALIDATION_MAX_COMMAND_LENGTH) {
        commandLengthCapped = true
        break
      }
      testFiles.push(testFile)
      command = candidate
    }
  } else {
    testFiles.push(...countCappedTests)
  }
  const omittedTestCount = matchingTests.length - testFiles.length
  const reasons = [
    ...(testFiles.length > 0 ? ['matching-tests'] : []),
    ...(matchingTests.length > FOCUSED_VALIDATION_MAX_TEST_FILES ? ['test-count-cap'] : []),
    ...(unsafePathOmitted > 0 ? ['unsafe-test-path'] : []),
    ...(commandLengthCapped ? ['command-length-cap'] : []),
    ...(directImportSelection.truncated ? ['test-scan-cap'] : []),
    ...(!testScript && matchingTests.length > 0 ? ['non-targetable-test-script'] : []),
    ...(matchingTests.length === 0 ? ['no-matching-tests'] : []),
    ...(affectedPackages.length > 0 ? ['affected-packages'] : []),
    ...(typecheckCommands.length > 0 ? ['package-typecheck'] : []),
    ...(affectedPackages.some(pkg => !typecheckCommands.some(command => command.includes(`\"${pkg.path}\"`))) ? ['non-targetable-typecheck-script'] : []),
    ...(targetablePackages.length > FOCUSED_VALIDATION_MAX_TYPECHECK_COMMANDS ? ['typecheck-count-cap'] : []),
    ...(rootScopeChange ? ['root-scope-change'] : []),
    ...(workspaceDiscovery.truncated ? ['workspace-scan-cap'] : []),
  ]
  const testConfidence = command ? (testFiles.some(path => directSelections.has(path)) ? 'high' : 'medium') : 'none'
  const typecheckConfidence = typecheckCommands.length === 0
    ? 'none'
    : omittedTypecheckCount === 0
      ? 'high'
      : 'medium'
  const confidence = testConfidence === 'high' || typecheckConfidence === 'high'
    ? 'high'
    : testConfidence === 'medium' || typecheckConfidence === 'medium'
      ? 'medium'
      : 'none'
  return {
    confidence,
    testFiles,
    command,
    omittedTestCount,
    affectedPackages,
    typecheckCommands,
    omittedTypecheckCount,
    reasons,
  }
}
