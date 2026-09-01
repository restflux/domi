import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const INSTRUCTION_CANDIDATES = [
  { name: 'AGENTS.md', kind: 'agents' },
  { name: 'AGENTS.MD', kind: 'agents' },
  { name: 'CLAUDE.md', kind: 'claude' },
  { name: 'CLAUDE.MD', kind: 'claude' },
] as const

const MAX_PROJECT_INSTRUCTION_BYTES = 64 * 1024

export interface TrustedProjectInstructionSource {
  kind: 'agents' | 'claude'
  relativePath: string
  /** 已通过真实路径边界检查的绝对路径。 */
  absolutePath: string
  content: string
  contentHash: string
}

export interface TrustedProjectInstructionResult {
  projectRoot: string
  source?: TrustedProjectInstructionSource
  diagnostics: string[]
}

export interface TrustedWorkspaceInstructionSource {
  kind: 'agents' | 'claude'
  absolutePath: string
  content: string
  contentHash: string
}

export interface TrustedWorkspaceInstructionResult {
  source?: TrustedWorkspaceInstructionSource
  diagnostics: string[]
}

function comparisonPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(comparisonPath(root), comparisonPath(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  }
}

function readUtf8Instruction(path: string): string {
  const bytes = readFileSync(path)
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (content.includes('\0')) throw new Error('文件包含 NUL 字节')
  return content
}

export function resolveTrustedWorkspaceInstruction(
  agentsMdPathInput: string,
  legacyClaudeMdPathInput?: string,
): TrustedWorkspaceInstructionResult {
  const absolutePath = resolve(agentsMdPathInput)
  if (!lstatIfPresent(absolutePath)) {
    if (!legacyClaudeMdPathInput) return { diagnostics: [] }
    const legacyPath = resolve(legacyClaudeMdPathInput)
    if (!lstatIfPresent(legacyPath)) return { diagnostics: [] }
    try {
      const legacyStat = lstatSync(legacyPath)
      if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) {
        return { diagnostics: ['legacy Domi 工作区 CLAUDE.md 不是普通文件，已拒绝注入。'] }
      }
      if (legacyStat.size > MAX_PROJECT_INSTRUCTION_BYTES) {
        return { diagnostics: ['legacy Domi 工作区 CLAUDE.md 超过 64 KB 注入上限，已拒绝注入。'] }
      }
      const content = readUtf8Instruction(legacyPath)
      return {
        source: { kind: 'claude', absolutePath: legacyPath, content, contentHash: digest(content) },
        diagnostics: ['Domi 工作区 CLAUDE.md 迁移尚未完成，本轮继续以只读兼容来源注入。'],
      }
    } catch (error) {
      return { diagnostics: [`无法读取 legacy Domi 工作区 CLAUDE.md: ${error instanceof Error ? error.message : '未知错误'}`] }
    }
  }

  try {
    const logicalStat = lstatSync(absolutePath)
    if (!logicalStat.isFile() || logicalStat.isSymbolicLink()) {
      return { diagnostics: ['Domi 工作区 AGENTS.md 不是普通文件，已拒绝注入。'] }
    }
    if (logicalStat.size > MAX_PROJECT_INSTRUCTION_BYTES) {
      return { diagnostics: ['Domi 工作区 AGENTS.md 超过 64 KB 注入上限，已拒绝注入。'] }
    }
    const content = readUtf8Instruction(absolutePath)
    return {
      source: { kind: 'agents', absolutePath, content, contentHash: digest(content) },
      diagnostics: [],
    }
  } catch (error) {
    return { diagnostics: [`无法读取 Domi 工作区 AGENTS.md: ${error instanceof Error ? error.message : '未知错误'}`] }
  }
}

/**
 * 只解析宿主显式传入的 Session Target 根目录；不搜索 cwd 祖先或附加目录。
 */
export function resolveTrustedProjectInstruction(projectRootInput: string): TrustedProjectInstructionResult {
  const diagnostics: string[] = []
  let projectRoot = resolve(projectRootInput)

  try {
    const rootStat = statSync(projectRoot)
    if (!rootStat.isDirectory()) {
      return { projectRoot, diagnostics: ['Session Target 项目根不是目录，未加载项目指令。'] }
    }
    projectRoot = realpathSync(projectRoot)
  } catch (error) {
    return {
      projectRoot,
      diagnostics: [`无法访问 Session Target 项目根: ${error instanceof Error ? error.message : '未知错误'}`],
    }
  }

  for (let index = 0; index < INSTRUCTION_CANDIDATES.length; index += 1) {
    const candidate = INSTRUCTION_CANDIDATES[index]!
    const logicalPath = join(projectRoot, candidate.name)
    const candidateStat = lstatIfPresent(logicalPath)
    if (!candidateStat) continue

    try {
      const logicalStat = candidateStat
      if (!logicalStat.isFile() && !logicalStat.isSymbolicLink()) {
        diagnostics.push(`${candidate.name} 不是普通文件，未加载任何低优先级项目指令。`)
        break
      }

      const absolutePath = realpathSync(logicalPath)
      if (!isWithinRoot(projectRoot, absolutePath)) {
        diagnostics.push(`${candidate.name} 的真实路径位于授权项目根之外，已拒绝加载。`)
        break
      }

      const realStat = statSync(absolutePath)
      if (!realStat.isFile()) {
        diagnostics.push(`${candidate.name} 的真实目标不是普通文件，未加载任何低优先级项目指令。`)
        break
      }
      if (realStat.size > MAX_PROJECT_INSTRUCTION_BYTES) {
        diagnostics.push(`${candidate.name} 超过 64 KB 注入上限，已拒绝加载。`)
        break
      }

      const content = readUtf8Instruction(absolutePath)

      if (candidate.kind === 'agents') {
        const legacyExists = INSTRUCTION_CANDIDATES
          .slice(index + 1)
          .some((lower) => lower.kind === 'claude' && Boolean(lstatIfPresent(join(projectRoot, lower.name))))
        if (legacyExists) {
          diagnostics.push('同一项目根还存在 legacy CLAUDE.md；AGENTS.md 优先，legacy 文件保持不变且未激活。')
        }
      }

      return {
        projectRoot,
        source: {
          kind: candidate.kind,
          relativePath: candidate.name,
          absolutePath,
          content,
          contentHash: digest(content),
        },
        diagnostics,
      }
    } catch (error) {
      diagnostics.push(`无法读取 ${candidate.name}: ${error instanceof Error ? error.message : '未知错误'}`)
      // 高优先级候选存在但无效时不能暴露低优先级 legacy 文件。
      break
    }
  }

  return { projectRoot, diagnostics }
}
