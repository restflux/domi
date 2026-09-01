import { describe, expect, test } from 'bun:test'
import { createSingleFlightRefresh } from './work-activity-refresh.ts'

describe('Work Activity refresh coordinator', () => {
  test('Given refresh is already running When polling and events request more refreshes Then it coalesces them into one trailing run', async () => {
    let releaseFirst = (): void => undefined
    const firstRunGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let runCount = 0
    const refresh = createSingleFlightRefresh(async () => {
      runCount += 1
      if (runCount === 1) await firstRunGate
    })

    const first = refresh()
    const polled = refresh()
    const eventTriggered = refresh()

    expect(runCount).toBe(1)
    releaseFirst()
    await Promise.all([first, polled, eventTriggered])

    expect(runCount).toBe(2)
  })
})
