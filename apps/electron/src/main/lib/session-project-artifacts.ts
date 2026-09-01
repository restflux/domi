import { isAbsolute, posix, win32 } from 'node:path'
import type { ManagedCheckoutRecord } from './session-checkout/ports.ts'

export interface CollectSessionProjectArtifactPathsInput {
  sessionId: string
  checkoutRecords: readonly ManagedCheckoutRecord[]
  /** 当前会话继承或绑定但不拥有的 checkout，也属于该会话当前可见产物范围。 */
  boundCheckoutIds?: ReadonlySet<string>
  checkpointPaths: readonly string[]
  currentChangedPaths: readonly string[]
  deletedPaths: readonly string[]
}

function normalizeProjectRelativePath(value: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const slashPath = value.trim().replace(/\\/g, '/')
  if (isAbsolute(slashPath) || win32.isAbsolute(value)) return null
  const normalized = posix.normalize(slashPath).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

function recordChangedFiles(record: ManagedCheckoutRecord): string[] {
  const paths: string[] = []
  if (record.previousReview) paths.push(...record.previousReview.changedFiles)
  for (const checkpoint of record.checkpoints ?? []) paths.push(...checkpoint.changedFiles)

  const delivery = record.delivery
  if (delivery.state === 'ready_for_review'
    || delivery.state === 'preview_active'
    || delivery.state === 'preview_detached'
    || delivery.state === 'finalized'
    || delivery.state === 'retained') {
    paths.push(...delivery.review.changedFiles)
  }
  if (delivery.state === 'delivered' || delivery.state === 'finalized' || delivery.state === 'retained') {
    paths.push(...(delivery.proof?.changedFiles ?? []))
  }
  return paths
}

/**
 * 汇总一个会话曾产生或修改的项目相对路径。
 *
 * 所有持久记录都按不可信历史输入处理：只接受规范的项目相对路径，避免产物列表扩大文件授权范围。
 */
export function collectSessionProjectArtifactPaths(
  input: CollectSessionProjectArtifactPathsInput,
): string[] {
  const deleted = new Set(
    input.deletedPaths
      .map(normalizeProjectRelativePath)
      .filter((path): path is string => path !== null),
  )
  const paths = new Set<string>()
  const add = (value: string): void => {
    const normalized = normalizeProjectRelativePath(value)
    if (normalized && !deleted.has(normalized)) paths.add(normalized)
  }

  for (const value of input.checkpointPaths) add(value)
  for (const value of input.currentChangedPaths) add(value)
  for (const record of input.checkoutRecords) {
    if (record.ownerSessionId !== input.sessionId && !input.boundCheckoutIds?.has(record.checkoutId)) continue
    for (const value of recordChangedFiles(record)) add(value)
  }

  return [...paths].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}
