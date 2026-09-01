import { AgentFileCheckpointStore } from './agent-file-checkpoint.ts'
import { getAgentFileCheckpointsDir } from './config-paths.ts'

let productionStore: AgentFileCheckpointStore | undefined

export function getAgentFileCheckpointStore(): AgentFileCheckpointStore {
  productionStore ??= new AgentFileCheckpointStore({ storageRoot: getAgentFileCheckpointsDir() })
  return productionStore
}

export function deleteAgentFileCheckpoints(sessionId: string): void {
  getAgentFileCheckpointStore().deleteSession(sessionId)
}
