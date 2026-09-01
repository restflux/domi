import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_PI_CONTEXT_COMPACTOR_SETTINGS,
  type PiContextCompactorHostSnapshot,
} from './pi-context-compactor'
import {
  createPiContextCompactorExtension,
  wrapPiContextCompactorTransform,
  type PiContextCompactorTelemetryEvent,
} from './pi-context-compactor-extension'

const enabledSettings = { ...DEFAULT_PI_CONTEXT_COMPACTOR_SETTINGS, enabled: true }

function preparation(): SessionBeforeCompactEvent['preparation'] {
  return {
    firstKeptEntryId: 'u2',
    messagesToSummarize: [{ role: 'user', content: [{ type: 'text', text: 'Keep this constraint.' }], timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 80_000,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  } as SessionBeforeCompactEvent['preparation']
}

function beforeCompactEvent(signal = new AbortController().signal): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    preparation: preparation(),
    branchEntries: [],
    reason: 'threshold',
    willRetry: false,
    signal,
  }
}

function captureBeforeCompactHandler(factory: ReturnType<typeof createPiContextCompactorExtension>) {
  let handler: ((event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) | undefined
  const api = {
    on(event: string, candidate: typeof handler) {
      if (event === 'session_before_compact') handler = candidate
    },
  } as unknown as ExtensionAPI
  factory(api)
  if (!handler) throw new Error('handler not registered')
  return handler
}

const emptyContext = {} as ExtensionContext

describe('Pi ContextCompactor extension lifecycle', () => {
  test('preflight enhancement returns undefined so Pi performs the only physical summary request', async () => {
    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const handler = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: enabledSettings,
      getHostSnapshot: () => ({
        sessionTarget: { kind: 'isolated', ownership: 'owner', checkoutId: 'checkout-1', revision: 3 },
      }),
      onTelemetry: (event) => { telemetry.push(event) },
    }))

    expect(await handler(beforeCompactEvent(), emptyContext)).toBeUndefined()
    expect(telemetry).toHaveLength(1)
    expect(telemetry[0]).toMatchObject({
      stage: 'preflight',
      outcome: 'enhanced',
      reason: 'threshold',
      willRetry: false,
    })
  })

  test('termination preflight returns cancel instead of allowing inline compaction to continue', async () => {
    const handler = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: enabledSettings,
      getHostSnapshot: () => ({ terminatingToolName: 'ReadyForReview' }),
    }))

    await expect(handler(beforeCompactEvent(), emptyContext)).resolves.toEqual({ cancel: true })
  })

  test('authoritative handler conflict can deactivate the Domi preflight without snapshot reads or cancellation', async () => {
    let active = true
    let snapshotReads = 0
    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const handler = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel' },
      isActive: () => active,
      getHostSnapshot: () => {
        snapshotReads += 1
        return { terminatingToolName: 'ReadyForReview' }
      },
      onTelemetry: event => { telemetry.push(event) },
    }))

    active = false

    await expect(handler(beforeCompactEvent(), emptyContext)).resolves.toBeUndefined()
    expect(snapshotReads).toBe(0)
    expect(telemetry).toEqual([])
  })

  test('host snapshot timeout follows fallback or strict cancellation policy without unbounded waits', async () => {
    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const never = () => new Promise<PiContextCompactorHostSnapshot>(() => {})
    const fallbackHandler = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: { ...enabledSettings, hostSnapshotTimeoutMs: 10 },
      getHostSnapshot: never,
      onTelemetry: (event) => { telemetry.push(event) },
    }))
    const strictHandler = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel', hostSnapshotTimeoutMs: 10 },
      mode: 'enhance',
      getHostSnapshot: never,
      onTelemetry: (event) => { telemetry.push(event) },
    }))

    expect(await fallbackHandler(beforeCompactEvent(), emptyContext)).toBeUndefined()
    expect(await strictHandler(beforeCompactEvent(), emptyContext)).toEqual({ cancel: true })
    expect(telemetry).toEqual([
      expect.objectContaining({ stage: 'preflight', outcome: 'fallback', errorCode: 'host_snapshot_timeout' }),
      expect.objectContaining({ stage: 'preflight', outcome: 'cancelled', errorCode: 'host_snapshot_timeout' }),
    ])
  })

  test('abort always cancels preflight and propagates through provider projection regardless of fallback policy', async () => {
    const controller = new AbortController()
    controller.abort()
    const handler = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: enabledSettings,
      getHostSnapshot: () => ({}),
    }))
    const wrapped = wrapPiContextCompactorTransform({
      getBranchEntries: () => [],
      getHostSnapshot: () => ({}),
      settings: enabledSettings,
      mode: 'enhance',
    })

    await expect(handler(beforeCompactEvent(controller.signal), emptyContext)).resolves.toEqual({ cancel: true })
    await expect(wrapped([], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('provider wrapper executes existing transforms first, projects only a copy, and falls back on validation failures', async () => {
    const branch: SessionEntry[] = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: new Date(1).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'Never edit secrets.env.' }], timestamp: 1 },
      },
      {
        type: 'message', id: 'u2', parentId: 'u1', timestamp: new Date(2).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'retained' }], timestamp: 2 },
      },
      {
        type: 'compaction', id: 'c1', parentId: 'u2', timestamp: new Date(3).toISOString(),
        summary: 'Continue.', firstKeptEntryId: 'u2', tokensBefore: 80_000,
      },
    ]
    const runtime: AgentMessage[] = [{ role: 'compactionSummary', summary: 'Continue.', tokensBefore: 80_000, timestamp: 3 }]
    const source = structuredClone(runtime)
    const order: string[] = []
    const wrapped = wrapPiContextCompactorTransform({
      previousTransform: async messages => {
        order.push('previous')
        return messages.map(message => structuredClone(message))
      },
      getBranchEntries: () => branch,
      getHostSnapshot: () => ({
        sessionTarget: { kind: 'isolated', ownership: 'owner', checkoutId: 'checkout-1' },
      }),
      settings: enabledSettings,
      mode: 'enhance',
      onTelemetry: (event) => { order.push(event.stage) },
    })

    const projected = await wrapped(runtime, new AbortController().signal)

    expect(order).toEqual(['previous', 'provider_projection'])
    expect(runtime).toEqual(source)
    expect(projected).not.toBe(runtime)
    expect(JSON.stringify(projected)).toContain('Never edit secrets.env.')
    expect(JSON.stringify(projected)).toContain('checkout-1')

    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const invalid = wrapPiContextCompactorTransform({
      getBranchEntries: () => branch,
      getHostSnapshot: () => ({
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-invalid',
            validationStatus: 'passed',
            tests: [{ command: 'bun test', status: 'failed' }],
          },
        },
      }),
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel' },
      mode: 'enhance',
      onTelemetry: event => { telemetry.push(event) },
    })
    await expect(invalid(runtime, new AbortController().signal)).resolves.toEqual(runtime)
    expect(telemetry).toEqual([
      expect.objectContaining({
        stage: 'provider_projection',
        outcome: 'fallback_validation',
        errorCode: 'evidence_validation_failed',
        factKey: 'delivery-review',
        ruleId: 'review_validation_inconsistent',
        failureCategory: 'host_state_inconsistent',
        stateFingerprint: expect.any(String),
      }),
    ])
  })

  test('preflight validation failure never cancels inline compaction, while termination and abort remain fail-closed', async () => {
    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const invalidEvidence = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel' },
      getHostSnapshot: () => ({
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-invalid',
            validationStatus: 'passed',
            tests: [{ command: 'bun test', status: 'failed' }],
          },
        },
      }),
      onTelemetry: event => { telemetry.push(event) },
    }))

    await expect(invalidEvidence(beforeCompactEvent(), emptyContext)).resolves.toBeUndefined()
    expect(telemetry).toEqual([
      expect.objectContaining({
        stage: 'preflight',
        outcome: 'fallback_validation',
        errorCode: 'evidence_validation_failed',
        factKey: 'delivery-review',
        ruleId: 'review_validation_inconsistent',
      }),
    ])

    const terminating = captureBeforeCompactHandler(createPiContextCompactorExtension({
      settings: enabledSettings,
      getHostSnapshot: () => ({ terminatingToolName: 'CompactContext' }),
    }))
    await expect(terminating(beforeCompactEvent(), emptyContext)).resolves.toEqual({ cancel: true })

    const terminatingProjection = wrapPiContextCompactorTransform({
      getBranchEntries: () => [],
      getHostSnapshot: () => ({ terminatingToolName: 'ReadyForReview' }),
      settings: enabledSettings,
      mode: 'enhance',
    })
    await expect(terminatingProjection([], new AbortController().signal)).rejects.toMatchObject({
      name: 'PiContextCompactorSafetyBoundaryError',
    })

    const controller = new AbortController()
    controller.abort()
    await expect(invalidEvidence(beforeCompactEvent(controller.signal), emptyContext)).resolves.toEqual({ cancel: true })
  })

  test('strict provider projection still fails closed for unexpected candidate errors', async () => {
    const branch: SessionEntry[] = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: new Date(1).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'preserve' }], timestamp: 1 },
      },
      {
        type: 'message', id: 'u2', parentId: 'u1', timestamp: new Date(2).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'retained' }], timestamp: 2 },
      },
      {
        type: 'compaction', id: 'c1', parentId: 'u2', timestamp: new Date(3).toISOString(),
        summary: 'Continue.', firstKeptEntryId: 'u2', tokensBefore: 80_000,
      },
    ]
    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const strict = wrapPiContextCompactorTransform({
      getBranchEntries: () => branch,
      getHostSnapshot: () => ({
        tasks: [{ id: 'bad-task', subject: null, status: 'in_progress' }],
      } as unknown as PiContextCompactorHostSnapshot),
      settings: { ...enabledSettings, failurePolicy: 'strict_cancel' },
      mode: 'enhance',
      onTelemetry: event => { telemetry.push(event) },
    })

    await expect(strict(
      [{ role: 'compactionSummary', summary: 'Continue.', tokensBefore: 80_000, timestamp: 3 }],
      new AbortController().signal,
    )).rejects.toBeInstanceOf(TypeError)
    expect(telemetry).toEqual([
      expect.objectContaining({
        stage: 'provider_projection',
        outcome: 'failed',
        errorCode: 'projection_failed',
      }),
    ])
  })

  test('deduplicates repeated not-applicable and validation fallback telemetry until state changes', async () => {
    const runtime: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }]
    const notApplicableTelemetry: PiContextCompactorTelemetryEvent[] = []
    const notApplicable = wrapPiContextCompactorTransform({
      getBranchEntries: () => [],
      getHostSnapshot: () => ({}),
      settings: enabledSettings,
      mode: 'enhance',
      onTelemetry: event => { notApplicableTelemetry.push(event) },
    })

    await notApplicable(runtime, new AbortController().signal)
    await notApplicable(runtime, new AbortController().signal)
    expect(notApplicableTelemetry).toEqual([
      expect.objectContaining({ stage: 'provider_projection', outcome: 'not_applicable' }),
    ])

    const validationTelemetry: PiContextCompactorTelemetryEvent[] = []
    const validationRuntime: AgentMessage[] = [{
      role: 'compactionSummary', summary: 'checkpoint', tokensBefore: 80_000, timestamp: 2,
    }]
    const validationBranch: SessionEntry[] = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: new Date(1).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'preserve' }], timestamp: 1 },
      },
      {
        type: 'compaction', id: 'c1', parentId: 'u1', timestamp: new Date(2).toISOString(),
        summary: 'checkpoint', firstKeptEntryId: 'u1', tokensBefore: 80_000,
      },
    ]
    let testStatuses: Array<'passed' | 'failed'> = ['failed']
    const invalid = wrapPiContextCompactorTransform({
      getBranchEntries: () => validationBranch,
      getHostSnapshot: () => ({
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-invalid',
            validationStatus: 'passed',
            tests: testStatuses.map((status, index) => ({ command: `bun test ${index}`, status })),
          },
        },
      }),
      settings: enabledSettings,
      mode: 'enhance',
      onTelemetry: event => { validationTelemetry.push(event) },
    })

    await invalid(validationRuntime, new AbortController().signal)
    await invalid(validationRuntime, new AbortController().signal)
    testStatuses = ['passed', 'failed']
    await invalid(validationRuntime, new AbortController().signal)

    expect(validationTelemetry).toHaveLength(2)
    expect(validationTelemetry[0]).toMatchObject({
      outcome: 'fallback_validation',
      factKey: 'delivery-review',
      ruleId: 'review_validation_inconsistent',
    })
    expect(validationTelemetry[1]?.stateFingerprint).not.toBe(validationTelemetry[0]?.stateFingerprint)
  })

  test('observe mode evaluates candidate metadata but returns the existing provider context unchanged', async () => {
    const telemetry: PiContextCompactorTelemetryEvent[] = []
    const branch: SessionEntry[] = [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: new Date(1).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'Preserve this correction.' }], timestamp: 1 },
      },
      {
        type: 'message', id: 'u2', parentId: 'u1', timestamp: new Date(2).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'retained' }], timestamp: 2 },
      },
      {
        type: 'compaction', id: 'c1', parentId: 'u2', timestamp: new Date(3).toISOString(),
        summary: 'Continue.', firstKeptEntryId: 'u2', tokensBefore: 80_000,
      },
    ]
    const runtime: AgentMessage[] = [{ role: 'compactionSummary', summary: 'Continue.', tokensBefore: 80_000, timestamp: 3 }]
    const wrapped = wrapPiContextCompactorTransform({
      getBranchEntries: () => branch,
      getHostSnapshot: () => ({}),
      settings: enabledSettings,
      mode: 'observe',
      onTelemetry: (event) => { telemetry.push(event) },
    })

    const result = await wrapped(runtime, new AbortController().signal)

    expect(result).toEqual(runtime)
    expect(telemetry[0]).toMatchObject({ stage: 'provider_projection', outcome: 'observed' })
    expect(telemetry[0]?.metadata?.recentUserCount).toBe(1)
  })
})
