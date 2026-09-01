import type {
  GitWorkspaceChangeLayer,
  GitWorkspaceChangeStatus,
} from '@domi/shared'

export interface ParsedGitStatusHeader {
  branch: string | null
  detached: boolean
  unborn: boolean
  headOid: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export interface ParsedGitStatusEntry {
  repositoryPath: string
  previousRepositoryPath?: string
  indexCode: string
  worktreeCode: string
  conflict: boolean
  untracked: boolean
}

export interface ParsedGitStatus {
  header: ParsedGitStatusHeader
  entries: ParsedGitStatusEntry[]
}

export interface GitNumstat {
  additions: number
  deletions: number
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseOrdinary(record: string): ParsedGitStatusEntry | null {
  const match = record.match(/^1 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s)
  if (!match) return null
  return {
    repositoryPath: match[2]!,
    indexCode: match[1]![0] ?? '.',
    worktreeCode: match[1]![1] ?? '.',
    conflict: false,
    untracked: false,
  }
}

function parseRename(record: string, previousRepositoryPath: string | undefined): ParsedGitStatusEntry | null {
  const match = record.match(/^2 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s)
  if (!match) return null
  return {
    repositoryPath: match[2]!,
    ...(previousRepositoryPath ? { previousRepositoryPath } : {}),
    indexCode: match[1]![0] ?? '.',
    worktreeCode: match[1]![1] ?? '.',
    conflict: false,
    untracked: false,
  }
}

function parseConflict(record: string): ParsedGitStatusEntry | null {
  const match = record.match(/^u (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s)
  if (!match) return null
  return {
    repositoryPath: match[2]!,
    indexCode: match[1]![0] ?? 'U',
    worktreeCode: match[1]![1] ?? 'U',
    conflict: true,
    untracked: false,
  }
}

export function parseGitPorcelainV2(output: string): ParsedGitStatus {
  const header: ParsedGitStatusHeader = {
    branch: null,
    detached: false,
    unborn: false,
    headOid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  }
  const entries: ParsedGitStatusEntry[] = []
  const records = output.split('\0')

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length).trim()
      header.unborn = oid === '(initial)'
      header.headOid = header.unborn ? null : oid
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice('# branch.head '.length).trim()
      header.detached = branch === '(detached)'
      header.branch = header.detached ? null : branch
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      header.upstream = record.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      header.ahead = parseCount(match?.[1])
      header.behind = parseCount(match?.[2])
      continue
    }
    if (record.startsWith('1 ')) {
      const entry = parseOrdinary(record)
      if (entry) entries.push(entry)
      continue
    }
    if (record.startsWith('2 ')) {
      const entry = parseRename(record, records[index + 1] || undefined)
      if (entry) entries.push(entry)
      index += 1
      continue
    }
    if (record.startsWith('u ')) {
      const entry = parseConflict(record)
      if (entry) entries.push(entry)
      continue
    }
    if (record.startsWith('? ')) {
      entries.push({
        repositoryPath: record.slice(2),
        indexCode: '.',
        worktreeCode: '?',
        conflict: false,
        untracked: true,
      })
    }
  }

  return { header, entries }
}

export function statusForGitCode(
  code: string,
  fallback: GitWorkspaceChangeStatus = 'modified',
): GitWorkspaceChangeStatus {
  switch (code) {
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'type-changed'
    case 'U': return 'conflicted'
    case '?': return 'untracked'
    default: return fallback
  }
}

export function entryLayers(entry: ParsedGitStatusEntry): GitWorkspaceChangeLayer[] {
  if (entry.conflict) return ['conflict']
  if (entry.untracked) return ['untracked']
  const layers: GitWorkspaceChangeLayer[] = []
  if (entry.indexCode !== '.') layers.push('staged')
  if (entry.worktreeCode !== '.') layers.push('unstaged')
  return layers
}

/** 解析 `git diff --numstat -z`，兼容普通路径和 rename 的三段路径格式。 */
export function parseGitNumstat(output: string): Map<string, GitNumstat> {
  const stats = new Map<string, GitNumstat>()
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const match = record.match(/^([^\t]+)\t([^\t]+)\t(.*)$/s)
    if (!match) continue
    const value = {
      additions: match[1] === '-' ? 0 : parseCount(match[1]),
      deletions: match[2] === '-' ? 0 : parseCount(match[2]),
    }
    if (match[3]) {
      stats.set(match[3], value)
      continue
    }
    const previousPath = records[index + 1]
    const nextPath = records[index + 2]
    if (nextPath) stats.set(nextPath, value)
    else if (previousPath) stats.set(previousPath, value)
    index += 2
  }
  return stats
}
