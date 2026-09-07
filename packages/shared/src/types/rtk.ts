/** 宿主检测的 RTK 能力；不允许 Renderer 提交可执行路径或 filter。 */
export interface RtkStatus {
  availability: 'not-checked' | 'available' | 'not-found' | 'incompatible' | 'unsupported' | 'error'
  version?: string
  optimizedCalls: number
  originalBytes: number
  returnedBytes: number
}

export const RTK_IPC_CHANNELS = {
  STATUS: 'rtk:status',
} as const
