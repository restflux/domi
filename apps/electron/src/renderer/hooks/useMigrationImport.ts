import { useState, useEffect, useCallback } from 'react'
import { initialMigrationPathMappings } from '@/lib/migration-path-mappings'

type MigrationComponent = 'sessions' | 'skills' | 'mcp' | 'channels' | 'chattools'

interface PathCheckResult {
  path: string
  exists: boolean
}

export interface ImportPreview {
  manifest: {
    mode: string
    version?: string
    workspaceName?: string
    sourcePlatform: string
    exportedAt: number
    components: MigrationComponent[]
    workspaces?: Array<{
      workspaceSlug: string
      workspaceName: string
    }>
  }
  agentSessionCount: number
  chatConversationCount: number
  skillNames: string[]
  hasMcp: boolean
  crossPlatform: boolean
  pathCheckResults: PathCheckResult[]
  tempDir: string
  workspaces?: WorkspaceImportPreviewItem[]
}

export interface WorkspaceImportPreviewItem {
  workspaceSlug: string
  workspaceName: string
  skillNames: string[]
  mcpServerNames: string[]
  existsLocally: boolean
  localWorkspaceId?: string
  conflictingSkills: string[]
  conflictingMcpServers: string[]
}

export interface WorkspaceImportMapping {
  sourceSlug: string
  action: 'merge' | 'create' | 'skip'
  targetWorkspaceId?: string
  newWorkspaceName?: string
  projectRootPath?: string
}

interface UseMigrationImportReturn {
  importing: boolean
  importPreview: ImportPreview | null
  pathMappings: Record<string, string | null>
  workspaceMappings: WorkspaceImportMapping[]
  conflictResolution: 'overwrite' | 'skip'
  hasConflicts: boolean
  importConfirming: boolean
  importResult: { success: boolean; error?: string } | null
  handleSelectImportFile: () => Promise<void>
  handleConfirmImport: () => Promise<void>
  handlePathMapping: (originalPath: string, newValue: string | null) => void
  handleWorkspaceMapping: (sourceSlug: string, mapping: Partial<WorkspaceImportMapping>) => void
  handleSelectProjectDirectory: (sourceSlug: string) => Promise<void>
  setConflictResolution: (value: 'overwrite' | 'skip') => void
  reset: () => void
}

export function useMigrationImport(initialFilePath?: string | null): UseMigrationImportReturn {
  const [importing, setImporting] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [pathMappings, setPathMappings] = useState<Record<string, string | null>>({})
  const [workspaceMappings, setWorkspaceMappings] = useState<WorkspaceImportMapping[]>([])
  const [conflictResolution, setConflictResolution] = useState<'overwrite' | 'skip'>('overwrite')
  const [importConfirming, setImportConfirming] = useState(false)
  const [importResult, setImportResult] = useState<{ success: boolean; error?: string } | null>(null)

  const hasConflicts = importPreview?.workspaces?.some((ws) => {
    const mapping = workspaceMappings.find((m) => m.sourceSlug === ws.workspaceSlug)
    if (!mapping || mapping.action !== 'merge') return false
    return (ws.conflictingSkills?.length ?? 0) > 0 || (ws.conflictingMcpServers?.length ?? 0) > 0
  }) ?? false

  const initFromPreview = useCallback((preview: ImportPreview) => {
    setPathMappings(initialMigrationPathMappings(preview.pathCheckResults))

    if (preview.workspaces) {
      const mappings: WorkspaceImportMapping[] = preview.workspaces.map((ws) => ({
        sourceSlug: ws.workspaceSlug,
        action: 'create',
        newWorkspaceName: ws.existsLocally ? `${ws.workspaceName}（导入）` : ws.workspaceName,
      }))
      setWorkspaceMappings(mappings)
    } else {
      setWorkspaceMappings([])
    }

    setImportPreview(preview)
  }, [])

  const parseFile = useCallback(async (filePath: string) => {
    setImporting(true)
    setImportPreview(null)
    setImportResult(null)

    try {
      const preview = await window.electronAPI.migrationParseImportFile(filePath) as ImportPreview
      initFromPreview(preview)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '解析文件失败' })
    } finally {
      setImporting(false)
    }
  }, [initFromPreview])

  useEffect(() => {
    if (initialFilePath) {
      parseFile(initialFilePath)
    }
  }, [initialFilePath, parseFile])

  const handleSelectImportFile = useCallback(async () => {
    setImporting(true)
    setImportPreview(null)
    setImportResult(null)

    try {
      const filePath = await window.electronAPI.migrationOpenFileDialog()
      if (!filePath) {
        setImporting(false)
        return
      }
      const preview = await window.electronAPI.migrationParseImportFile(filePath) as ImportPreview
      initFromPreview(preview)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '解析文件失败' })
    } finally {
      setImporting(false)
    }
  }, [initFromPreview])

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview) return
    setImportConfirming(true)

    try {
      await window.electronAPI.migrationConfirmImport({
        tempDir: importPreview.tempDir,
        manifest: importPreview.manifest,
        pathMappings,
        conflictResolution: hasConflicts ? conflictResolution : undefined,
        workspaceMappings,
      })
      setImportResult({ success: true })
      setImportPreview(null)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setImportConfirming(false)
    }
  }, [importPreview, pathMappings, workspaceMappings, conflictResolution, hasConflicts])

  const handlePathMapping = useCallback((originalPath: string, newValue: string | null) => {
    setPathMappings((prev) => ({ ...prev, [originalPath]: newValue }))
  }, [])

  const handleWorkspaceMapping = useCallback((sourceSlug: string, partial: Partial<WorkspaceImportMapping>) => {
    setWorkspaceMappings((prev) =>
      prev.map((m) => (m.sourceSlug === sourceSlug ? { ...m, ...partial } : m))
    )
  }, [])

  const handleSelectProjectDirectory = useCallback(async (sourceSlug: string) => {
    try {
      const folder = await window.electronAPI.openFolderDialog()
      if (folder) handleWorkspaceMapping(sourceSlug, { projectRootPath: folder.path })
    } catch (error) {
      setImportResult({ success: false, error: error instanceof Error ? error.message : '选择项目目录失败' })
    }
  }, [handleWorkspaceMapping])

  const reset = useCallback(() => {
    // 清理主进程中的临时解压目录
    if (importPreview?.tempDir) {
      window.electronAPI.migrationCancelImport(importPreview.tempDir).catch(() => {})
    }
    setImporting(false)
    setImportPreview(null)
    setPathMappings({})
    setWorkspaceMappings([])
    setConflictResolution('overwrite')
    setImportConfirming(false)
    setImportResult(null)
  }, [importPreview?.tempDir])

  return {
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
  }
}
