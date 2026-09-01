import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import {
  PiContextCompactorSafetyBoundaryError,
  PiContextCompactorValidationError,
  preflightPiContextCompaction,
  projectPiContextCompactorMessages,
  type PiContextCompactorHostSnapshot,
  type PiContextCompactorProjectionMetadata,
  type PiContextCompactorSettings,
  type PiContextCompactorValidationFailureCategory,
  type PiContextCompactorValidationRuleId,
} from './pi-context-compactor'

export type PiContextCompactorMode = 'observe' | 'enhance'

export interface PiContextCompactorTelemetryEvent {
  timestamp: number
  attemptId: string
  stage: 'preflight' | 'provider_projection'
  strategy: PiContextCompactorSettings['strategy']
  mode: PiContextCompactorMode
  outcome: 'enhanced' | 'observed' | 'not_applicable' | 'fallback' | 'fallback_validation' | 'cancelled' | 'failed' | 'aborted'
  durationMs: number
  reason?: SessionBeforeCompactEvent['reason']
  willRetry?: boolean
  splitTurn?: boolean
  errorCode?: string
  errorMessage?: string
  factKey?: string
  ruleId?: PiContextCompactorValidationRuleId
  failureCategory?: PiContextCompactorValidationFailureCategory
  stateFingerprint?: string
  metadata?: PiContextCompactorProjectionMetadata
}

export type PiContextCompactorTelemetryCallback = (
  event: PiContextCompactorTelemetryEvent,
) => void | Promise<void>

interface PiContextCompactorExtensionOptions {
  settings: PiContextCompactorSettings
  mode?: PiContextCompactorMode
  getHostSnapshot: (signal: AbortSignal) => PiContextCompactorHostSnapshot | Promise<PiContextCompactorHostSnapshot>
  /** Adapter can deactivate this handler after resource reload detects another authoritative owner. */
  isActive?: () => boolean
  onTelemetry?: PiContextCompactorTelemetryCallback
  now?: () => number
  createAttemptId?: () => string
}

interface WrapPiContextCompactorTransformOptions {
  previousTransform?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> | AgentMessage[]
  getBranchEntries: () => readonly SessionEntry[]
  getHostSnapshot: (signal: AbortSignal) => PiContextCompactorHostSnapshot | Promise<PiContextCompactorHostSnapshot>
  settings: PiContextCompactorSettings
  mode: PiContextCompactorMode
  onTelemetry?: PiContextCompactorTelemetryCallback
  now?: () => number
  createAttemptId?: () => string
}

class PiContextCompactorHostSnapshotTimeoutError extends Error {
  constructor() {
    super('ContextCompactor host snapshot timed out.')
    this.name = 'PiContextCompactorHostSnapshotTimeoutError'
  }
}

function createAbortError(): Error {
  const error = new Error('ContextCompactor was aborted.')
  error.name = 'AbortError'
  return error
}

function emitTelemetry(
  callback: PiContextCompactorTelemetryCallback | undefined,
  event: PiContextCompactorTelemetryEvent,
): void {
  if (!callback) return
  try {
    void Promise.resolve(callback(event)).catch(() => undefined)
  } catch {
    // Observability never changes compaction or provider request behavior.
  }
}

async function resolveHostSnapshot(
  getter: (signal: AbortSignal) => PiContextCompactorHostSnapshot | Promise<PiContextCompactorHostSnapshot>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PiContextCompactorHostSnapshot> {
  if (signal.aborted) throw createAbortError()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new PiContextCompactorHostSnapshotTimeoutError()), timeoutMs)
    abortListener = () => reject(createAbortError())
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve(getter(signal)), timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abortListener) signal.removeEventListener('abort', abortListener)
  }
}

function snapshotFailureResult(
  settings: PiContextCompactorSettings,
  mode: PiContextCompactorMode,
  error: unknown,
): { result: { cancel: true } | undefined; outcome: PiContextCompactorTelemetryEvent['outcome']; errorCode: string } {
  if (error instanceof Error && error.name === 'AbortError') {
    return { result: { cancel: true }, outcome: 'cancelled', errorCode: 'aborted' }
  }
  if (error instanceof PiContextCompactorHostSnapshotTimeoutError) {
    return settings.failurePolicy === 'strict_cancel' && mode === 'enhance'
      ? { result: { cancel: true }, outcome: 'cancelled', errorCode: 'host_snapshot_timeout' }
      : { result: undefined, outcome: 'fallback', errorCode: 'host_snapshot_timeout' }
  }
  if (mode === 'observe' || settings.failurePolicy === 'fallback_pi') {
    return { result: undefined, outcome: 'fallback', errorCode: 'host_snapshot_unavailable' }
  }
  return { result: { cancel: true }, outcome: 'cancelled', errorCode: 'host_snapshot_unavailable' }
}

