export type AgentStartupSnapshotStatus = 'ready' | 'miss' | 'existing' | 'skipped' | 'cancelled' | 'unavailable'

interface AgentStartupTimingBase {
  phase: 'session_target' | 'dependency_snapshot' | 'agent_initialization' | 'pi_query'
  sessionId: string
  workspaceId?: string
  runStartedAt: number
  timestamp: string
  durationMs: number
}

export interface AgentSessionTargetTimingEvent extends AgentStartupTimingBase {
  phase: 'session_target'
  outcome: 'success' | 'error'
  targetKind?: 'local' | 'isolated'
  ownership?: 'owner' | 'inherited'
}

export interface AgentDependencySnapshotTimingEvent extends AgentStartupTimingBase {
  phase: 'dependency_snapshot'
  status: AgentStartupSnapshotStatus
  overlapMs: number
  waitDurationMs: number
}

export interface AgentInitializationTimingEvent extends AgentStartupTimingBase {
  phase: 'agent_initialization'
}

export interface AgentPiQueryTimingEvent extends AgentStartupTimingBase {
  phase: 'pi_query'
  resume: boolean
}

export type AgentStartupTimingEvent =
  | AgentSessionTargetTimingEvent
  | AgentDependencySnapshotTimingEvent
  | AgentInitializationTimingEvent
  | AgentPiQueryTimingEvent

export type AgentStartupTimingCallback = (event: AgentStartupTimingEvent) => void | Promise<void>

export interface AgentStartupTimingRecorder {
  recordSessionTarget(
    startedAt: number,
    input: Pick<AgentSessionTargetTimingEvent, 'outcome' | 'targetKind' | 'ownership'>,
  ): void
  recordDependencySnapshot(
    input: Pick<AgentDependencySnapshotTimingEvent, 'status' | 'durationMs' | 'overlapMs' | 'waitDurationMs'>,
  ): void
  recordAgentInitialization(startedAt: number): void
  recordPiQuery(input: Pick<AgentPiQueryTimingEvent, 'resume'>): void
  flush(): Promise<void>
}

export interface CreateAgentStartupTimingRecorderOptions {
  sessionId: string
  workspaceId?: string
  runStartedAt: number
  onTimingEvent?: AgentStartupTimingCallback
  now?: () => number
}

/**
 * Host startup timing deliberately exposes only a closed set of enum/scalar fields.
 * Paths, commands, environment values, credentials, prompts and user content have no seam here.
 */
export function createAgentStartupTimingRecorder(
  options: CreateAgentStartupTimingRecorderOptions,
): AgentStartupTimingRecorder {
  const now = options.now ?? Date.now
  let writeQueue = Promise.resolve()

  const emit = (event: AgentStartupTimingEvent): void => {
    if (!options.onTimingEvent) return
    writeQueue = writeQueue
      .then(() => options.onTimingEvent?.(event))
      .then(() => undefined)
      .catch(() => undefined)
  }

  const base = (
    phase: AgentStartupTimingEvent['phase'],
    timestamp: number,
    durationMs: number,
  ): AgentStartupTimingBase => ({
    phase,
    sessionId: options.sessionId,
    ...(options.workspaceId && { workspaceId: options.workspaceId }),
    runStartedAt: options.runStartedAt,
    timestamp: new Date(timestamp).toISOString(),
    durationMs: Math.max(0, durationMs),
  })

  return {
    recordSessionTarget(startedAt, input) {
      const timestamp = now()
      emit({
        ...base('session_target', timestamp, timestamp - startedAt),
        ...input,
        phase: 'session_target',
      })
    },
    recordDependencySnapshot(input) {
      const timestamp = now()
      emit({
        ...base('dependency_snapshot', timestamp, input.durationMs),
        phase: 'dependency_snapshot',
        status: input.status,
        overlapMs: Math.max(0, input.overlapMs),
        waitDurationMs: Math.max(0, input.waitDurationMs),
      })
    },
    recordAgentInitialization(startedAt) {
      const timestamp = now()
      emit({
        ...base('agent_initialization', timestamp, timestamp - startedAt),
        phase: 'agent_initialization',
      })
    },
    recordPiQuery(input) {
      const timestamp = now()
      emit({
        ...base('pi_query', timestamp, timestamp - options.runStartedAt),
        phase: 'pi_query',
        resume: input.resume,
      })
    },
    flush: () => writeQueue,
  }
}
