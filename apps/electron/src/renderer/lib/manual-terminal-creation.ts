import type { TerminalCreateInput, TerminalSessionView } from '@domi/shared'

export interface ManualTerminalCreationGuard {
  pending: boolean
}

export interface ManualTerminalCreationDependencies {
  create: (input: TerminalCreateInput) => Promise<TerminalSessionView>
  onError: (error: unknown) => void
}

export interface CreateManualTerminalOptions {
  ownerSessionId: string
  presentation: NonNullable<TerminalCreateInput['presentation']>
  cols: number
  rows: number
}

/**
 * 手动终端入口共享同一套“单击即创建”语义，并在创建完成前忽略重复点击。
 * 展示区域由 Main 返回的 presentation 和全局终端状态监听器统一路由。
 */
export async function createManualTerminal(
  guard: ManualTerminalCreationGuard,
  dependencies: ManualTerminalCreationDependencies,
  options: CreateManualTerminalOptions,
): Promise<TerminalSessionView | null> {
  if (guard.pending) return null
  guard.pending = true
  try {
    return await dependencies.create({
      ownerSessionId: options.ownerSessionId,
      presentation: options.presentation,
      cols: options.cols,
      rows: options.rows,
    })
  } catch (error) {
    dependencies.onError(error)
    return null
  } finally {
    guard.pending = false
  }
}