export function createPiContextCompactorExtension(
  options: PiContextCompactorExtensionOptions,
): ExtensionFactory {
  const now = options.now ?? Date.now
  let sequence = 0
  const createAttemptId = options.createAttemptId ?? (() => `pi-context-compactor:${now()}:${++sequence}`)
  const mode = options.mode ?? 'enhance'

  return (pi) => {
    pi.on('session_before_compact', async (event): Promise<{ cancel: true } | void> => {
      if (options.isActive && !options.isActive()) return
      const startedAt = now()
      const attemptId = createAttemptId()
      let snapshot: PiContextCompactorHostSnapshot
      try {
        snapshot = await resolveHostSnapshot(
          options.getHostSnapshot,
          event.signal,
          options.settings.hostSnapshotTimeoutMs,
        )
      } catch (error) {
        const failure = snapshotFailureResult(options.settings, mode, error)
        emitTelemetry(options.onTelemetry, {
          timestamp: now(),
          attemptId,
          stage: 'preflight',
          strategy: options.settings.strategy,
          mode,
          outcome: failure.outcome,
          durationMs: Math.max(0, now() - startedAt),
          reason: event.reason,
          willRetry: event.willRetry,
          splitTurn: event.preparation.isSplitTurn,
          errorCode: failure.errorCode,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        return failure.result
      }

      const decision = preflightPiContextCompaction({
        preparation: event.preparation,
        hostSnapshot: snapshot,
        settings: options.settings,
        signal: event.signal,
      })
      const outcome: PiContextCompactorTelemetryEvent['outcome'] = decision.kind === 'enhance_pi'
        ? (mode === 'observe' ? 'observed' : 'enhanced')
        : decision.kind === 'fallback_pi'
          ? decision.reason === 'nothing_to_enhance'
            ? 'not_applicable'
            : decision.reason === 'evidence_validation_failed'
              ? 'fallback_validation'
              : 'fallback'
          : 'cancelled'
      emitTelemetry(options.onTelemetry, {
        timestamp: now(),
        attemptId,
        stage: 'preflight',
        strategy: options.settings.strategy,
        mode,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
        reason: event.reason,
        willRetry: event.willRetry,
        splitTurn: event.preparation.isSplitTurn,
        ...(decision.kind === 'fallback_pi' ? {
          errorCode: decision.reason,
          ...(decision.errorMessage ? { errorMessage: decision.errorMessage } : {}),
          ...(decision.validation ?? {}),
        } : {}),
        ...(decision.kind === 'cancel' ? { errorCode: decision.reason, errorMessage: decision.errorMessage } : {}),
      })
      if (mode === 'observe') return
      if (decision.kind === 'cancel') return { cancel: true }
      // enhance_pi deliberately returns undefined: Pi remains the sole summary provider caller
      // and the sole owner of compaction persistence/session-tree semantics.
      return
    })
  }
}

export function wrapPiContextCompactorTransform(
  options: WrapPiContextCompactorTransformOptions,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const now = options.now ?? Date.now
  let sequence = 0
  let lastDeduplicatedTelemetryKey: string | undefined
  const createAttemptId = options.createAttemptId ?? (() => `pi-context-projection:${now()}:${++sequence}`)
  const emitProjectionTelemetry = (
    event: PiContextCompactorTelemetryEvent,
    deduplicationKey?: string,
  ): void => {
    if (deduplicationKey && deduplicationKey === lastDeduplicatedTelemetryKey) return
    lastDeduplicatedTelemetryKey = deduplicationKey
    emitTelemetry(options.onTelemetry, event)
  }

  return async (messages, signal): Promise<AgentMessage[]> => {
    const effectiveSignal = signal ?? new AbortController().signal
    const transformed = options.previousTransform
      ? await options.previousTransform(messages, effectiveSignal)
      : messages
    if (!options.settings.enabled) return transformed

    const startedAt = now()
    const attemptId = createAttemptId()
    try {
      const hostSnapshot = await resolveHostSnapshot(
        options.getHostSnapshot,
        effectiveSignal,
        options.settings.hostSnapshotTimeoutMs,
      )
      const projected = projectPiContextCompactorMessages({
        messages: transformed,
        branchEntries: options.getBranchEntries(),
        hostSnapshot,
        settings: options.settings,
      })
      const outcome = options.mode === 'observe'
        ? 'observed'
        : projected.metadata.enhanced ? 'enhanced' : 'not_applicable'
      emitProjectionTelemetry({
        timestamp: now(),
        attemptId,
        stage: 'provider_projection',
        strategy: options.settings.strategy,
        mode: options.mode,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
        metadata: projected.metadata,
      }, outcome === 'not_applicable'
        ? `not_applicable:${projected.metadata.compactionEntryId ?? 'none'}`
        : undefined)
      return options.mode === 'observe' ? transformed : projected.messages
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      const safetyBoundary = error instanceof PiContextCompactorSafetyBoundaryError
      const fallbackAllowed = !aborted && !safetyBoundary && (
        error instanceof PiContextCompactorValidationError
        || options.mode === 'observe'
        || options.settings.failurePolicy === 'fallback_pi'
      )
      const validationError = error instanceof PiContextCompactorValidationError ? error : undefined
      const outcome = aborted
        ? 'aborted'
        : validationError && fallbackAllowed
          ? 'fallback_validation'
          : fallbackAllowed ? 'fallback' : 'failed'
      emitProjectionTelemetry({
        timestamp: now(),
        attemptId,
        stage: 'provider_projection',
        strategy: options.settings.strategy,
        mode: options.mode,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
        errorCode: validationError
          ? 'evidence_validation_failed'
          : error instanceof PiContextCompactorSafetyBoundaryError
            ? 'session_terminating'
            : error instanceof PiContextCompactorHostSnapshotTimeoutError
            ? 'host_snapshot_timeout'
            : aborted
              ? 'aborted'
              : 'projection_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(validationError ? {
          factKey: validationError.factKey,
          ruleId: validationError.ruleId,
          failureCategory: validationError.failureCategory,
          stateFingerprint: validationError.stateFingerprint,
        } : {}),
      }, validationError && fallbackAllowed
        ? `fallback_validation:${validationError.stateFingerprint}`
        : undefined)
      if (fallbackAllowed) return transformed
      throw error
    }
  }
}
