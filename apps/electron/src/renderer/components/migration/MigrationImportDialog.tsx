import * as React from 'react'
import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import {
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  migrationImportDialogOpenAtom,
  migrationImportInitialFilePathAtom,
} from '@/atoms/migration-atoms'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { useMigrationImport } from '@/hooks/useMigrationImport'
import type { WorkspaceImportMapping, WorkspaceImportPreviewItem } from '@/hooks/useMigrationImport'
import { MigrationPathMappingRow } from './MigrationPathMappingRow'

export function MigrationImportDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(migrationImportDialogOpenAtom)
  const [initialFilePath, setInitialFilePath] = useAtom(migrationImportInitialFilePathAtom)
  const localWorkspaces = useAtomValue(agentWorkspacesAtom)

  const {
    importing,
    importPreview,
    pathMappings,
    workspaceMappings,
    conflictResolution,
    hasConflicts,
    importConfirming,
    importResult,
    handleSelectImportFile,
    handleConfirmImport,
    handlePathMapping,
    handleWorkspaceMapping,
    handleSelectProjectDirectory,
    setConflictResolution,
    reset,
  } = useMigrationImport(open ? initialFilePath : null)

  React.useEffect(() => {
    const unsub = window.electronAPI.onMigrationOpenImportFile(({ filePath }) => {
      setInitialFilePath(filePath)
      setOpen(true)
    })
    return unsub
  }, [setInitialFilePath, setOpen])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      reset()
      setInitialFilePath(null)
    }
    setOpen(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>导入配置</DialogTitle>
          <DialogDescription>
            支持 .domi-backup/.domi-share，也可显式导入旧 .domi-backup/.domi-share
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* 阶段 1：选择文件 */}
          {!importPreview && !importResult?.success && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                <FolderOpen size={28} className="text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground text-center">
                选择 Domi 迁移文件或兼容的旧版迁移文件开始导入
              </p>
              <button
                onClick={handleSelectImportFile}
                disabled={importing}
                className={cn(
                  'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {importing ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
                {importing ? '解析中...' : '选择文件'}
              </button>

              {importResult && !importResult.success && (
                <div className="flex items-center gap-1.5 text-sm text-red-500">
                  <XCircle size={15} />
                  {importResult.error}
                </div>
              )}
            </div>
          )}

          {/* 阶段 2：预览 & 配置 */}
          {importPreview && (
            <div className="space-y-4">
              {/* 跨平台警告 */}
              {importPreview.crossPlatform && (
                <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 dark:bg-amber-950/20 dark:border-amber-800">
                  <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-amber-700 dark:text-amber-400">
                    <p className="font-medium">检测到跨平台迁移（{importPreview.manifest.sourcePlatform} → 当前系统）</p>
                    <p className="mt-0.5 text-amber-600 dark:text-amber-500">请为每个项目手动选择当前电脑上的目录。项目代码需要提前复制或克隆；不会自动沿用备份中的路径。</p>
                    <p className="mt-1 text-amber-600 dark:text-amber-500">MCP 和 Skills 中的平台专用命令、可执行文件及绝对路径需要手动调整；导入不会自动安装这些依赖。</p>
                  </div>
                </div>
              )}

              {/* 内容摘要 */}
              {importPreview.workspaces ? (
                <MigrationContentSummary
                  preview={importPreview}
                  workspaceMappings={workspaceMappings}
                  localWorkspaces={localWorkspaces}
                  onWorkspaceMapping={handleWorkspaceMapping}
                  onSelectProjectDirectory={handleSelectProjectDirectory}
                  disabled={importConfirming}
                  hasConflicts={hasConflicts}
                  conflictResolution={conflictResolution}
                  onConflictResolutionChange={setConflictResolution}
                />
              ) : (
                <V1ContentSummary preview={importPreview} />
              )}

              {/* 路径检查 */}
              {importPreview.pathCheckResults.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">附加目录与文件路径</p>
                  <div className="rounded-lg border border-border/50 divide-y divide-border/30">
                    {importPreview.pathCheckResults.map((r) => (
                      <MigrationPathMappingRow
                        key={r.path}
                        entry={r}
                        mapping={pathMappings[r.path]}
                        disabled={importConfirming}
                        onChange={handlePathMapping}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* 确认 / 取消 */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleConfirmImport}
                  disabled={importConfirming}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                    'bg-primary text-primary-foreground hover:bg-primary/90',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {importConfirming ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Upload size={16} />
                  )}
                  {importConfirming ? '导入中...' : '确认导入'}
                </button>
                <button
                  onClick={() => {
                    reset()
                    setInitialFilePath(null)
                  }}
                  disabled={importConfirming}
                  className="px-4 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  取消
                </button>
              </div>

              {importResult && !importResult.success && (
                <div className="flex items-center gap-1.5 text-sm text-red-500">
                  <XCircle size={15} />
                  {importResult.error}
                </div>
              )}
            </div>
          )}

          {/* 阶段 3：导入成功 */}
          {importResult?.success && !importPreview && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="w-16 h-16 rounded-2xl bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 size={28} className="text-green-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">导入成功</p>
                <p className="text-xs text-muted-foreground mt-1">请重启应用使所有更改生效</p>
              </div>
              <button
                onClick={() => handleOpenChange(false)}
                className={cn(
                  'px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  'bg-primary text-primary-foreground hover:bg-primary/90'
                )}
              >
                关闭
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── v1 内容摘要（原有逻辑）────────────────────────────────────────────────

function V1ContentSummary({ preview }: { preview: { manifest: { workspaceName?: string; exportedAt: number; components: string[] }; agentSessionCount: number; chatConversationCount: number; skillNames: string[]; hasMcp: boolean } }): React.ReactElement {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-2">
      <p className="text-sm font-medium text-foreground">
        包内容来自：{preview.manifest.workspaceName ?? '未知项目'}（
        {new Date(preview.manifest.exportedAt).toLocaleDateString('zh-CN')}）
      </p>
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-muted-foreground">
        {preview.agentSessionCount > 0 && (
          <span>Agent 会话：{preview.agentSessionCount} 个</span>
        )}
        {preview.chatConversationCount > 0 && (
          <span>Chat 对话：{preview.chatConversationCount} 个</span>
        )}
        {preview.skillNames.length > 0 && (
          <span>Skills：{preview.skillNames.length} 个</span>
        )}
        {preview.hasMcp && <span>MCP 配置：已包含</span>}
        {preview.manifest.components.includes('channels') && (
          <span>模型渠道：已包含</span>
        )}
        {preview.manifest.components.includes('chattools') && (
          <span>AI 工具：已包含</span>
        )}
      </div>
    </div>
  )
}

// ─── v2 多工作区内容摘要 ──────────────────────────────────────────────────

interface MigrationContentSummaryProps {
  preview: { manifest: { exportedAt: number; components: string[] }; agentSessionCount: number; chatConversationCount: number; workspaces?: WorkspaceImportPreviewItem[] }
  workspaceMappings: WorkspaceImportMapping[]
  localWorkspaces: Array<{ id: string; name: string; slug: string; projectRootPath?: string }>
  onWorkspaceMapping: (sourceSlug: string, mapping: Partial<WorkspaceImportMapping>) => void
  onSelectProjectDirectory: (sourceSlug: string) => Promise<void>
  disabled: boolean
  hasConflicts: boolean
  conflictResolution: 'overwrite' | 'skip'
  onConflictResolutionChange: (value: 'overwrite' | 'skip') => void
}

function MigrationContentSummary({ preview, workspaceMappings, localWorkspaces, onWorkspaceMapping, onSelectProjectDirectory, disabled, hasConflicts, conflictResolution, onConflictResolutionChange }: MigrationContentSummaryProps): React.ReactElement {
  const wsCount = preview.workspaces?.length ?? 0

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-2">
        <p className="text-sm font-medium text-foreground">
          包含 {wsCount} 个项目的配置（导出于 {new Date(preview.manifest.exportedAt).toLocaleDateString('zh-CN')}）
        </p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-muted-foreground">
          {preview.agentSessionCount > 0 && (
            <span>Agent 会话：{preview.agentSessionCount} 个</span>
          )}
          {preview.chatConversationCount > 0 && (
            <span>Chat 对话：{preview.chatConversationCount} 个</span>
          )}
          {preview.manifest.components.includes('channels') && (
            <span>模型渠道：已包含</span>
          )}
          {preview.manifest.components.includes('chattools') && (
            <span>AI 工具：已包含</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">项目导入方式</label>
        <div className="rounded-lg border border-border/50 divide-y divide-border/30">
          {(preview.workspaces ?? []).map((ws) => {
            const mapping = workspaceMappings.find((m) => m.sourceSlug === ws.workspaceSlug)
            const action = mapping?.action ?? 'create'
            const targetWorkspace = localWorkspaces.find((item) => item.id === mapping?.targetWorkspaceId)

            return (
              <div key={ws.workspaceSlug} className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  {ws.existsLocally ? (
                    <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium text-foreground">{ws.workspaceName}</span>
                  <span className="text-xs text-muted-foreground font-mono">{ws.workspaceSlug}</span>
                </div>
                <div className="flex items-center gap-4 pl-5 text-xs text-muted-foreground">
                  {ws.skillNames.length > 0 && <span>Skills: {ws.skillNames.length} 个</span>}
                  {ws.mcpServerNames.length > 0 && <span>MCP: {ws.mcpServerNames.length} 个</span>}
                  {((ws.conflictingSkills?.length ?? 0) > 0 || (ws.conflictingMcpServers?.length ?? 0) > 0) && (
                    <span className="text-amber-600 dark:text-amber-400">
                      冲突: {[
                        (ws.conflictingSkills?.length ?? 0) > 0 ? `${ws.conflictingSkills.length} 个 Skill` : '',
                        (ws.conflictingMcpServers?.length ?? 0) > 0 ? `${ws.conflictingMcpServers.length} 个 MCP` : '',
                      ].filter(Boolean).join('、')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 pl-5">
                  <span className="text-xs text-muted-foreground">操作：</span>
                  <select
                    value={action}
                    disabled={disabled}
                    onChange={(e) => {
                      const newAction = e.target.value as 'merge' | 'create' | 'skip'
                      if (newAction === 'merge') {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'merge', targetWorkspaceId: undefined })
                      } else if (newAction === 'create') {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'create' })
                      } else {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'skip' })
                      }
                    }}
                    className="text-xs border border-border rounded px-2 py-1 bg-background"
                  >
                    {localWorkspaces.length > 0 && (
                      <option value="merge">合并到现有项目...</option>
                    )}
                    <option value="create">创建新项目</option>
                    <option value="skip">跳过</option>
                  </select>

                  {action === 'merge' && (
                    <select
                      value={mapping?.targetWorkspaceId ?? ''}
                      disabled={disabled}
                      onChange={(e) => onWorkspaceMapping(ws.workspaceSlug, { action: 'merge', targetWorkspaceId: e.target.value })}
                      className="text-xs border border-border rounded px-2 py-1 bg-background"
                    >
                      <option value="">选择项目...</option>
                      {localWorkspaces.map((lw) => (
                        <option key={lw.id} value={lw.id}>{lw.name}</option>
                      ))}
                    </select>
                  )}
                </div>
                {action === 'create' && (
                  <div className="pl-5 space-y-2">
                    <label className="block text-xs text-muted-foreground">
                      项目名称
                      <input
                        value={mapping?.newWorkspaceName ?? ws.workspaceName}
                        disabled={disabled}
                        onChange={(event) => onWorkspaceMapping(ws.workspaceSlug, { newWorkspaceName: event.target.value })}
                        className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
                      />
                    </label>
                    <p className="text-xs text-muted-foreground break-all">
                      项目目录：{mapping?.projectRootPath ?? '未选择，将创建 Domi 管理的空白项目'}
                    </p>
                    <div className="flex items-center gap-3 text-xs">
                      <button type="button" disabled={disabled} onClick={() => onSelectProjectDirectory(ws.workspaceSlug)} className="text-primary hover:underline disabled:opacity-50">
                        选择本机项目目录
                      </button>
                      {mapping?.projectRootPath && (
                        <button type="button" disabled={disabled} onClick={() => onWorkspaceMapping(ws.workspaceSlug, { projectRootPath: undefined })} className="text-muted-foreground hover:underline disabled:opacity-50">
                          清除选择
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {action === 'merge' && targetWorkspace && (
                  <p className="pl-5 text-xs text-muted-foreground break-all">
                    使用所选项目的目录：{targetWorkspace.projectRootPath ?? 'Domi 管理的项目目录'}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {hasConflicts && (
        <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 dark:bg-amber-950/20 dark:border-amber-800">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              检测到同名 Skills / MCP 已存在于本地
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-600 dark:text-amber-500">冲突处理：</span>
              <select
                value={conflictResolution}
                onChange={(e) => onConflictResolutionChange(e.target.value as 'overwrite' | 'skip')}
                className="text-xs border border-amber-300 dark:border-amber-700 rounded px-2 py-1 bg-background"
              >
                <option value="overwrite">用导入版本覆盖本地（推荐）</option>
                <option value="skip">保留本地版本，跳过冲突项</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
