import type { RtkFilter } from './rtk-command-filter.ts'
import { RTK_MAX_INPUT_BYTES } from './rtk-service.ts'

export interface RtkOptimizerDependencies {
  isActive?(): boolean
  filter(name: RtkFilter, text: string, signal?: AbortSignal): Promise<string | undefined>
  saveOriginal(text: string): Promise<string>
  record(originalBytes: number, returnedBytes: number): void
}

export async function optimizeRtkOutput(
  filter: RtkFilter, text: string, dependencies: RtkOptimizerDependencies, signal?: AbortSignal,
): Promise<{ text: string; originalPath: string } | undefined> {
  const active = (): boolean => !signal?.aborted && (dependencies.isActive?.() ?? true)
  const originalBytes = Buffer.byteLength(text)
  if (!active() || originalBytes < 1024 || originalBytes > RTK_MAX_INPUT_BYTES) return
  try {
    const filtered = await dependencies.filter(filter, text, signal)
    if (!filtered?.trim() || !active() || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(filtered)) return
    // 给原文引用留足余量；最终仍按实际返回长度核算，绝不为了“成功”增加上下文。
    if (Buffer.byteLength(filtered) + 256 >= originalBytes) return
    const originalPath = await dependencies.saveOriginal(text)
    if (!active()) return
    const returned = `${filtered}\n\n[RTK 已优化输出；完整原文可用 Read 读取：${JSON.stringify(originalPath)}]`
    const returnedBytes = Buffer.byteLength(returned)
    if (returnedBytes >= originalBytes) return
    dependencies.record(originalBytes, returnedBytes)
    return { text: returned, originalPath }
  } catch {
    // 原命令已执行；任何后处理错误只能回退现有结果，不能重试命令。
    return undefined
  }
}
