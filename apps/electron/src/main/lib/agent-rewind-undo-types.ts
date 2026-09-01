export interface PiSessionRewindStateSnapshot {
  sdkSessionId?: string
  piSessionFile: string
  piEntryBindings?: Record<string, string>
  piTreeActiveLeafId?: string | null
}

export interface AgentRewindUndoHostState {
  sourcePi: PiSessionRewindStateSnapshot
  rewoundPi: PiSessionRewindStateSnapshot
  sourceTranscriptContent: string
  rewoundTranscriptContent: string
}

export interface PersistedAgentRewindUndoHostState {
  sourcePi: PiSessionRewindStateSnapshot
  rewoundPi: PiSessionRewindStateSnapshot
}
