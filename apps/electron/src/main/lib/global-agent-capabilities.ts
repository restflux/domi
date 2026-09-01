import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import {
  inferMcpTransportType,
  normalizeMcpTransportType,
} from '@domi/shared'
import type {
  GlobalAgentCapabilities,
  GlobalMcpServerSummary,
  GlobalSkillOrigin,
  McpServerEntry,
  SkillMeta,
  WorkspaceMcpConfig,
} from '@domi/shared'
import type { AppSettings } from '../../types'
import {
  resolveAgentSkillsGlobalDir,
  resolveClaudeGlobalSkillsDir,
  resolvePiGlobalMcpPath,
  resolvePiGlobalSkillsDir,
} from './global-capability-paths'
import { getSettings } from './settings-service'
import { isHostMaintainedTrustedMcpEndpoint } from './adapters/pi-mcp-trust.ts'

export interface GlobalCapabilityPaths {
  piSkillsDir: string
  agentsSkillsDir: string
  claudeSkillsDir: string
  piMcpPath: string
}

export interface GlobalSkillScanResult {
  skills: SkillMeta[]
  diagnostics: string[]
}

export interface PiGlobalMcpReadResult {
  config: WorkspaceMcpConfig
  servers: GlobalMcpServerSummary[]
  diagnostics: string[]
}

interface SkillSource {
  origin: GlobalSkillOrigin
  path: string
  label: string
}

interface ParsedFrontmatter {
  name?: string
  description?: string
  group?: string
  icon?: string
  version?: string
}

interface RawPiMcpConfig {
  imports?: unknown
  mcpServers?: unknown
}

const SKILL_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build'])
const MAX_SKILL_SCAN_DEPTH = 6
const MAX_SKILL_SCAN_ENTRIES = 4_000
const MAX_DISCOVERED_SKILLS = 500
const MAX_SKILL_FILE_BYTES = 1_048_576
const MAX_SKILL_SCAN_MS = 300
const MAX_EXTERNAL_MCP_TIMEOUT_SECONDS = 60

export function getGlobalCapabilityPaths(): GlobalCapabilityPaths {
  return {
    piSkillsDir: resolvePiGlobalSkillsDir(),
    agentsSkillsDir: resolveAgentSkillsGlobalDir(),
    claudeSkillsDir: resolveClaudeGlobalSkillsDir(),
    piMcpPath: resolvePiGlobalMcpPath(),
  }
}

function canonicalPath(path: string): string | null {
  try {
    const resolved = realpathSync.native(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return null
  }
}

function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)/)
  if (!match?.[1]) return {}

  const validKeys = new Set(['name', 'description', 'group', 'icon', 'version'])
  const values: Record<string, string> = {}
  let currentKey = ''
  let folded = false

  for (const line of match[1].split(/\r?\n/)) {
    if (!/^\s/.test(line)) {
      const separator = line.indexOf(':')
      if (separator < 0) {
        currentKey = ''
        continue
      }
      const key = line.slice(0, separator).trim()
      if (!validKeys.has(key)) {
        currentKey = ''
        continue
      }
      const rawValue = line.slice(separator + 1).trim()
      currentKey = key
      folded = rawValue === '>'
      values[key] = rawValue === '|' || rawValue === '>'
        ? ''
        : rawValue.replace(/^['"]|['"]$/g, '')
      continue
    }

    if (!currentKey) continue
    const text = line.trim()
    if (!text) continue
    const separator = values[currentKey] ? (folded ? ' ' : '\n') : ''
    values[currentKey] = `${values[currentKey]}${separator}${text}`
  }

  return values
}

function isCanonicalPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function discoverSkillFiles(root: string, sourceLabel: string): { files: string[]; diagnostics: string[] } {
  if (!existsSync(root)) return { files: [], diagnostics: [] }

  const canonicalRoot = canonicalPath(root)
  if (!canonicalRoot) return { files: [], diagnostics: [`${sourceLabel} 无法解析真实路径，已跳过`] }

  const files: string[] = []
  const diagnostics: string[] = []
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
  const visited = new Set<string>()
  const startedAt = Date.now()
  let visitedEntries = 0
  let outsideLinkCount = 0

  while (pending.length > 0) {
    if (Date.now() - startedAt > MAX_SKILL_SCAN_MS) {
      diagnostics.push(`${sourceLabel} 扫描超过 ${MAX_SKILL_SCAN_MS}ms，已提前停止`)
      break
    }
    if (visitedEntries >= MAX_SKILL_SCAN_ENTRIES || files.length >= MAX_DISCOVERED_SKILLS) {
      diagnostics.push(`${sourceLabel} 超过扫描上限，已提前停止`)
      break
    }

    const { directory, depth } = pending.shift()!
    const canonicalDirectory = canonicalPath(directory)
    if (!canonicalDirectory || visited.has(canonicalDirectory)) continue
    if (!isCanonicalPathWithinRoot(canonicalDirectory, canonicalRoot)) {
      outsideLinkCount += 1
      continue
    }
    visited.add(canonicalDirectory)

    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    visitedEntries += entries.length

    const skillMd = entries.find((entry) => entry.name === 'SKILL.md')
    if (skillMd) {
      const candidate = join(directory, skillMd.name)
      const canonicalFile = canonicalPath(candidate)
      if (!canonicalFile || !isCanonicalPathWithinRoot(canonicalFile, canonicalRoot)) {
        outsideLinkCount += 1
        continue
      }
      try {
        const stats = statSync(candidate)
        if (!stats.isFile()) continue
        if (stats.size > MAX_SKILL_FILE_BYTES) {
          diagnostics.push(`${sourceLabel} 中的 SKILL.md 超过 1 MiB，已跳过：${candidate}`)
          continue
        }
        files.push(candidate)
      } catch {
        // broken symlink / unreadable file
      }
      continue
    }

    if (depth >= MAX_SKILL_SCAN_DEPTH) continue
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKILL_SCAN_SKIP_DIRS.has(entry.name)) continue
      const candidate = join(directory, entry.name)
      try {
        if (!statSync(candidate).isDirectory()) continue
        const canonicalCandidate = canonicalPath(candidate)
        if (!canonicalCandidate || !isCanonicalPathWithinRoot(canonicalCandidate, canonicalRoot)) {
          outsideLinkCount += 1
          continue
        }
        pending.push({ directory: candidate, depth: depth + 1 })
      } catch {
        // broken symlink / unreadable directory
      }
    }
  }

  if (outsideLinkCount > 0) {
    diagnostics.push(`${sourceLabel} 已跳过 ${outsideLinkCount} 个指向来源目录外的链接`)
  }
  return { files, diagnostics }
}

