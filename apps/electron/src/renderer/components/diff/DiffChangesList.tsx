/**
 * DiffChangesList — 代码改动文件列表
 *
 * 显示当前工作树相对 HEAD 的代码改动，按目录分组，支持 hover 操作按钮。
 */

import * as React from 'react'
import { AlertCircle, ArrowDownToLine, ArrowUpToLine, Box, ChevronLeft, ChevronRight, Cloud, FolderSearch, Laptop, Search, SquareTerminal, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { agentDiffUnseenFilesAtom, agentDiffDataAtom } from '@/atoms/agent-atoms'
import { gitWorkspaceSnapshotAtom } from '@/atoms/git-workspace-atoms'
import type {
  ChangedFileEntry,
  ChangeSource,
  GitRepositorySnapshot,
  GitWorkspaceBranchesResult,
  GitWorkspaceCommitFilesResult,
  GitWorkspaceDiffContents,
  GitWorkspaceFileChange,
  GitWorkspaceHistoryResult,
  GitWorkspaceOperationResult,
  GitWorkspaceSnapshot,
  GitWorkspaceCommitFileEntry,
  GitWorkspaceLogEntry,
  UntrackedFileEntry,
} from '@domi/shared'
import { createSessionTargetFileRequest } from '@/lib/session-target-file-routing.ts'
import { groupSessionFileChanges, shouldShowNonGitFileChanges } from '@/lib/session-file-changes'
import type { SessionFileChange } from '@/lib/session-file-changes'
import { buildGitWorkspaceView, getGitChangeStatusMarker, gitWorkspaceDiscardablePaths, gitWorkspaceTotalChanges, relativeTime, tagBadges, type GitWorkspaceGroupView } from '@/lib/git-workspace-view-model'
import { GitWorkspaceRequestSequence } from '@/lib/git-workspace-request-sequence'
import { GitWorkspaceSummary } from './GitWorkspaceSummary'
import { resolveChangedFileTerminalCwd } from '@/lib/terminal-directory-routing'

/** 按目录分组后的数据结构 */
interface FileGroup {
  /** 完整 Git 仓库路径（用作 React key，避免同名目录冲突） */
  gitRoot: string
  /** 显示用的目录名（仓库的最后一段） */
  dirName: string
  files: ChangedFileEntry[]
  totalAdditions: number
  totalDeletions: number
  sources: ChangeSource[]
}

interface DiffChangesListProps {
  /** Git 仓库根目录 */
  dirPath: string
  /** 当前 Agent 会话 ID，用于主进程路径授权 */
  sessionId: string
  /** Active Pi Diff 不提交物理 checkout 路径。 */
  usesSessionTarget?: boolean
  /** 点击文件回调 */
  onFileClick: (filePath: string, isUntracked: boolean, gitRoot?: string) => void
  /** 自动刷新信号（版本号递增触发） */
  refreshVersion?: number
  /** 当前选中的文件路径（高亮显示） */
  selectedFilePath?: string
  /** 本会话在非 Git Session Target 中成功写入的项目文件。 */
  nonGitFileChanges?: SessionFileChange[]
  /** 当前 Agent run ID，用于区分本轮与更早的文件变化。 */
  currentFileChangeRunId?: string
  /** 点击非 Git 文件时打开纯文件预览。 */
  onPlainFileClick?: (filePath: string) => void
  /** 点击分层 Git 文件时打开对应 staged/unstaged/conflict/untracked Diff。 */
  onGitWorkspaceFileClick?: (change: GitWorkspaceFileChange, repositoryId: string) => void
  /** 点击历史提交内文件时打开单提交 Diff。 */
  onGitCommitFileClick?: (repositoryId: string, oid: string, relativePath: string) => void
  /** Git 面板写操作/历史能力；缺省时走 window.electronAPI 默认实现。 */
  gitActions?: GitPanelActions
}

/** Git 面板全部操作；封装 sessionId，调用方只传仓库与文件参数。 */
export interface GitPanelActions {
  stage: (repositoryId: string, relativePaths: string[], action: 'stage' | 'unstage') => Promise<GitWorkspaceOperationResult>
  discard: (repositoryId: string, relativePaths: string[], layer: GitWorkspaceFileChange['layer']) => Promise<GitWorkspaceOperationResult>
  commit: (repositoryId: string, message: string, push: boolean) => Promise<GitWorkspaceOperationResult>
  checkout: (repositoryId: string, branch: string) => Promise<GitWorkspaceOperationResult>
  pullPush: (repositoryId: string, action: 'fetch' | 'pull' | 'push' | 'sync') => Promise<GitWorkspaceOperationResult>
  branches: (repositoryId: string) => Promise<GitWorkspaceBranchesResult>
  history: (repositoryId: string, limit?: number) => Promise<GitWorkspaceHistoryResult>
  commitFiles: (repositoryId: string, oid: string) => Promise<GitWorkspaceCommitFilesResult>
  commitDiff: (repositoryId: string, oid: string, relativePath: string) => Promise<GitWorkspaceDiffContents | null>
  /** 向当前 Agent 会话发送用户消息（冲突解决入口）。 */
  sendMessage: (userMessage: string) => Promise<unknown>
}

/** 构建“交给 Agent 解决冲突”的指令消息（自包含中文指令）。 */
export function buildConflictAgentMessage(
  displayName: string,
  branch: string | null,
  error: string | null,
  conflictPaths: string[],
): string {
  const lines: string[] = [
    'Git 面板同步/合并遇到冲突，请帮我解决。',
    '',
    `仓库：${displayName}`,
    `当前分支：${branch ?? 'detached'}`,
  ]
  if (error) lines.push(`错误信息：${error}`)
  if (conflictPaths.length > 0) {
    lines.push('冲突文件：')
    lines.push(...conflictPaths.map((path) => `- ${path}`))
  }
  lines.push('请检查冲突标记并合并两边改动，完成后告诉我结果与建议的下一步（提交或继续同步）。')
  return lines.join('\n')
}

/** 文件来源 badge 的颜色和文案 */
const SOURCE_CONFIG: Record<string, { color: string; label: string }> = {
  session: { color: 'bg-blue-500/10 text-blue-500', label: '会话文件' },
  workspace: { color: 'bg-purple-500/10 text-purple-500', label: '项目文件' },
  both: { color: 'bg-cyan-500/10 text-cyan-500', label: '会话+项目文件' },
  none: { color: 'bg-muted text-muted-foreground', label: '附加目录文件' },
}

export const DiffChangesList = React.memo(function DiffChangesList({
  dirPath,
  sessionId,
  usesSessionTarget = false,
  onFileClick,
  refreshVersion,
  selectedFilePath,
  nonGitFileChanges = [],
  currentFileChangeRunId,
  onPlainFileClick,
  onGitWorkspaceFileClick,
  onGitCommitFileClick,
  gitActions,
}: DiffChangesListProps): React.ReactElement {
  const diffCacheKey = `${sessionId}:${usesSessionTarget ? 'session-target' : dirPath}`

  /** 默认 Git 面板操作：走主进程 electronAPI（Repository ID 契约）。 */
  const defaultActions = React.useMemo<GitPanelActions>(() => ({
    stage: (repositoryId, relativePaths, action) =>
      window.electronAPI.stageGitWorkspaceFiles({ sessionId, repositoryId, relativePaths, action }),
    discard: (repositoryId, relativePaths, layer) =>
      window.electronAPI.discardGitWorkspaceFiles({ sessionId, repositoryId, relativePaths, layer }),
    commit: (repositoryId, message, push) =>
      window.electronAPI.commitGitWorkspace({ sessionId, repositoryId, message, push }),
    checkout: (repositoryId, branch) =>
      window.electronAPI.checkoutGitWorkspaceBranch({ sessionId, repositoryId, branch }),
    pullPush: (repositoryId, action) =>
      window.electronAPI.gitWorkspacePullPush({ sessionId, repositoryId, action }),
    branches: (repositoryId) =>
      window.electronAPI.getGitWorkspaceBranches({ sessionId, repositoryId }),
    history: (repositoryId, limit) =>
      window.electronAPI.getGitWorkspaceHistory({ sessionId, repositoryId, limit }),
    commitFiles: (repositoryId, oid) =>
      window.electronAPI.getGitWorkspaceCommitFiles({ sessionId, repositoryId, oid }),
    commitDiff: (repositoryId, oid, relativePath) =>
      window.electronAPI.getGitWorkspaceCommitDiff({ sessionId, repositoryId, oid, relativePath }),
    sendMessage: (userMessage) =>
      window.electronAPI.queueAgentMessage({
        sessionId,
        userMessage,
        rawUserMessage: userMessage,
        uuid: crypto.randomUUID(),
        interrupt: false,
      }),
  }), [sessionId])
  const actions = gitActions ?? defaultActions

  // Diff 数据缓存：mount 时若已有上次结果，立即用作初值，避免空数组闪 1s "没有代码改动"
  const diffDataMap = useAtomValue(agentDiffDataAtom)
  const setDiffDataMap = useSetAtom(agentDiffDataAtom)
  const cached = diffDataMap.get(diffCacheKey)
  const gitSnapshotMap = useAtomValue(gitWorkspaceSnapshotAtom)
  const setGitSnapshotMap = useSetAtom(gitWorkspaceSnapshotAtom)
  const cachedGitSnapshot = gitSnapshotMap.get(sessionId)
  const [gitSnapshot, setGitSnapshot] = React.useState<GitWorkspaceSnapshot | null>(() => cachedGitSnapshot ?? null)
  const [gitLoading, setGitLoading] = React.useState(() => usesSessionTarget && !cachedGitSnapshot)
  const [files, setFiles] = React.useState<ChangedFileEntry[]>(() => cached?.files ?? [])
  const [untrackedFiles, setUntrackedFiles] = React.useState<UntrackedFileEntry[]>(() => cached?.untrackedFiles ?? [])
  const [isGitRepo, setIsGitRepo] = React.useState(() => cached?.isGitRepo ?? true)
  /** 首次 fetch 是否已返回——区分 loading 与真·空，避免 "没有代码改动" 误闪 */
  const [hasFetched, setHasFetched] = React.useState<boolean>(() => cached !== undefined)
  const [collapsedDirs, setCollapsedDirs] = React.useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = React.useState('')
  /** 单调递增的 fetch 序号，用于丢弃乱序到达的旧响应 */
  const fetchSequenceRef = React.useRef(new GitWorkspaceRequestSequence())

  // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset state on cache key switch, not on every diffDataMap update
  React.useEffect(() => {
    fetchSequenceRef.current.invalidate()
    const nextCached = diffDataMap.get(diffCacheKey)
    const nextGitSnapshot = gitSnapshotMap.get(sessionId) ?? null
    setGitSnapshot(nextGitSnapshot)
    setGitLoading(usesSessionTarget && !nextGitSnapshot)
    setFiles(nextCached?.files ?? [])
    setUntrackedFiles(nextCached?.untrackedFiles ?? [])
    setIsGitRepo(usesSessionTarget ? Boolean(nextGitSnapshot?.repositories.length) : (nextCached?.isGitRepo ?? true))
    setHasFetched(usesSessionTarget ? nextGitSnapshot !== null : nextCached !== undefined)
  }, [diffCacheKey, sessionId, usesSessionTarget])

  // Agent 本轮刚修改但尚未查看的文件
  const unseenFilesMap = useAtomValue(agentDiffUnseenFilesAtom)
  const setUnseenFilesMap = useSetAtom(agentDiffUnseenFilesAtom)
  const unseenFiles = unseenFilesMap.get(sessionId) ?? new Set<string>()

  const markFileAsSeen = React.useCallback((filePath: string) => {
    setUnseenFilesMap((prev) => {
      const s = prev.get(sessionId)
      if (!s?.has(filePath)) return prev
      const m = new Map(prev)
      const next = new Set(s)
      next.delete(filePath)
      m.set(sessionId, next)
      return m
    })
  }, [sessionId, setUnseenFilesMap])

  const fetchChanges = React.useCallback(async (force = false) => {
    const requestId = fetchSequenceRef.current.next()
    if (usesSessionTarget) setGitLoading(true)
    try {
      if (usesSessionTarget) {
        const snapshot = await window.electronAPI.getGitWorkspaceSnapshot({ sessionId, force })
        if (!fetchSequenceRef.current.isCurrent(requestId)) return
        setGitSnapshot(snapshot)
        setIsGitRepo(snapshot.repositories.length > 0)
        setFiles([])
        setUntrackedFiles([])
        setHasFetched(true)
        setGitSnapshotMap((prev) => {
          const next = new Map(prev)
          next.set(sessionId, snapshot)
          return next
        })
        return
      }

      const result = await window.electronAPI.getUnstagedChanges(dirPath, undefined, undefined, undefined, sessionId)
      if (!fetchSequenceRef.current.isCurrent(requestId)) return
      setIsGitRepo(result.isGitRepo)
      setFiles(result.files || [])
      setUntrackedFiles(result.untrackedFiles || [])
      setHasFetched(true)
      setDiffDataMap((prev) => {
        const next = new Map(prev)
        next.set(diffCacheKey, result)
        return next
      })
    } catch {
      if (!fetchSequenceRef.current.isCurrent(requestId)) return
      setHasFetched(true)
    } finally {
      if (fetchSequenceRef.current.isCurrent(requestId)) setGitLoading(false)
    }
  }, [sessionId, setDiffDataMap, setGitSnapshotMap, diffCacheKey, usesSessionTarget, dirPath])

  React.useEffect(() => {
    fetchChanges()
  }, [fetchChanges, refreshVersion])

  // 窗口聚焦刷新已统一在 useGlobalAgentListeners 中处理（递增 refreshVersion）

  /** Revert 文件 */
  const handleRevert = React.useCallback(async (filePath: string, gitRoot: string) => {
    if (!window.confirm(`确定要还原 ${filePath} 的所有变更吗？此操作不可撤销。`)) return
    try {
      if (usesSessionTarget) {
        const request = createSessionTargetFileRequest(sessionId, filePath)
        if (!request) return
        await window.electronAPI.revertSessionTargetFile(request)
      } else {
        await window.electronAPI.revertFile({ dirPath: gitRoot, filePath, gitRoot, sessionId })
      }
      await fetchChanges()
    } catch (err) {
      window.alert(`还原失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }, [fetchChanges, sessionId, usesSessionTarget])

  /** 切换文件夹折叠 */
  const toggleDir = React.useCallback((dirName: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirName)) {
        next.delete(dirName)
      } else {
        next.add(dirName)
      }
      return next
    })
  }, [])

  // 按 Git 仓库分组（在所有 hooks 之后、条件返回之前调用）
  const { fileGroups, matchedFilesCount } = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    // 用完整 gitRoot 做 key，避免同名目录冲突
    const groups = new Map<string, ChangedFileEntry[]>()
    let matched = 0
    for (const f of files) {
      if (q && !f.filePath.toLowerCase().includes(q)) continue
      const key = f.gitRoot || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(f)
      matched++
    }
    const result: FileGroup[] = [...groups.entries()].map(([gitRoot, groupFiles]) => ({
      gitRoot,
      dirName: gitRoot ? gitRoot.split('/').pop() || gitRoot : '/',
      files: groupFiles,
      totalAdditions: groupFiles.reduce((sum, f) => sum + f.additions, 0),
      totalDeletions: groupFiles.reduce((sum, f) => sum + f.deletions, 0),
      sources: [...new Set(groupFiles.map((f) => f.source))],
    }))
    return { fileGroups: result, matchedFilesCount: matched }
  }, [files, searchQuery])

  const filteredUntrackedFiles = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return untrackedFiles
    return untrackedFiles.filter((f) => f.filePath.toLowerCase().includes(q))
  }, [untrackedFiles, searchQuery])

  const gitRepositoryViews = React.useMemo(
    () => gitSnapshot ? buildGitWorkspaceView(gitSnapshot, searchQuery) : [],
    [gitSnapshot, searchQuery],
  )
  const gitTotalChanges = gitSnapshot ? gitWorkspaceTotalChanges(gitSnapshot) : 0
  const gitHasMatchedFiles = gitRepositoryViews.some((repository) => repository.groups.length > 0)
  const isEmpty = fileGroups.length === 0 && filteredUntrackedFiles.length === 0
  const hasAnyChanges = usesSessionTarget ? gitTotalChanges > 0 : files.length > 0 || untrackedFiles.length > 0
  const hasNonGitFileChanges = usesSessionTarget
    ? Boolean(gitSnapshot && !gitSnapshot.error && gitSnapshot.repositories.length === 0 && nonGitFileChanges.length > 0)
    : shouldShowNonGitFileChanges(isGitRepo, nonGitFileChanges)
  const shouldShowSearch = isGitRepo && (hasAnyChanges || searchQuery.length > 0)
  const openChangedFileDirectoryInTerminal = React.useCallback((relativePath: string) => {
    const cwd = resolveChangedFileTerminalCwd(relativePath)
    const title = cwd === '.' ? '项目终端' : cwd.split('/').at(-1) ?? '项目终端'
    window.electronAPI.terminal.create({ ownerSessionId: sessionId, cwd, title, cols: 100, rows: 30 })
      .catch((error) => toast.error('无法打开内嵌终端', {
        description: error instanceof Error ? error.message : '终端创建失败',
      }))
  }, [sessionId])

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-thin">
      {/* 搜索框 — 有改动文件时才显示 */}
      {shouldShowSearch && (
        <div className="flex-shrink-0 sticky top-0 z-10 bg-content-area px-2 pt-1.5 pb-1">
          <div className="flex items-center gap-1.5 px-2 h-7 rounded-md bg-muted/50 border border-transparent focus-within:border-primary/40 focus-within:bg-muted/70 transition-colors">
            <Search className="size-3 text-muted-foreground flex-shrink-0" />
            <input
              type="text"
              aria-label="搜索改动文件"
              className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/40"
              placeholder="搜索改动文件..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <>
                <span className="text-[10px] text-muted-foreground/50 flex-shrink-0 tabular-nums">
                  {usesSessionTarget
                    ? gitRepositoryViews.reduce((total, repository) => total + repository.groups.reduce((sum, group) => sum + group.files.length, 0), 0)
                    : matchedFilesCount + filteredUntrackedFiles.length}
                </span>
                <button
                  type="button"
                  aria-label="清除搜索"
                  className="flex-shrink-0 p-0.5 rounded-sm hover:bg-foreground/[0.08] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  onClick={() => setSearchQuery('')}
                >
                  <X className="size-3" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {usesSessionTarget && gitSnapshot?.error && (
        <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{gitSnapshot.error.message}</span>
          <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => void fetchChanges(true)}>重试</button>
        </div>
      )}
      {usesSessionTarget && gitSnapshot && gitSnapshot.repositories.length > 0 && (
        <div className="shrink-0">
          {gitRepositoryViews.map((repositoryView) => (
            <GitRepositorySection
              key={repositoryView.repository.repositoryId}
              repository={repositoryView.repository}
              groups={repositoryView.groups}
              multipleRepositories={gitRepositoryViews.length > 1}
              loading={gitLoading}
              selectedFilePath={selectedFilePath}
              onRefresh={() => void fetchChanges(true)}
              onFileClick={(change) => onGitWorkspaceFileClick?.(change, repositoryView.repository.repositoryId)}
              onOpenTerminal={openChangedFileDirectoryInTerminal}
              onGitCommitFileClick={onGitCommitFileClick}
              actions={actions}
            />
          ))}
          {gitTotalChanges === 0 && (
            <div className="flex min-h-32 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              工作区干净
            </div>
          )}
          {gitTotalChanges > 0 && searchQuery && !gitHasMatchedFiles && (
            <div className="flex min-h-32 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              没有匹配的文件
            </div>
          )}
        </div>
      )}
      {hasNonGitFileChanges && (
        <NonGitChangesList
          changes={nonGitFileChanges}
          currentRunId={currentFileChangeRunId}
          sessionId={sessionId}
          selectedFilePath={selectedFilePath}
          onFileClick={onPlainFileClick}
        />
      )}
      {usesSessionTarget && gitLoading && !gitSnapshot && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">正在读取 Git 状态…</p>
        </div>
      )}
      {usesSessionTarget && !gitLoading && gitSnapshot && gitSnapshot.repositories.length === 0 && !hasNonGitFileChanges && !gitSnapshot.error && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">当前项目不是 Git 仓库</p>
        </div>
      )}
      {!usesSessionTarget && !isGitRepo && !hasNonGitFileChanges && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">当前目录不是 Git 仓库</p>
        </div>
      )}
      {!usesSessionTarget && isGitRepo && !hasAnyChanges && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">{hasFetched ? '没有代码改动' : '加载中…'}</p>
        </div>
      )}
      {!usesSessionTarget && isGitRepo && hasAnyChanges && isEmpty && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <p className="text-[12px] text-center">没有匹配的文件</p>
        </div>
      )}
      {!usesSessionTarget && isGitRepo && hasAnyChanges && !isEmpty && (
        <>
          {fileGroups.map((group) => {
            const isCollapsed = collapsedDirs.has(group.gitRoot)
            return (
              <div key={group.gitRoot}>
                {/* 文件夹 bar */}
                <button
                  type="button"
                  onClick={() => toggleDir(group.gitRoot)}
                  className="flex items-center gap-1 w-full px-2 py-2 text-[13px] font-medium text-foreground/60 hover:bg-foreground/[0.04] transition-colors"
                >
                  <ChevronRight
                    className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')}
                  />
                  <span className="truncate">{group.dirName}</span>
                  {/* 文件夹层级的来源 badges */}
                  {group.sources.map((src) => {
                    const cfg = SOURCE_CONFIG[src] ?? SOURCE_CONFIG.none!
                    return (
                      <span key={src} className={cn('rounded px-1 py-0.5 text-[12px] leading-none shrink-0', cfg.color)}>
                        {cfg.label}
                      </span>
                    )
                  })}
                  <span className="ml-auto shrink-0 flex items-center gap-1.5">
                    <span className="text-foreground/30">{group.files.length} changed files</span>
                    {group.totalAdditions > 0 && <span className="text-foreground/30">+{group.totalAdditions}</span>}
                    {group.totalDeletions > 0 && <span className="text-foreground/30">-{group.totalDeletions}</span>}
                  </span>
                </button>

                {/* 文件列表 */}
                {!isCollapsed && group.files.map((file) => {
                  const absPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')
                  return (
                    <FileRow
                      key={`${file.gitRoot}:${file.filePath}`}
                      file={file}
                      isSelected={absPath === selectedFilePath || file.filePath === selectedFilePath}
                      isUnseen={unseenFiles.has(absPath)}
                      onClick={() => { markFileAsSeen(absPath); onFileClick(file.filePath, false, file.gitRoot) }}
                      onRevert={() => handleRevert(file.filePath, file.gitRoot)}
                      dirPath={dirPath}
                    />
                  )
                })}
              </div>
            )
          })}

          {/* 未追踪文件分组 */}
          {filteredUntrackedFiles.length > 0 && (
            <div>
              <div className="flex items-center px-2 py-2 text-[13px] font-medium text-muted-foreground border-t border-border/30">
                未追踪文件
              </div>
              {filteredUntrackedFiles.map((file) => (
                <UntrackedFileRow
                  key={`${file.gitRoot}:${file.filePath}`}
                  file={file}
                  onClick={() => onFileClick(file.filePath, true, file.gitRoot)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
})

const GIT_STATUS_LABEL_CLASS: Record<GitWorkspaceFileChange['status'], string> = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-red-500',
  renamed: 'text-sky-500',
  copied: 'text-sky-500',
  'type-changed': 'text-violet-500',
  conflicted: 'text-red-500',
  untracked: 'text-sky-500',
}

function GitRepositorySection({
  repository,
  groups,
  multipleRepositories,
  loading,
  selectedFilePath,
  onRefresh,
  onFileClick,
  onOpenTerminal,
  onGitCommitFileClick,
  actions,
}: {
  repository: GitRepositorySnapshot
  groups: GitWorkspaceGroupView[]
  multipleRepositories: boolean
  loading: boolean
  selectedFilePath?: string
  onRefresh: () => void
  onFileClick: (change: GitWorkspaceFileChange) => void
  onOpenTerminal: (relativePath: string) => void
  onGitCommitFileClick?: (repositoryId: string, oid: string, relativePath: string) => void
  actions: GitPanelActions
}): React.ReactElement {
  const [view, setView] = React.useState<'changes' | 'history'>('changes')
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set())

  const toggleGroupCollapsed = React.useCallback((layer: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(layer)) {
        next.delete(layer)
      } else {
        next.add(layer)
      }
      return next
    })
  }, [])
  const runAndRefresh = React.useCallback(async (operation: () => Promise<GitWorkspaceOperationResult>) => {
    const result = await operation()
    if (result.ok) {
      onRefresh()
    } else {
      toast.error(result.message ?? 'Git 操作失败')
    }
  }, [onRefresh])

  const [syncError, setSyncError] = React.useState<string | null>(null)
  const [syncing, setSyncing] = React.useState(false)

  /** 刷新远端引用后重扫状态，避免其他设备的新提交被旧 tracking ref 遮蔽。 */
  const handleRefresh = React.useCallback(async () => {
    if (syncing) return
    if (!repository.upstream) {
      onRefresh()
      return
    }
    setSyncing(true)
    setSyncError(null)
    try {
      const result = await actions.pullPush(repository.repositoryId, 'fetch')
      if (!result.ok) setSyncError(result.message ?? '刷新远端状态失败')
    } finally {
      setSyncing(false)
      onRefresh()
    }
  }, [actions, onRefresh, repository.repositoryId, repository.upstream, syncing])

  /** 一键同步始终由主进程执行 pull --ff-only → push，不依赖可能过期的 ahead/behind。 */
  const handleSync = React.useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setSyncError(null)
    try {
      if (!repository.upstream) {
        toast.error('无上游分支，无法同步')
        return
      }
      const result = await actions.pullPush(repository.repositoryId, 'sync')
      if (!result.ok) {
        const message = result.message ?? '同步失败'
        setSyncError(/CONFLICT/.test(message) ? `合并冲突：${message}` : message)
        return
      }
      toast.success('已同步')
    } finally {
      setSyncing(false)
      onRefresh()
    }
  }, [actions, onRefresh, repository.repositoryId, repository.upstream, syncing])

  /** 打开历史前 fetch，使远端已提交但尚未 pull 的提交也进入联合历史。 */
  const handleOpenHistory = React.useCallback(async () => {
    if (syncing) return
    if (repository.upstream) {
      setSyncing(true)
      setSyncError(null)
      try {
        const result = await actions.pullPush(repository.repositoryId, 'fetch')
        if (!result.ok) {
          setSyncError(result.message ?? '刷新远端历史失败')
          return
        }
      } finally {
        setSyncing(false)
        onRefresh()
      }
    }
    setView('history')
  }, [actions, onRefresh, repository.repositoryId, repository.upstream, syncing])

  /** 把冲突交给当前 Agent 会话处理。 */
  const handleResolveConflicts = React.useCallback(async (conflictPaths: string[]) => {
    const message = buildConflictAgentMessage(
      repository.displayName,
      repository.branch,
      syncError,
      conflictPaths,
    )
    try {
      await actions.sendMessage(message)
      toast.success('已交给 Agent 处理')
      onRefresh()
    } catch {
      // 会话未运行时 queueAgentMessage 会失败：降级为复制指令到剪贴板，用户启动会话后粘贴即可
      let copied = false
      try {
        await navigator.clipboard.writeText(message)
        copied = true
      } catch {
        copied = false
      }
      toast.error(copied
        ? '会话未运行，无法直接发送，指令已复制到剪贴板，启动会话后粘贴发送'
        : '会话未运行，无法直接发送，且复制失败，请手动复制指令')
    }
  }, [actions, onRefresh, repository.branch, repository.displayName, syncError])

  const handleCheckout = React.useCallback(async (branch: string) => {
    const result = await actions.checkout(repository.repositoryId, branch)
    if (result.ok) {
      toast.success(`已切换到 ${branch}`)
      onRefresh()
    } else {
      toast.error(result.message ?? '切换分支失败')
    }
  }, [actions, repository.repositoryId, onRefresh])

  const handleStagePaths = React.useCallback((paths: string[], action: 'stage' | 'unstage') => {
    void runAndRefresh(() => actions.stage(repository.repositoryId, paths, action))
  }, [actions, repository.repositoryId, runAndRefresh])

  const handleDiscardPath = React.useCallback((change: GitWorkspaceFileChange) => {
    void runAndRefresh(() => actions.discard(repository.repositoryId, [change.relativePath], change.layer))
  }, [actions, repository.repositoryId, runAndRefresh])

  const handleDiscardAllUnstaged = React.useCallback(() => {
    const paths = gitWorkspaceDiscardablePaths(repository)
    if (paths.length === 0) return
    const confirmed = window.confirm(
      `确定要放弃全部 ${paths.length} 个未暂存的已跟踪文件变更吗？此操作不可撤销。`,
    )
    if (!confirmed) return
    void runAndRefresh(() => actions.discard(repository.repositoryId, paths, 'unstaged'))
  }, [actions, repository, runAndRefresh])

  const [commitMessage, setCommitMessage] = React.useState('')
  const [commitPush, setCommitPush] = React.useState(false)
  const [committing, setCommitting] = React.useState(false)

  const handleCommit = React.useCallback(async (push: boolean) => {
    if (committing || !hasCommitable || !commitMessage.trim()) return
    setCommitting(true)
    try {
      const result = await actions.commit(repository.repositoryId, commitMessage, push)
      if (result.ok) {
        toast.success(push ? '已提交并推送' : '已提交')
        setCommitMessage('')
        onRefresh()
      } else {
        toast.error(result.message ?? '提交失败')
      }
    } finally {
      setCommitting(false)
    }
  }, [actions, commitMessage, committing, onRefresh, repository.repositoryId])

  const hasCommitable = repository.staged.length > 0 || repository.unborn

  return (
    <section className="border-b border-border/40 last:border-b-0">
      {multipleRepositories && (
        <div className="truncate border-b border-border/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground" title={repository.displayName}>
          {repository.displayName}
        </div>
      )}
      {view === 'history' ? (
        <HistoryView
          repositoryId={repository.repositoryId}
          onBack={() => setView('changes')}
          onOpenCommitDiff={(oid, relativePath) => onGitCommitFileClick?.(repository.repositoryId, oid, relativePath)}
          actions={actions}
        />
      ) : (
        <>
          <GitWorkspaceSummary
            repository={repository}
            loading={loading || syncing}
            onRefresh={() => void handleRefresh()}
            onBranches={() => actions.branches(repository.repositoryId)}
            onCheckout={handleCheckout}
            onSync={() => void handleSync()}
            onOpenHistory={() => void handleOpenHistory()}
          />
      {syncError && (
        <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-all">{syncError}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 transition-colors hover:opacity-80"
            onClick={() => void handleResolveConflicts(repository.conflicts.map((c) => c.relativePath))}
          >
            让 Agent 解决
          </button>
          <button
            type="button"
            aria-label="关闭错误提示"
            className="shrink-0 text-muted-foreground/60 transition-colors hover:text-destructive"
            onClick={() => setSyncError(null)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {/* 提交框 — 常驻文件列表顶部；没有可提交内容时禁用按钮而非隐藏 */}
      <div className="border-b border-border/40 px-3 py-2">
        <textarea
          className="w-full resize-none rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs outline-none focus:border-primary/50 min-h-[56px] placeholder:text-muted-foreground/50"
          placeholder={repository.unborn ? '首次提交信息…' : '提交信息（Ctrl+Enter 提交）…'}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && hasCommitable && commitMessage.trim()) {
              e.preventDefault()
              void handleCommit(commitPush)
            }
          }}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={commitPush}
              onChange={(e) => setCommitPush(e.target.checked)}
              className="size-3"
            />
            提交并推送
          </label>
          {!hasCommitable && !committing && (
            <span className="text-[10px] text-muted-foreground/60">暂存变更后可提交</span>
          )}
          <button
            type="button"
            disabled={!hasCommitable || !commitMessage.trim() || committing}
            onClick={() => void handleCommit(commitPush)}
            className="ml-auto rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {committing ? '提交中…' : '提交'}
          </button>
        </div>
      </div>
      {groups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.layer)
        return (
        <div key={group.layer}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => toggleGroupCollapsed(group.layer)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleGroupCollapsed(group.layer)
              }
            }}
            className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04]"
          >
            <ChevronRight className={cn('size-3 shrink-0 transition-transform', !isCollapsed && 'rotate-90')} />
            <span>{group.label}</span>
            <span className="tabular-nums text-muted-foreground/60">{group.files.length}</span>
            {group.layer === 'unstaged' ? (
              <span className="ml-auto flex items-center gap-0.5">
                <Tooltip delayDuration={400}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="放弃所有未暂存的更改"
                      className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); handleDiscardAllUnstaged() }}
                    >
                      <Undo2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">放弃所有未暂存的更改</TooltipContent>
                </Tooltip>
                <Tooltip delayDuration={400}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="暂存所有更改"
                      className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                      onClick={(e) => { e.stopPropagation(); handleStagePaths(group.files.map((f) => f.relativePath), 'stage') }}
                    >
                      <ArrowUpToLine className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">暂存所有更改</TooltipContent>
                </Tooltip>
              </span>
            ) : group.layer === 'untracked' ? (
              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="暂存所有未跟踪文件"
                    className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); handleStagePaths(group.files.map((f) => f.relativePath), 'stage') }}
                  >
                    <ArrowUpToLine className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">暂存所有未跟踪文件</TooltipContent>
              </Tooltip>
            ) : group.layer === 'staged' ? (
              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="取消暂存所有更改"
                    className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); handleStagePaths(group.files.map((f) => f.relativePath), 'unstage') }}
                  >
                    <ArrowDownToLine className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">取消暂存所有更改</TooltipContent>
              </Tooltip>
            ) : group.layer === 'conflict' ? (
              <button
                type="button"
                className="ml-auto text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); void handleResolveConflicts(group.files.map((f) => f.relativePath)) }}
              >
                让 Agent 解决
              </button>
            ) : null}
          </div>
          {!isCollapsed && group.files.map((change) => (
            <GitWorkspaceFileRow
              key={`${group.layer}:${change.relativePath}`}
              change={change}
              selected={selectedFilePath === change.relativePath}
              onClick={() => onFileClick(change)}
              onOpenTerminal={() => onOpenTerminal(change.relativePath)}
              onStage={group.layer === 'unstaged' || group.layer === 'untracked'
                ? () => handleStagePaths([change.relativePath], 'stage')
                : undefined}
              onUnstage={group.layer === 'staged' ? () => handleStagePaths([change.relativePath], 'unstage') : undefined}
              onDiscard={group.layer !== 'conflict' ? () => handleDiscardPath(change) : undefined}
            />
          ))}
        </div>
        )
      })}
        </>
      )}
    </section>
  )
}

function GitWorkspaceFileRow({
  change,
  selected,
  onClick,
  onOpenTerminal,
  onStage,
  onUnstage,
  onDiscard,
}: {
  change: GitWorkspaceFileChange
  selected: boolean
  onClick: () => void
  onOpenTerminal: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
}): React.ReactElement {
  const parts = change.relativePath.split('/')
  const name = parts.pop() || change.relativePath
  const parent = parts.join('/')
  const statusLabelClass = GIT_STATUS_LABEL_CLASS[change.status]
  const deleted = change.status === 'deleted'
  return (
    <Tooltip delayDuration={700}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            'group flex h-9 w-full items-center gap-2 px-3 text-left transition-colors',
            selected ? 'session-item-selected bg-primary/10' : 'hover:bg-primary/5',
          )}
        >
          <FileTypeIcon name={name} isDirectory={false} size={16} />
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', deleted && 'line-through opacity-60')}>{name}</span>
          {parent && <span className={cn('max-w-[36%] truncate text-[10px] text-muted-foreground/70', deleted && 'line-through opacity-60')}>{parent}</span>}
          {(change.additions > 0 || change.deletions > 0) && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
              {change.additions > 0 ? `+${change.additions}` : ''}{change.additions > 0 && change.deletions > 0 ? ' ' : ''}{change.deletions > 0 ? `-${change.deletions}` : ''}
            </span>
          )}
          <span className={cn('w-3 shrink-0 text-center text-[11px] font-semibold group-hover:hidden', statusLabelClass)}>{getGitChangeStatusMarker(change.status)}</span>
          <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                  onClick={(event) => { event.stopPropagation(); onOpenTerminal() }}
                >
                  <SquareTerminal className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">在 Domi 终端打开所在目录</TooltipContent>
            </Tooltip>
            {onStage && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); onStage() }}
                  >
                    <ArrowUpToLine className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">暂存</TooltipContent>
              </Tooltip>
            )}
            {onUnstage && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                    onClick={(e) => { e.stopPropagation(); onUnstage() }}
                  >
                    <ArrowDownToLine className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">取消暂存</TooltipContent>
              </Tooltip>
            )}
            {onDiscard && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`确定要丢弃 ${change.relativePath} 的变更吗？此操作不可撤销。`)) {
                        onDiscard()
                      }
                    }}
                  >
                    <Undo2 className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{change.layer === 'untracked' ? '删除文件' : '丢弃变更'}</TooltipContent>
              </Tooltip>
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[420px] break-all">
        {change.relativePath} · {change.layer}
      </TooltipContent>
    </Tooltip>
  )
}

function HistoryView({
  repositoryId,
  onBack,
  onOpenCommitDiff,
  actions,
}: {
  repositoryId: string
  onBack: () => void
  onOpenCommitDiff: (oid: string, relativePath: string) => void
  actions: GitPanelActions
}): React.ReactElement {
  const [entries, setEntries] = React.useState<GitWorkspaceLogEntry[] | null>(null)
  const [expandedOid, setExpandedOid] = React.useState<string | null>(null)
  const [commitFiles, setCommitFiles] = React.useState<GitWorkspaceCommitFileEntry[] | null>(null)
  const [loadingFiles, setLoadingFiles] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void actions.history(repositoryId, 30).then((result) => {
      if (!cancelled) setEntries(result.entries)
    })
    return () => { cancelled = true }
  }, [repositoryId, actions])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" /> 返回改动列表
        </button>
      </div>
      {!entries ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">加载历史…</div>
      ) : entries.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无提交</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {entries.map((entry) => (
            <div key={entry.oid} className="border-b border-border/30">
              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-primary/5"
                    onClick={() => {
                      if (expandedOid === entry.oid) {
                        setExpandedOid(null)
                        return
                      }
                      setExpandedOid(entry.oid)
                      setLoadingFiles(true)
                      void actions.commitFiles(repositoryId, entry.oid).then((result) => {
                        setCommitFiles(result.files)
                        setLoadingFiles(false)
                      })
                    }}
                  >
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <span className="flex shrink-0 items-center">
                          {entry.onRemote
                            ? <Cloud className="size-3.5 text-muted-foreground/60" />
                            : <Laptop className="size-3.5 text-muted-foreground/60" />}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {entry.onRemote ? '已推送' : '仅本地'}
                      </TooltipContent>
                    </Tooltip>
                    <span className="min-w-0 flex-1 truncate text-xs">{entry.subject}</span>
                    {tagBadges(entry).map((tag) => (
                      <span
                        key={tag}
                        className="shrink-0 rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium text-amber-500"
                      >
                        {tag}
                      </span>
                    ))}
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">{relativeTime(entry.authorDate)}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[420px] break-all">
                  <div className="space-y-1">
                    <div className="font-mono text-[10px]">{entry.oid}</div>
                    <div className="text-xs font-medium">{entry.subject}</div>
                    {entry.body && (
                      <div className="whitespace-pre-line text-[11px] leading-snug text-muted-foreground">
                        {entry.body}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground">
                      {entry.authorName} &lt;{entry.authorEmail}&gt;
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(entry.authorDate * 1000).toLocaleString()}
                    </div>
                    {(() => {
                      const namedRefs = entry.refs
                        .filter((ref) => ref.kind !== 'tag')
                        .map((ref) => ref.name)
                      if (namedRefs.length === 0) return null
                      return (
                        <div className="text-[10px] text-muted-foreground">
                          分支: {namedRefs.join(' / ')}
                        </div>
                      )
                    })()}
                    {entry.parents.length > 0 && (
                      <div className="text-[10px] text-muted-foreground">
                        父提交: {entry.parents.map((parent) => parent.slice(0, 7)).join(', ')}
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
              {expandedOid === entry.oid && (
                <div className="px-4 pb-2">
                  {loadingFiles ? (
                    <div className="text-[10px] text-muted-foreground">加载文件…</div>
                  ) : (
                    (commitFiles ?? []).map((file) => (
                      <button
                        key={file.relativePath}
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-primary/5"
                        onClick={() => onOpenCommitDiff(entry.oid, file.relativePath)}
                      >
                        <FileTypeIcon name={file.relativePath.split('/').pop() ?? file.relativePath} isDirectory={false} size={13} />
                        <span className="min-w-0 flex-1 truncate">{file.relativePath}</span>
                        <span className="shrink-0 text-[9px] text-muted-foreground/60">{file.status}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function NonGitChangesList({
  changes,
  currentRunId,
  sessionId,
  selectedFilePath,
  onFileClick,
}: {
  changes: SessionFileChange[]
  currentRunId?: string
  sessionId: string
  selectedFilePath?: string
  onFileClick?: (filePath: string) => void
}): React.ReactElement {
  const { current, earlier } = groupSessionFileChanges(changes, currentRunId)
  const hasEarlierChanges = earlier.length > 0

  return (
    <div className="shrink-0 py-1">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-muted-foreground tabular-nums">
        <Box className="size-3.5 shrink-0" />
        <span>本会话文件变更 · {changes.length}</span>
      </div>
      {hasEarlierChanges ? (
        <>
          {current.length > 0 && (
            <NonGitRunGroup
              title="本轮"
              changes={current}
              sessionId={sessionId}
              selectedFilePath={selectedFilePath}
              onFileClick={onFileClick}
            />
          )}
          <NonGitRunGroup
            title="更早"
            changes={earlier}
            sessionId={sessionId}
            selectedFilePath={selectedFilePath}
            onFileClick={onFileClick}
          />
        </>
      ) : (
        <NonGitFileList
          changes={current}
          sessionId={sessionId}
          selectedFilePath={selectedFilePath}
          onFileClick={onFileClick}
        />
      )}
    </div>
  )
}

function NonGitRunGroup({
  title,
  changes,
  sessionId,
  selectedFilePath,
  onFileClick,
}: {
  title: string
  changes: SessionFileChange[]
  sessionId: string
  selectedFilePath?: string
  onFileClick?: (filePath: string) => void
}): React.ReactElement {
  return (
    <section className="pb-2">
      <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground tabular-nums">
        {title} · {changes.length}
      </div>
      <NonGitFileList
        changes={changes}
        sessionId={sessionId}
        selectedFilePath={selectedFilePath}
        onFileClick={onFileClick}
      />
    </section>
  )
}

function NonGitFileList({
  changes,
  sessionId,
  selectedFilePath,
  onFileClick,
}: {
  changes: SessionFileChange[]
  sessionId: string
  selectedFilePath?: string
  onFileClick?: (filePath: string) => void
}): React.ReactElement {
  return (
    <div>
      {changes.map((change) => {
        const parts = change.path.split('/')
        const name = parts.pop() || change.path
        const parent = parts.join('/')
        const isSelected = selectedFilePath === change.path
        return (
          <div
            key={change.path}
            className={cn(
              'group flex h-9 items-center transition-colors',
              isSelected ? 'session-item-selected bg-primary/10' : 'hover:bg-primary/5',
            )}
          >
            <Tooltip delayDuration={700}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onFileClick?.(change.path)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm"
                >
                  <FileTypeIcon name={name} isDirectory={false} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
                  {parent && <span className="max-w-[40%] truncate text-[11px] text-muted-foreground">{parent}</span>}
                  {change.kind === 'created' && (
                    <span className="shrink-0 rounded-sm bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">
                      新建
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[400px] break-all">{change.path}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="在文件夹中显示"
                  onClick={() => {
                    const request = createSessionTargetFileRequest(sessionId, change.path)
                    if (request) window.electronAPI.showSessionTargetInFolder(request).catch(console.error)
                  }}
                  className="mr-1 flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                >
                  <FolderSearch className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">在文件夹中显示</TooltipContent>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}

/** 已追踪文件的行 */
function FileRow({
  file,
  onClick,
  onRevert,
  isSelected,
  isUnseen,
  dirPath,
}: {
  file: ChangedFileEntry
  onClick: () => void
  onRevert: () => void
  isSelected?: boolean
  isUnseen?: boolean
  dirPath: string
}): React.ReactElement {
  const parts = file.filePath.split('/')
  const fileName = parts.pop()!
  const dir = parts.join('/')
  const fullPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex items-center w-full px-2 pl-3 h-[36px] text-[14px] transition-colors group',
        isSelected
          ? 'session-item-selected bg-primary/10 shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
          : 'hover:bg-primary/5',
      )}
      onClick={onClick}
    >
      <span className="w-3 shrink-0 flex items-center justify-center">
        {isUnseen && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <FileTypeIcon name={fileName} isDirectory={false} size={16} />
      <Tooltip delayDuration={900}>
        <TooltipTrigger asChild>
          <span className="ml-1.5 truncate flex items-baseline gap-1.5 min-w-0">
            <span className="shrink-0">
              {fileName}
              {file.status === 'deleted' && (
                <span className="ml-1 text-foreground/30 text-[12px]">(已删除)</span>
              )}
            </span>
            {dir && (
              <span className="text-[11px] text-foreground/30 truncate">{dir}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all">{fullPath}</TooltipContent>
      </Tooltip>

      {/* +/- 行数 — hover 时隐藏让位给操作按钮 */}
      <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[13px] group-hover:hidden">
        {file.additions > 0 && (
          <span style={{ color: 'rgb(34 197 94)' }}>+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span style={{ color: 'rgb(239 68 68)' }}>-{file.deletions}</span>
        )}
      </span>

      {/* Hover 操作按钮 */}
      <span className="ml-auto shrink-0 hidden group-hover:flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="p-0.5 rounded hover:bg-foreground/[0.08] text-foreground/40 hover:text-foreground/70 cursor-pointer"
              onClick={onRevert}
            >
              <Undo2 className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">还原文件变更</TooltipContent>
        </Tooltip>
      </span>
    </div>
  )
}

/** 未追踪文件的行 */
function UntrackedFileRow({
  file,
  onClick,
}: {
  file: UntrackedFileEntry
  onClick: () => void
}): React.ReactElement {
  const filePath = file.filePath
  const parts = filePath.split('/')
  const fileName = parts.pop()!
  const dir = parts.join('/')
  const fullPath = `${file.gitRoot}/${file.filePath}`.replace(/\/+/g, '/')

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex items-center w-full px-2 pl-6 h-[36px] text-[14px] hover:bg-foreground/[0.04] transition-colors"
      onClick={onClick}
    >
      <FileTypeIcon name={fileName} isDirectory={false} size={16} />
      <Tooltip delayDuration={900}>
        <TooltipTrigger asChild>
          <span className="ml-1.5 truncate flex items-baseline gap-1.5 min-w-0">
            <span className="shrink-0">{fileName}</span>
            {dir && (
              <span className="text-[11px] text-foreground/30 truncate">{dir}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all">{fullPath}</TooltipContent>
      </Tooltip>
      <span className="ml-1.5 rounded px-1 py-0.5 text-[12px] leading-none shrink-0 bg-amber-500/10 text-amber-500">
        新文件
      </span>
    </div>
  )
}
