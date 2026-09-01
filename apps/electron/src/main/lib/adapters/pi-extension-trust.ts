import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

const STORE_VERSION = 1
const SUPPORTED_FILE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs'])

export interface ExtensionCandidate {
  projectRoot: string
  path: string
}

export interface TrustedExtensionPath {
  extensionId: string
  path: string
}

export type ExtensionCandidateKind = 'file' | 'directory'
export type ExtensionTrustStatus = 'valid' | 'stale' | 'missing' | 'invalid'

export interface ExtensionInspection {
  projectRoot: string
  path: string
  digest: string
  kind: ExtensionCandidateKind
}

export interface TrustedExtension extends TrustedExtensionPath {
  digest: string
  kind: ExtensionCandidateKind
  approvedAt: string
  status: 'valid'
}

export interface ListedExtensionTrust extends TrustedExtensionPath {
  digest: string
  approvedAt: string
  status: ExtensionTrustStatus
}

export interface ExtensionTrustStore {
  resolveTrustedPaths(projectRoot: string): TrustedExtensionPath[]
  inspect(candidate: ExtensionCandidate): ExtensionInspection
  list(projectRoot: string): ListedExtensionTrust[]
  approve(candidate: ExtensionCandidate, expected?: ExtensionInspection): TrustedExtension
  revoke(projectRoot: string, extensionId: string): void
}

interface StoredExtensionTrust {
  extensionId: string
  projectRoot: string
  canonicalPath: string
  digest: string
  approvedAt: string
}

interface ExtensionTrustFile {
  version: typeof STORE_VERSION
  extensions: StoredExtensionTrust[]
}

interface LoadedStore {
  status: 'absent' | 'valid' | 'corrupt'
  value: ExtensionTrustFile
}

function emptyStore(): ExtensionTrustFile {
  return { version: STORE_VERSION, extensions: [] }
}