function sourceDefinitions(paths: GlobalCapabilityPaths): SkillSource[] {
  return [
    { origin: 'pi-global', path: paths.piSkillsDir, label: 'Pi 全局 Skills' },
    { origin: 'agents-global', path: paths.agentsSkillsDir, label: 'Agent Skills 全局目录' },
    { origin: 'claude-global', path: paths.claudeSkillsDir, label: 'Claude 全局 Skills' },
  ]
}

export function scanGlobalSkills(paths = getGlobalCapabilityPaths()): GlobalSkillScanResult {
  const skills: SkillMeta[] = []
  const diagnostics: string[] = []
  const seenRealFiles = new Set<string>()
  const seenNames = new Map<string, SkillMeta>()
  const seenSlugs = new Map<string, SkillMeta>()

  for (const source of sourceDefinitions(paths)) {
    const discovery = discoverSkillFiles(source.path, source.label)
    diagnostics.push(...discovery.diagnostics)
    for (const skillFile of discovery.files) {
      const realFile = canonicalPath(skillFile)
      if (!realFile || seenRealFiles.has(realFile)) continue

      let content: string
      try {
        content = readFileSync(skillFile, 'utf-8')
      } catch {
        diagnostics.push(`${source.label} 中的 Skill 无法读取：${skillFile}`)
        continue
      }

      const frontmatter = parseSkillFrontmatter(content)
      const skillDir = dirname(skillFile)
      const slug = basename(skillDir)
      const name = frontmatter.name?.trim() || slug
      const description = frontmatter.description?.trim()
      if (!description) {
        diagnostics.push(`${source.label} 中的 ${slug} 缺少 description，已跳过`)
        continue
      }

      const previous = seenNames.get(name) ?? seenSlugs.get(slug)
      if (previous) {
        diagnostics.push(`全局 Skill 冲突：${slug} 已由更高优先级来源 ${previous.origin ?? 'workspace'} 提供，已跳过 ${source.label}`)
        seenRealFiles.add(realFile)
        continue
      }

      const skill: SkillMeta = {
        slug,
        name,
        description,
        enabled: true,
        origin: source.origin,
        readOnly: true,
        sourcePath: skillDir,
        ...(frontmatter.group?.trim() && { group: frontmatter.group.trim() }),
        ...(frontmatter.icon?.trim() && { icon: frontmatter.icon.trim() }),
        ...(frontmatter.version?.trim() && { version: frontmatter.version.trim() }),
      }
      skills.push(skill)
      seenRealFiles.add(realFile)
      seenNames.set(name, skill)
      seenSlugs.set(slug, skill)
    }
  }

  return { skills, diagnostics }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeExternalMcpEntry(name: string, raw: unknown, diagnostics: string[]): McpServerEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push(`Pi 全局 MCP「${name}」配置不是对象，已跳过`)
    return null
  }

  const record = raw as Record<string, unknown>
  const normalizedType = normalizeMcpTransportType(record.type)
  const inferredType = normalizedType ?? inferMcpTransportType(record)
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : true
  const trustReadOnlyAnnotations = record.trustReadOnlyAnnotations === true
    || record.trust_read_only_annotations === true
    || isHostMaintainedTrustedMcpEndpoint(record.url)

  if (inferredType === 'stdio') {
    if (typeof record.command !== 'string' || !record.command.trim()) {
      diagnostics.push(`Pi 全局 MCP「${name}」缺少 command，已跳过`)
      return null
    }
    const env = stringRecord(record.env ?? record.environment)
    const rawTimeout = typeof record.timeout === 'number' && Number.isFinite(record.timeout)
      ? record.timeout
      : undefined
    const timeout = rawTimeout === undefined
      ? undefined
      : Math.min(MAX_EXTERNAL_MCP_TIMEOUT_SECONDS, Math.max(1, rawTimeout))
    if (rawTimeout !== undefined && rawTimeout !== timeout) {
      diagnostics.push(`Pi 全局 MCP「${name}」的 timeout 已限制为 ${timeout} 秒`)
    }
    return {
      type: 'stdio',
      command: record.command,
      ...(Array.isArray(record.args) && record.args.every((arg) => typeof arg === 'string') && { args: record.args as string[] }),
      ...(env && { env }),
      ...(timeout !== undefined && { timeout }),
      ...(trustReadOnlyAnnotations && { trustReadOnlyAnnotations: true }),
      enabled,
    }
  }

  if ((inferredType === 'http' || inferredType === 'sse') && typeof record.url === 'string' && record.url.trim()) {
    return {
      type: inferredType,
      url: record.url,
      ...(stringRecord(record.headers) && { headers: stringRecord(record.headers) }),
      ...(trustReadOnlyAnnotations && { trustReadOnlyAnnotations: true }),
      enabled,
    }
  }

  diagnostics.push(`Pi 全局 MCP「${name}」缺少可用的 command 或 url，已跳过`)
  return null
}

