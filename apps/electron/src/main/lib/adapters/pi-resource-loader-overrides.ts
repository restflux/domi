import { basename } from 'node:path'

interface AgentsFilesResult {
  agentsFiles: Array<{ path: string; content: string }>
}

// Domi resolves and injects only the host-authorized Session Target root itself.
// Never inherit instruction files discovered from cwd ancestors or attached roots.
const LEGACY_AGENT_CONTEXT_FILE_NAMES = new Set([
  'CLAUDE.md',
  'CLAUDE.MD',
  'AGENTS.md',
  'AGENTS.MD',
])

export function createDomiAgentsFilesOverride(): (base: AgentsFilesResult) => AgentsFilesResult {
  return (base) => ({
    agentsFiles: base.agentsFiles.filter((file) => !LEGACY_AGENT_CONTEXT_FILE_NAMES.has(basename(file.path))),
  })
}