function stablePathKey(path: string): string {
  const normalized = path.split(sep).join('/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function canonicalizeExistingDirectory(path: string, label: string): string {
  const absolutePath = resolve(path)
  accessSync(absolutePath, constants.R_OK)
  const canonicalPath = realpathSync(absolutePath)
  if (!statSync(canonicalPath).isDirectory()) throw new Error(`${label}必须是可读目录`)
  return canonicalPath
}

function canonicalizeExtensionPath(path: string): string {
  const absolutePath = resolve(path)
  accessSync(absolutePath, constants.R_OK)
  const canonicalPath = realpathSync(absolutePath)
  const stat = statSync(canonicalPath)
  if (stat.isFile()) {
    if (!SUPPORTED_FILE_EXTENSIONS.has(extname(canonicalPath).toLowerCase())) {
      throw new Error('Pi Extension 仅支持 .ts/.js/.mjs/.cjs 文件')
    }
    return canonicalPath
  }
  if (!stat.isDirectory()) throw new Error('Pi Extension 候选必须是文件或目录')
  if (!existsSync(join(canonicalPath, 'index.ts')) && !existsSync(join(canonicalPath, 'index.js'))) {
    throw new Error('Pi Extension 目录必须包含 index.ts 或 index.js')
  }
  return canonicalPath
}

interface DirectoryEntrySnapshot {
  relativePath: string
  type: 'directory' | 'file'
  size: number
  mtimeMs: number
}

function collectDirectoryEntries(root: string): DirectoryEntrySnapshot[] {
  const entries: DirectoryEntrySnapshot[] = []
  const visit = (directory: string): void => {
    accessSync(directory, constants.R_OK)
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, dirent.name)
      const stat = lstatSync(path)
      const relativePath = relative(root, path).split(sep).join('/')
      if (stat.isSymbolicLink()) {
        throw new Error(`Pi Extension 目录不允许 symlink: ${relativePath}`)
      }
      if (stat.isDirectory()) {
        entries.push({ relativePath, type: 'directory', size: 0, mtimeMs: stat.mtimeMs })
        visit(path)
        continue
      }
      if (!stat.isFile()) throw new Error(`Pi Extension 目录包含不支持的文件类型: ${relativePath}`)
      accessSync(path, constants.R_OK)
      entries.push({ relativePath, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  visit(root)
  entries.sort((left, right) => {
    const leftKey = stablePathKey(left.relativePath)
    const rightKey = stablePathKey(right.relativePath)
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
    return left.relativePath < right.relativePath ? -1 : left.relativePath === right.relativePath ? 0 : 1
  })
  return entries
}

function sameDirectorySnapshot(left: DirectoryEntrySnapshot[], right: DirectoryEntrySnapshot[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return other !== undefined
      && entry.relativePath === other.relativePath
      && entry.type === other.type
      && entry.size === other.size
      && entry.mtimeMs === other.mtimeMs
  })
}

function isBareModuleSpecifier(specifier: string): boolean {
  if (/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(specifier)) return false
  if (specifier.startsWith('node:')) return /^node:[A-Za-z0-9_./-]+$/.test(specifier)
  return /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(specifier)
}

function assertAllowedFileModuleSpecifier(specifier: string): void {
  if (!isBareModuleSpecifier(specifier)) {
    throw new Error('单文件 Pi Extension 只能导入 bare package；相对、绝对或无法确认的源码导入必须改用目录候选')
  }
}

function assertSelfContainedFileExtension(content: Buffer): void {
  const source = content.toString('utf8')
  if (source.includes('\uFFFD')) {
    throw new Error('单文件 Pi Extension 源码编码无法可靠检查')
  }

  const staticSpecifierPatterns = [
    /\bfrom(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*(['"])([^'"\r\n]*)\1/g,
    /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*(['"])([^'"\r\n]*)\1/g,
  ]
  for (const pattern of staticSpecifierPatterns) {
    for (const match of source.matchAll(pattern)) assertAllowedFileModuleSpecifier(match[2] ?? '')
  }

  const dynamicImportPattern = /\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(\s*([^\r\n)]*)\)/g
  for (const match of source.matchAll(dynamicImportPattern)) {
    const argument = (match[1] ?? '').trim()
    const quote = argument[0]
    if ((quote !== "'" && quote !== '"') || argument.at(-1) !== quote) {
      throw new Error('单文件 Pi Extension 的 import()/require() 参数无法静态确认')
    }
    const specifier = argument.slice(1, -1)
    if (specifier.includes('\\')) {
      throw new Error('单文件 Pi Extension 的 import()/require() 参数无法静态确认')
    }
    assertAllowedFileModuleSpecifier(specifier)
  }
}

function updateFramedHash(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.byteLength))
  hash.update(length).update(bytes)
}

function digestExtensionPath(path: string): string {
  const rootStat = statSync(path)
  const hash = createHash('sha256')
  if (rootStat.isFile()) {
    const before = rootStat
    const content = readFileSync(path)
    assertSelfContainedFileExtension(content)
    const after = statSync(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || !after.isFile()) {
      throw new Error('Pi Extension 摘要计算期间发生变化')
    }
    updateFramedHash(hash, 'file')
    updateFramedHash(hash, content)
    return `sha256:${hash.digest('hex')}`
  }

  const before = collectDirectoryEntries(path)
  updateFramedHash(hash, 'directory')
  for (const entry of before) {
    updateFramedHash(hash, entry.type)
    updateFramedHash(hash, entry.relativePath)
    if (entry.type === 'file') updateFramedHash(hash, readFileSync(join(path, entry.relativePath)))
  }
  const after = collectDirectoryEntries(path)
  if (!sameDirectorySnapshot(before, after)) throw new Error('Pi Extension 摘要计算期间发生变化')
  return `sha256:${hash.digest('hex')}`
}

function inspectCandidate(candidate: ExtensionCandidate): ExtensionInspection {
  const projectRoot = canonicalizeExistingDirectory(candidate.projectRoot, '项目根目录')
  const path = canonicalizeExtensionPath(candidate.path)
  const kind = statSync(path).isFile() ? 'file' : 'directory'
  return { projectRoot, path, digest: digestExtensionPath(path), kind }
}

function createExtensionId(projectRoot: string, canonicalPath: string): string {
  return createHash('sha256')
    .update(`${stablePathKey(projectRoot)}\0${stablePathKey(canonicalPath)}`)
    .digest('hex')
}

function isStoredExtensionTrust(value: unknown): value is StoredExtensionTrust {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.extensionId === 'string'
    && typeof record.projectRoot === 'string'
    && typeof record.canonicalPath === 'string'
    && typeof record.digest === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(record.digest)
    && typeof record.approvedAt === 'string'
}

function parseStore(raw: string): ExtensionTrustFile | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    if (record.version !== STORE_VERSION || !Array.isArray(record.extensions)) return undefined
    if (!record.extensions.every(isStoredExtensionTrust)) return undefined
    return { version: STORE_VERSION, extensions: record.extensions }
  } catch {
    return undefined
  }
}

export class FileExtensionTrustStore implements ExtensionTrustStore {
  constructor(private readonly storePath: string) {}

  resolveTrustedPaths(projectRoot: string): TrustedExtensionPath[] {
    let canonicalProjectRoot: string
    try {
      canonicalProjectRoot = canonicalizeExistingDirectory(projectRoot, '项目根目录')
    } catch {
      return []
    }

    const loaded = this.readStore()
    if (loaded.status !== 'valid') return []

    const trusted: TrustedExtensionPath[] = []
    for (const entry of loaded.value.extensions) {
      if (stablePathKey(entry.projectRoot) !== stablePathKey(canonicalProjectRoot)) continue
      try {
        const canonicalPath = canonicalizeExtensionPath(entry.canonicalPath)
        if (stablePathKey(canonicalPath) !== stablePathKey(entry.canonicalPath)) continue
        if (digestExtensionPath(canonicalPath) !== entry.digest) continue
        trusted.push({ extensionId: entry.extensionId, path: canonicalPath })
      } catch {
        // 任意路径或摘要歧义都 fail closed，不把候选交给 ResourceLoader。
      }
    }
    return trusted
  }

  inspect(candidate: ExtensionCandidate): ExtensionInspection {
    return inspectCandidate(candidate)
  }

  list(projectRoot: string): ListedExtensionTrust[] {
    const canonicalProjectRoot = canonicalizeExistingDirectory(projectRoot, '项目根目录')
    const loaded = this.readStore()
    if (loaded.status === 'corrupt') throw new Error('Extension Trust 存储已损坏')
    if (loaded.status === 'absent') return []

    return loaded.value.extensions
      .filter((entry) => stablePathKey(entry.projectRoot) === stablePathKey(canonicalProjectRoot))
      .map((entry) => {
        let status: ExtensionTrustStatus = 'invalid'
        if (!existsSync(entry.canonicalPath)) {
          status = 'missing'
        } else {
          try {
            const canonicalPath = canonicalizeExtensionPath(entry.canonicalPath)
            if (stablePathKey(canonicalPath) === stablePathKey(entry.canonicalPath)) {
              status = digestExtensionPath(canonicalPath) === entry.digest ? 'valid' : 'stale'
            }
          } catch {
            status = 'invalid'
          }
        }
        return {
          extensionId: entry.extensionId,
          path: entry.canonicalPath,
          digest: entry.digest,
          approvedAt: entry.approvedAt,
          status,
        }
      })
  }

  approve(candidate: ExtensionCandidate, expected?: ExtensionInspection): TrustedExtension {
    const loaded = this.readStore()
    if (loaded.status === 'corrupt') throw new Error('Extension Trust 存储已损坏，拒绝覆盖')

    const inspected = inspectCandidate(candidate)
    if (expected && stablePathKey(inspected.projectRoot) !== stablePathKey(expected.projectRoot)) {
      throw new Error('候选不属于当前项目')
    }
    if (expected && (
      stablePathKey(inspected.path) !== stablePathKey(expected.path)
      || inspected.digest !== expected.digest
      || inspected.kind !== expected.kind
    )) {
      throw new Error('候选内容已变化，请重新选择')
    }

    const extensionId = createExtensionId(inspected.projectRoot, inspected.path)
    const approvedAt = new Date().toISOString()
    const entry: StoredExtensionTrust = {
      extensionId,
      projectRoot: inspected.projectRoot,
      canonicalPath: inspected.path,
      digest: inspected.digest,
      approvedAt,
    }
    const extensions = loaded.value.extensions.filter((item) => item.extensionId !== extensionId)
    extensions.push(entry)
    this.writeStore({ version: STORE_VERSION, extensions })
    return {
      extensionId,
      path: inspected.path,
      digest: inspected.digest,
      kind: inspected.kind,
      approvedAt,
      status: 'valid',
    }
  }

  revoke(projectRoot: string, extensionId: string): void {
    const canonicalProjectRoot = canonicalizeExistingDirectory(projectRoot, '项目根目录')
    const loaded = this.readStore()
    if (loaded.status === 'corrupt') throw new Error('Extension Trust 存储已损坏，拒绝修改')
    if (loaded.status === 'absent') return
    const extensions = loaded.value.extensions.filter((item) => (
      item.extensionId !== extensionId
      || stablePathKey(item.projectRoot) !== stablePathKey(canonicalProjectRoot)
    ))
    if (extensions.length !== loaded.value.extensions.length) {
      this.writeStore({ version: STORE_VERSION, extensions })
    }
  }

  private readStore(): LoadedStore {
    if (!existsSync(this.storePath)) return { status: 'absent', value: emptyStore() }
    try {
      const value = parseStore(readFileSync(this.storePath, 'utf8'))
      return value
        ? { status: 'valid', value }
        : { status: 'corrupt', value: emptyStore() }
    } catch {
      return { status: 'corrupt', value: emptyStore() }
    }
  }

  private writeStore(value: ExtensionTrustFile): void {
    mkdirSync(dirname(this.storePath), { recursive: true })
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, this.storePath)
  }
}
