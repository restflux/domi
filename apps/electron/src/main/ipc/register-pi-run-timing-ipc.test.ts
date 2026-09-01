import { describe, expect, test } from 'bun:test'
import { PI_RUN_TIMING_IPC_CHANNELS, type PiRunTimingReportView } from '@domi/shared'
import { registerPiRunTimingIpc } from './register-pi-run-timing-ipc.ts'

type Handler = (event: unknown, input: unknown) => Promise<unknown>

function report(status: PiRunTimingReportView['status'] = 'empty'): PiRunTimingReportView {
  return { status, runs: [], tailTruncated: false, eventLimitReached: false, corruptLines: 0 }
}

describe('registerPiRunTimingIpc', () => {
  test('forwards only an exact sessionId request to the main-owned query service', async () => {
    const handlers = new Map<string, Handler>()
    const calls: string[] = []
    registerPiRunTimingIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
      query: async (sessionId) => { calls.push(sessionId); return report() },
    })

    await expect(handlers.get(PI_RUN_TIMING_IPC_CHANNELS.QUERY)?.({}, { sessionId: 'session-1' })).resolves.toEqual(report())
    expect(calls).toEqual(['session-1'])
  })

  test('rejects paths, filters, categories and malformed session IDs without calling the service', async () => {
    const handlers = new Map<string, Handler>()
    let calls = 0
    registerPiRunTimingIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
      query: async () => { calls += 1; return report() },
    })
    const handler = handlers.get(PI_RUN_TIMING_IPC_CHANNELS.QUERY)!
    for (const input of [
      null,
      {},
      { sessionId: '' },
      { sessionId: 'session-1', path: 'C:/secret/events.jsonl' },
      { sessionId: 'session-1', category: 'execution_policy' },
      { sessionId: 'session-1', filter: {} },
    ]) {
      await expect(handler({}, input)).resolves.toMatchObject({ status: 'unavailable', runs: [] })
    }
    expect(calls).toBe(0)
  })

  test('contains query failures inside observability and returns a neutral unavailable report', async () => {
    const handlers = new Map<string, Handler>()
    registerPiRunTimingIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
      query: async () => { throw new Error('private audit read failure') },
    })

    await expect(handlers.get(PI_RUN_TIMING_IPC_CHANNELS.QUERY)?.({}, { sessionId: 'session-1' })).resolves.toEqual({
      status: 'unavailable', runs: [], tailTruncated: false, eventLimitReached: false, corruptLines: 0,
    })
  })
})
