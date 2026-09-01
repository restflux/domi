/**
 * Skill 触发观测记录器
 *
 * 监听 Agent 工具流中的 Read 调用，当读取路径命中已注册技能根目录时，
 * 记录一次"Skill 触发"事件：
 * - 会话级明细：追加写入 agent-sessions/{id}.skill-triggers.jsonl
 * - 工作区级聚合：更新 agent-workspaces/{slug}/skill-usage.json（可重建缓存）
 *
 * 隐私边界：只匹配技能根目录内的路径，其余路径一律丢弃不记录。
 * 可靠性：所有 IO 均为 best-effort，失败静默降级，绝不向 Agent 循环抛错。
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SkillTriggerEvent, SkillTriggerSource, SkillUsageStats } from '@domi/shared'
import { getWorkspaceSkillsDir } from './config-paths'
import { getEffectiveWorkspaceSkills } from './agent-workspace-manager'

/** 已注册的技能根目录条目。 */
export interface SkillTriggerRoot {
  /** 技能根目录绝对路径（工作区 skills/ 或外部全局 skills 目录） */
  root: string
  /** 来源标识 */
  source: SkillTriggerSource
}

/**
 * 构建某工作区的技能触发检测根目录：
 * - 工作区 skills/ 目录（source=workspace，同名优先）
 * - 各外部全局技能的源目录（source=global）
 */
export function buildWorkspaceSkillTriggerRoots(workspaceSlug: string): SkillTriggerRoot[] {
  const roots: SkillTriggerRoot[] = [
    { root: getWorkspaceSkillsDir(workspaceSlug), source: 'workspace' },
  ]
  for (const skill of getEffectiveWorkspaceSkills(workspaceSlug)) {
    if (skill.origin && skill.sourcePath) {
      roots.push({ root: skill.sourcePath, source: 'global' })
    }
  }
  return roots
}

/** 构建 slug → 显示名 映射，用于事件中回填 skillName。 */
export function buildWorkspaceSkillNames(workspaceSlug: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const skill of getEffectiveWorkspaceSkills(workspaceSlug)) {
    names.set(skill.slug, skill.name)
  }
  return names
}

/** 路径匹配结果。 */
export interface SkillTriggerMatch {
  slug: string
  source: SkillTriggerSource
}

/** 可注入的文件 IO 依赖（测试用）。 */
export interface SkillTriggerRecorderDeps {
  appendFileSync: (path: string, data: string) => void
  readFileSync: (path: string) => string
  writeFileSync: (path: string, data: string) => void
  existsSync: (path: string) => boolean
}

const DEFAULT_DEPS: SkillTriggerRecorderDeps = {
  appendFileSync: (path, data) => appendFileSync(path, data, 'utf-8'),
  readFileSync: (path) => readFileSync(path, 'utf-8'),
  writeFileSync: (path, data) => writeFileSync(path, data, 'utf-8'),
  existsSync,
}

/**
 * 判断一次 Read 路径是否命中某个技能根目录。
 *
 * 规则：
 * - 路径与根目录做 resolve 后比较（Windows 大小写不敏感归一化）；
 * - 必须严格位于根目录之下（等于根目录本身不算）；
 * - slug 取根目录之后的第一个路径段（技能目录名）；
 * - 技能目录内任意文件（SKILL.md / 资源脚本）都视为触发。
 */
