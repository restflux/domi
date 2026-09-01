import type {
  GitRepositorySnapshot,
  GitWorkspaceChangeLayer,
  GitWorkspaceChangeStatus,
  GitWorkspaceFileChange,
  GitWorkspaceLogEntry,
  GitWorkspaceSnapshot,
} from '@domi/shared'

export interface GitWorkspaceGroupView {
  layer: GitWorkspaceChangeLayer
  label: string
  files: GitWorkspaceFileChange[]
}

export interface GitRepositoryView {
  repository: GitRepositorySnapshot
  groups: GitWorkspaceGroupView[]
  totalChanges: number
  branchLabel: string
  shortHead: string | null
}

const GROUPS: Array<{ layer: GitWorkspaceChangeLayer; label: string }> = [
  { layer: 'conflict', label: '冲突' },
  { layer: 'staged', label: '已暂存' },
  { layer: 'unstaged', label: '未暂存' },
  { layer: 'untracked', label: '未跟踪' },
]

function filesForLayer(repository: GitRepositorySnapshot, layer: GitWorkspaceChangeLayer): GitWorkspaceFileChange[] {
  switch (layer) {
    case 'conflict': return repository.conflicts
    case 'staged': return repository.staged
    case 'unstaged': return repository.unstaged
    case 'untracked': return repository.untracked
  }
}

export function getRepositoryBranchLabel(repository: GitRepositorySnapshot): string {
  if (repository.unborn) return repository.branch ? `${repository.branch} · 尚无提交` : '尚无提交'
  if (repository.detached) return 'Detached HEAD'
  return repository.branch ?? '未知分支'
}

const GIT_CHANGE_STATUS_MARKERS: Record<GitWorkspaceChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  conflicted: '!',
  untracked: 'U',
}

export function getGitChangeStatusMarker(status: GitWorkspaceChangeStatus): string {
  return GIT_CHANGE_STATUS_MARKERS[status]
}

export function buildGitWorkspaceView(
  snapshot: GitWorkspaceSnapshot,
  searchQuery = '',
): GitRepositoryView[] {
  const query = searchQuery.trim().toLowerCase()
  return snapshot.repositories.map((repository) => {
    const groups = GROUPS.map(({ layer, label }) => ({
      layer,
      label,
      files: filesForLayer(repository, layer).filter((file) => (
        !query || file.relativePath.toLowerCase().includes(query)
      )),
    })).filter((group) => group.files.length > 0)
    const totalChanges = repository.conflicts.length
      + repository.staged.length
      + repository.unstaged.length
      + repository.untracked.length
    return {
      repository,
      groups,
      totalChanges,
      branchLabel: getRepositoryBranchLabel(repository),
      shortHead: repository.headOid?.slice(0, 7) ?? null,
    }
  })
}

export function gitWorkspaceDiscardablePaths(repository: GitRepositorySnapshot): string[] {
  return repository.unstaged.map((change) => change.relativePath)
}

export function gitWorkspaceTotalChanges(snapshot: GitWorkspaceSnapshot): number {
  return snapshot.repositories.reduce((total, repository) => total
    + repository.conflicts.length
    + repository.staged.length
    + repository.unstaged.length
    + repository.untracked.length, 0)
}

/** 历史条目中的 tag 徽章列表（只取 tag refs）。 */
export function tagBadges(entry: GitWorkspaceLogEntry): string[] {
  return entry.refs.filter((ref) => ref.kind === 'tag').map((ref) => ref.name)
}

/** Unix 秒 → 人类可读相对时间。 */
export function relativeTime(epochSeconds: number, now = Date.now()): string {
  const delta = Math.max(0, Math.floor(now / 1000) - epochSeconds)
  if (delta < 60) return '刚刚'
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)} 天前`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}
