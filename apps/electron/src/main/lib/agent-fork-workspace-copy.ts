import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

const FORK_WORKSPACE_COPY_BLOCKLIST = new Set([
  '.claude',
  '.DS_Store',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  'coverage',
  'target',
])

export interface ForkWorkspaceCopyResult {
  copiedCount: number
  skippedCount: number
  failedCount: number
}

export function shouldCopyForkWorkspacePath(src: string): boolean {
  return !FORK_WORKSPACE_COPY_BLOCKLIST.has(basename(src))
}

export interface ForkWorkspaceCopyOptions {
  /** `.context` 由 copyRequiredForkSessionContext 先原子复制时启用。 */
  skipSessionContext?: boolean
}

/**
 * 将会话级 `.context` 作为 Fork 的必需 artifact 原子迁移。
 * 先复制到目标目录内的 staging，再同盘 rename；失败时不留下部分 `.context`。
 */
export function copyRequiredForkSessionContext(sourceDir: string, destDir: string): boolean {
  const sourceContext = join(sourceDir, '.context')
  if (!existsSync(sourceContext)) return false
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const destContext = join(destDir, '.context')
  const initializedEmptyContext = existsSync(destContext)
    && lstatSync(destContext).isDirectory()
    && readdirSync(destContext).length === 0
  if (existsSync(destContext) && !initializedEmptyContext) {
    throw new Error('Fork 目标会话已存在非空 .context，拒绝覆盖')
  }
  const stagingContext = join(destDir, `.context.fork-staging-${randomUUID()}`)
  try {
    cpSync(sourceContext, stagingContext, { recursive: true, errorOnExist: true })
    // createAgentSession 会预建空 .context；它不是用户内容，可在发布前安全替换。
    if (initializedEmptyContext) rmSync(destContext, { recursive: true, force: false })
    renameSync(stagingContext, destContext)
    return true
  } catch (error) {
    rmSync(stagingContext, { recursive: true, force: true })
    // 保持新会话初始化契约，避免单独调用时留下缺失的 .context。
    if (initializedEmptyContext && !existsSync(destContext)) mkdirSync(destContext, { recursive: true })
    throw error
  }
}

export function copyForkWorkspaceFiles(
  sourceDir: string,
  destDir: string,
  options: ForkWorkspaceCopyOptions = {},
): ForkWorkspaceCopyResult {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const result: ForkWorkspaceCopyResult = {
    copiedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  }

  const entries = readdirSync(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(sourceDir, entry.name)
    const destPath = join(destDir, entry.name)

    if ((options.skipSessionContext && entry.name === '.context') || !shouldCopyForkWorkspacePath(srcPath)) {
      result.skippedCount += 1
      continue
    }

    try {
      cpSync(srcPath, destPath, {
        recursive: true,
        filter: shouldCopyForkWorkspacePath,
      })
      result.copiedCount += 1
    } catch (err) {
      result.failedCount += 1
      console.warn(`[Agent 会话] fork 工作区条目复制失败，已跳过 (${srcPath}):`, err)
    }
  }

  return result
}
