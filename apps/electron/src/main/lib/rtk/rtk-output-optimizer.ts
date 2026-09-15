import type { RtkSkipReason } from '@domi/shared'
import type { RtkFilter } from './rtk-command-filter.ts'
import { RTK_MAX_INPUT_BYTES } from './rtk-process.ts'

export interface RtkOptimizerDependencies {
  isActive?(): boolean
  filter(name: RtkFilter, text: string, signal?: AbortSignal): Promise<string | undefined>
  saveOriginal(text: string): Promise<string>
  /** 与实际 UUID 文件路径等长，用于在保存前核算引用成本。 */
  originalPathHint?: string
  record(originalBytes: number, returnedBytes: number): void
  skip?(reason: RtkSkipReason): void
}

function reference(path: string): string {
  return `\n\n[RTK 已优化输出；完整原文可用 Read 读取：${JSON.stringify(path)}]`
}

export async function optimizeRtkOutput(
  filter: RtkFilter, text: string, dependencies: RtkOptimizerDependencies, signal?: AbortSignal,
): Promise<{ text: string; originalPath: string } | undefined> {
  const active = (): boolean => !signal?.aborted && (dependencies.isActive?.() ?? true)
  const skip = (reason: RtkSkipReason): undefined => { dependencies.skip?.(reason); return undefined }
  const originalBytes = Buffer.byteLength(text)
  if (!active()) return skip('ineligible')
  if (originalBytes > RTK_MAX_INPUT_BYTES) return skip('output-limit')
  if (!text.trim()) return skip('no-gain')
  try {
    const filtered = await dependencies.filter(filter, text, signal)
    if (!active()) return skip('ineligible')
    if (filtered === undefined) return skip('unavailable')
    if (!filtered.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(filtered)) return skip('no-gain')
    if (Buffer.byteLength(filtered + reference(dependencies.originalPathHint ?? '')) >= originalBytes) return skip('no-gain')
    const originalPath = await dependencies.saveOriginal(text)
    if (!active()) return skip('ineligible')
    const returned = filtered + reference(originalPath)
    const returnedBytes = Buffer.byteLength(returned)
    if (returnedBytes >= originalBytes) return skip('no-gain')
    dependencies.record(originalBytes, returnedBytes)
    return { text: returned, originalPath }
  } catch {
    // 原命令已执行；任何后处理错误只能回退现有结果，不能重试命令。
    return skip('unavailable')
  }
}
