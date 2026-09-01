import {
  PI_RUN_TIMING_IPC_CHANNELS,
  type PiRunTimingReportView,
} from '@domi/shared'

interface PiRunTimingIpcRegistrar {
  handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void
}

export interface PiRunTimingQueryService {
  query(sessionId: string): Promise<PiRunTimingReportView>
}

const UNAVAILABLE: PiRunTimingReportView = {
  status: 'unavailable',
  runs: [],
  tailTruncated: false,
  eventLimitReached: false,
  corruptLines: 0,
}

function parseSessionId(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'sessionId')) return null
  return typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId : null
}

/** Renderer 只能按 session 查询；audit 路径、分类和读取预算均由 main 持有。 */
export function registerPiRunTimingIpc(
  ipc: PiRunTimingIpcRegistrar,
  service: PiRunTimingQueryService,
): void {
  ipc.handle(PI_RUN_TIMING_IPC_CHANNELS.QUERY, async (_, input) => {
    const sessionId = parseSessionId(input)
    if (!sessionId) return UNAVAILABLE
    try {
      return await service.query(sessionId)
    } catch {
      return UNAVAILABLE
    }
  })
}
