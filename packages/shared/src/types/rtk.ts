export type RtkSkipReason = 'unsupported' | 'no-gain' | 'failed' | 'ineligible' | 'output-limit' | 'unavailable'

/** 宿主检测的 RTK 能力；不允许 Renderer 提交可执行路径或 filter。 */
export interface RtkStatus {
  /** 本次进程中启用期间的未优化原因；不包含关闭期间的调用。 */
  skippedCalls?: Partial<Record<RtkSkipReason, number>>
  availability: 'not-checked' | 'available' | 'not-found' | 'incompatible' | 'unsupported' | 'error'
  version?: string
  optimizedCalls: number
  originalBytes: number
  returnedBytes: number
}

export const RTK_IPC_CHANNELS = {
  STATUS: 'rtk:status',
} as const
