import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { renameWithRetry } from './fs-retry'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'

export const DEFAULT_SKILL_SOURCE_FILE = '.domi-default-skill.json'
export const DEFAULT_SKILLS_MANIFEST_FILE = '.domi-default-skills.json'
export const WORKSPACE_DEFAULT_SKILLS_STATE_FILE = '.domi-default-skills-state.json'

const DEFAULT_SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
  DEFAULT_SKILL_SOURCE_FILE,
])

export interface DefaultSkillSourceMetadata {
  schemaVersion: 1
  source: 'domi-builtin'
  slug: string
  version: string
  baselineHash: string
}

export interface DefaultSkillManifestEntry {
  version: string
  currentHash: string
  knownBaselineHashes: string[]
}

export interface DefaultSkillsManifest {
  schemaVersion: 1
  skills: Record<string, DefaultSkillManifestEntry>
}

export interface WorkspaceDefaultSkillsState {
  schemaVersion: 1
  seenSlugs: string[]
}

export function defaultSkillCopyFilter(src: string): boolean {
  return !DEFAULT_SKILL_COPY_BLOCKLIST.has(basename(src))
}

function normalizeSkillFileForHash(content: Buffer): Buffer {
  if (content.includes(0)) return content
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    return Buffer.from(text.replaceAll('\r\n', '\n'), 'utf-8')
  } catch {
    return content
  }
}