export function detectSkillTrigger(
  readPath: string,
  skillRoots: readonly SkillTriggerRoot[],
): SkillTriggerMatch | null {
  if (!readPath) return null
  const normalizedPath = normalizePath(resolve(readPath))
  for (const { root, source } of skillRoots) {
    const normalizedRoot = normalizePath(resolve(root))
    if (normalizedPath === normalizedRoot) continue
    if (!normalizedPath.startsWith(`${normalizedRoot}${sep}`)) continue
    const rel = relative(normalizedRoot, normalizedPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    const slug = rel.split(sep)[0]
    if (!slug) continue
    return { slug, source }
  }
  return null
}

/** Windows 下路径比较统一小写，避免大小写差异漏判。 */
function normalizePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

interface SkillTriggerRecorderOptions {
  sessionId: string
  workspaceSlug: string
  skillRoots: readonly SkillTriggerRoot[]
  /** slug → 显示名 的可选映射，缺失时回退为 slug 本身 */
  skillNames?: ReadonlyMap<string, string>
  sessionTriggersPath: string
  workspaceUsagePath: string
  now?: () => number
  deps?: SkillTriggerRecorderDeps
}

export interface SkillTriggerRecorder {
  /**
   * 处理一次 Read 调用。命中技能根目录时记录并返回事件，否则返回 null。
   * 同一 toolCallId 只记录一次。
   */
  record(readPath: string, toolCallId: string): SkillTriggerEvent | null
}

export function createSkillTriggerRecorder(options: SkillTriggerRecorderOptions): SkillTriggerRecorder {
  const now = options.now ?? Date.now
  const deps = options.deps ?? DEFAULT_DEPS
  const seenToolCallIds = new Set<string>()

  return {
    record(readPath: string, toolCallId: string): SkillTriggerEvent | null {
      const match = detectSkillTrigger(readPath, options.skillRoots)
      if (!match) return null
      if (seenToolCallIds.has(toolCallId)) return null
      seenToolCallIds.add(toolCallId)

      const event: SkillTriggerEvent = {
        sessionId: options.sessionId,
        skillSlug: match.slug,
        skillName: options.skillNames?.get(match.slug) ?? match.slug,
        source: match.source,
        filePath: toPosixRelative(readPath, match, options.skillRoots),
        toolCallId,
        timestamp: now(),
      }

      appendDetail(deps, options.sessionTriggersPath, event)
      updateUsage(deps, options.workspaceUsagePath, event)
      return event
    },
  }
}

/** 计算相对技能根目录的 POSIX 展示路径（如 tdd/SKILL.md）。 */
function toPosixRelative(
  readPath: string,
  match: SkillTriggerMatch,
  skillRoots: readonly SkillTriggerRoot[],
): string {
  const resolved = resolve(readPath)
  for (const { root, source } of skillRoots) {
    if (source !== match.source) continue
    const rel = relative(resolve(root), resolved)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    if (rel.split(sep)[0] !== match.slug) continue
    return rel.split(sep).join('/')
  }
  return `${match.slug}/SKILL.md`
}

function appendDetail(deps: SkillTriggerRecorderDeps, path: string, event: SkillTriggerEvent): void {
  try {
    deps.appendFileSync(path, `${JSON.stringify(event)}\n`)
  } catch {
    // best-effort：明细写入失败不影响 Agent 主循环
  }
}

function updateUsage(deps: SkillTriggerRecorderDeps, path: string, event: SkillTriggerEvent): void {
  try {
    const stats = readUsageStats(deps, path)
    const key = `${event.source}:${event.skillSlug}`
    const existing = stats.get(key)
    stats.set(key, {
      skillSlug: event.skillSlug,
      skillName: event.skillName,
      source: event.source,
      triggerCount: (existing?.triggerCount ?? 0) + 1,
      lastTriggeredAt: event.timestamp,
    })
    deps.writeFileSync(path, JSON.stringify({ skills: Object.fromEntries(stats) }, null, 2))
  } catch {
    // best-effort：聚合更新失败不影响 Agent 主循环
  }
}

/** 读取并解析工作区聚合文件；损坏或缺失时返回空表。 */
export function readWorkspaceSkillUsage(path: string): SkillUsageStats[] {
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { skills?: Record<string, SkillUsageStats> }
    const entries = parsed.skills ? Object.values(parsed.skills) : []
    return entries.sort((a, b) => (b?.triggerCount ?? 0) - (a?.triggerCount ?? 0))
  } catch {
    return []
  }
}

/** 读取会话级触发明细；容忍坏行与缺失文件。 */
export function readSessionSkillTriggers(path: string): SkillTriggerEvent[] {
  try {
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').split('\n')
    const events: SkillTriggerEvent[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as SkillTriggerEvent)
      } catch {
        // 跳过坏行
      }
    }
    return events
  } catch {
    return []
  }
}

function readUsageStats(deps: SkillTriggerRecorderDeps, path: string): Map<string, SkillUsageStats> {
  const stats = new Map<string, SkillUsageStats>()
  try {
    if (!deps.existsSync(path)) return stats
    const parsed = JSON.parse(deps.readFileSync(path)) as { skills?: Record<string, SkillUsageStats> }
    if (parsed.skills) {
      for (const [key, value] of Object.entries(parsed.skills)) {
        stats.set(key, value)
      }
    }
  } catch {
    // 损坏文件视为空表
  }
  return stats
}