function getMcpDisplayTarget(entry: McpServerEntry): string | undefined {
  if (entry.type === 'stdio' && entry.command) return basename(entry.command)
  if (!entry.url) return undefined
  try {
    const parsed = new URL(entry.url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return undefined
  }
}

export function readPiGlobalMcpConfig(path = resolvePiGlobalMcpPath()): PiGlobalMcpReadResult {
  const config: WorkspaceMcpConfig = { servers: {} }
  const servers: GlobalMcpServerSummary[] = []
  const diagnostics: string[] = []
  if (!existsSync(path)) return { config, servers, diagnostics }

  let parsed: RawPiMcpConfig
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as RawPiMcpConfig
  } catch {
    diagnostics.push(`Pi 全局 MCP 配置无法解析：${path}`)
    return { config, servers, diagnostics }
  }

  if (Array.isArray(parsed.imports) && parsed.imports.length > 0) {
    const names = parsed.imports.filter((entry): entry is string => typeof entry === 'string')
    diagnostics.push(`Pi 全局 MCP 的 imports 暂未跟随加载：${names.join('、') || '存在未识别来源'}`)
  }

  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
    return { config, servers, diagnostics }
  }

  for (const [name, rawEntry] of Object.entries(parsed.mcpServers)) {
    const entry = normalizeExternalMcpEntry(name, rawEntry, diagnostics)
    if (!entry) continue
    config.servers[name] = entry
    const displayTarget = getMcpDisplayTarget(entry)
    servers.push({
      name,
      type: entry.type,
      enabled: entry.enabled,
      ...(displayTarget && { displayTarget }),
      origin: 'pi-global',
      readOnly: true,
      sourcePath: path,
    })
  }

  return { config, servers, diagnostics }
}

export function mergeEffectiveSkills(
  workspaceSkills: SkillMeta[],
  globalSkills: SkillMeta[],
  globalEnabled: boolean,
): SkillMeta[] {
  if (!globalEnabled) return [...workspaceSkills]

  const shadowedNames = new Set(workspaceSkills.map((skill) => skill.name))
  const shadowedSlugs = new Set(workspaceSkills.map((skill) => skill.slug))
  return [
    ...workspaceSkills,
    ...globalSkills.filter((skill) => !shadowedNames.has(skill.name) && !shadowedSlugs.has(skill.slug)),
  ]
}

export function mergeEffectiveMcpConfig(
  globalConfig: WorkspaceMcpConfig,
  workspaceConfig: WorkspaceMcpConfig,
  globalEnabled: boolean,
): WorkspaceMcpConfig {
  return {
    servers: {
      ...(globalEnabled ? globalConfig.servers : {}),
      ...workspaceConfig.servers,
    },
  }
}

export function readGlobalAgentCapabilities(
  paths = getGlobalCapabilityPaths(),
  settings: Pick<AppSettings, 'externalGlobalSkillsEnabled' | 'piGlobalMcpEnabled'> = getSettings(),
): GlobalAgentCapabilities {
  const skillResult = scanGlobalSkills(paths)
  const mcpResult = readPiGlobalMcpConfig(paths.piMcpPath)
  return {
    skillsEnabled: settings.externalGlobalSkillsEnabled ?? false,
    mcpEnabled: settings.piGlobalMcpEnabled ?? false,
    detectedSkills: skillResult.skills,
    detectedMcpServers: mcpResult.servers,
    skillSourcePaths: sourceDefinitions(paths).map((source) => source.path),
    mcpSourcePath: paths.piMcpPath,
    diagnostics: [...skillResult.diagnostics, ...mcpResult.diagnostics],
  }
}

export function getGlobalAgentCapabilities(): GlobalAgentCapabilities {
  return readGlobalAgentCapabilities()
}