function hashDirectoryEntries(
  root: string,
  current: string,
  hash: ReturnType<typeof createHash>,
  normalizeTextLineEndings: boolean,
): void {
  const entries = readdirSync(current, { withFileTypes: true })
    .filter((entry) => defaultSkillCopyFilter(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const absolutePath = join(current, entry.name)
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\n`)
      hashDirectoryEntries(root, absolutePath, hash, normalizeTextLineEndings)
    } else if (entry.isFile()) {
      hash.update(`file:${relativePath}\n`)
      const content = readFileSync(absolutePath)
      hash.update(normalizeTextLineEndings ? normalizeSkillFileForHash(content) : content)
      hash.update('\n')
    }
  }
}

/** 计算用户可编辑 Skill 内容的稳定 hash；生命周期 sidecar 与复制 blocklist 不参与。 */
function computeSkillDirectoryHashWithMode(skillDir: string, normalizeTextLineEndings: boolean): string {
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return ''
  const hash = createHash('sha256')
  hashDirectoryEntries(skillDir, skillDir, hash, normalizeTextLineEndings)
  return hash.digest('hex')
}

/** 跨平台稳定 hash：UTF-8 文本先把 CRLF 规范化为 LF，二进制内容保持原字节。 */
export function computeSkillDirectoryHash(skillDir: string): string {
  return computeSkillDirectoryHashWithMode(skillDir, true)
}

/** 兼容旧 manifest / sidecar 在 Windows checkout 上记录的原始字节 hash。 */
function computeLegacySkillDirectoryHash(skillDir: string): string {
  return computeSkillDirectoryHashWithMode(skillDir, false)
}

export function readDefaultSkillSourceMetadata(skillDir: string): DefaultSkillSourceMetadata | undefined {
  const data = readJsonFileSafe<DefaultSkillSourceMetadata>(join(skillDir, DEFAULT_SKILL_SOURCE_FILE))
  if (
    data?.schemaVersion !== 1
    || data.source !== 'domi-builtin'
    || typeof data.slug !== 'string'
    || typeof data.version !== 'string'
    || typeof data.baselineHash !== 'string'
  ) return undefined
  return data
}

export function writeDefaultSkillSourceMetadata(
  skillDir: string,
  metadata: Omit<DefaultSkillSourceMetadata, 'schemaVersion' | 'source'>,
): void {
  writeJsonFileAtomic(join(skillDir, DEFAULT_SKILL_SOURCE_FILE), {
    schemaVersion: 1,
    source: 'domi-builtin',
    ...metadata,
  } satisfies DefaultSkillSourceMetadata)
}

export function readDefaultSkillsManifest(defaultSkillsDir: string): DefaultSkillsManifest {
  const data = readJsonFileSafe<DefaultSkillsManifest>(join(defaultSkillsDir, DEFAULT_SKILLS_MANIFEST_FILE))
  if (data?.schemaVersion === 1 && data.skills && typeof data.skills === 'object') return data
  return { schemaVersion: 1, skills: {} }
}

export function writeDefaultSkillsManifest(defaultSkillsDir: string, manifest: DefaultSkillsManifest): void {
  if (!existsSync(defaultSkillsDir)) mkdirSync(defaultSkillsDir, { recursive: true })
  writeJsonFileAtomic(join(defaultSkillsDir, DEFAULT_SKILLS_MANIFEST_FILE), manifest)
}

export function recordDefaultSkillBaseline(
  manifest: DefaultSkillsManifest,
  slug: string,
  version: string,
  baselineHash: string,
): void {
  const previous = manifest.skills[slug]
  const known = new Set(previous?.knownBaselineHashes ?? [])
  if (previous?.currentHash) known.add(previous.currentHash)
  if (baselineHash) known.add(baselineHash)
  manifest.skills[slug] = {
    version,
    currentHash: baselineHash,
    knownBaselineHashes: [...known].sort(),
  }
}

export function isUnmodifiedDefaultSkill(
  skillDir: string,
  knownBaselineHashes: readonly string[] = [],
): boolean {
  const currentHash = computeSkillDirectoryHash(skillDir)
  if (!currentHash) return false
  const legacyCurrentHash = computeLegacySkillDirectoryHash(skillDir)
  const metadata = readDefaultSkillSourceMetadata(skillDir)
  if (metadata) {
    const contentMatchesRecordedBaseline = metadata.baselineHash === currentHash
      || metadata.baselineHash === legacyCurrentHash
    return contentMatchesRecordedBaseline
      && (knownBaselineHashes.length === 0
        || knownBaselineHashes.includes(metadata.baselineHash)
        || knownBaselineHashes.includes(currentHash)
        || knownBaselineHashes.includes(legacyCurrentHash))
  }
  return knownBaselineHashes.includes(currentHash) || knownBaselineHashes.includes(legacyCurrentHash)
}

export function readWorkspaceDefaultSkillsState(workspaceDir: string): WorkspaceDefaultSkillsState | undefined {
  const data = readJsonFileSafe<WorkspaceDefaultSkillsState>(join(workspaceDir, WORKSPACE_DEFAULT_SKILLS_STATE_FILE))
  if (data?.schemaVersion !== 1 || !Array.isArray(data.seenSlugs)) return undefined
  return {
    schemaVersion: 1,
    seenSlugs: data.seenSlugs.filter((slug): slug is string => typeof slug === 'string'),
  }
}

export function writeWorkspaceDefaultSkillsState(workspaceDir: string, seenSlugs: Iterable<string>): void {
  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true })
  writeJsonFileAtomic(join(workspaceDir, WORKSPACE_DEFAULT_SKILLS_STATE_FILE), {
    schemaVersion: 1,
    seenSlugs: [...new Set(seenSlugs)].sort(),
  } satisfies WorkspaceDefaultSkillsState)
}

/**
 * 先完整复制到同级临时目录，再通过 backup swap 替换目标。
 * 任一复制/rename 步骤失败时尽力恢复旧目录，避免“先删后拷”丢失用户数据。
 */
export function replaceManagedSkillDirectory(
  sourcePath: string,
  targetPath: string,
  metadata: Omit<DefaultSkillSourceMetadata, 'schemaVersion' | 'source'>,
): boolean {
  const parent = dirname(targetPath)
  const suffix = randomUUID()
  const tempPath = join(parent, `.${basename(targetPath)}.domi-update-${suffix}`)
  const backupPath = join(parent, `.${basename(targetPath)}.domi-backup-${suffix}`)
  let movedOriginal = false

  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    cpSync(sourcePath, tempPath, { recursive: true, filter: defaultSkillCopyFilter })
    writeDefaultSkillSourceMetadata(tempPath, metadata)

    if (existsSync(targetPath)) {
      renameWithRetry(targetPath, backupPath)
      movedOriginal = true
    }
    renameWithRetry(tempPath, targetPath)
    if (movedOriginal && existsSync(backupPath)) rmSync(backupPath, { recursive: true, force: true })
    return true
  } catch (error) {
    console.warn(`[默认 Skill 生命周期] 安全替换失败 (${targetPath}):`, error)
    try {
      if (!existsSync(targetPath) && movedOriginal && existsSync(backupPath)) {
        renameWithRetry(backupPath, targetPath)
      }
    } catch (restoreError) {
      console.warn(`[默认 Skill 生命周期] 恢复旧目录失败 (${targetPath}):`, restoreError)
    }
    return false
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { recursive: true, force: true })
    if (existsSync(backupPath) && existsSync(targetPath)) rmSync(backupPath, { recursive: true, force: true })
  }
}

export function copyManagedSkillDirectory(
  sourcePath: string,
  targetPath: string,
  metadata: Omit<DefaultSkillSourceMetadata, 'schemaVersion' | 'source'>,
): void {
  if (!existsSync(dirname(targetPath))) mkdirSync(dirname(targetPath), { recursive: true })
  cpSync(sourcePath, targetPath, { recursive: true, filter: defaultSkillCopyFilter })
  writeDefaultSkillSourceMetadata(targetPath, metadata)
}
