import {
  normalizeAgentToolAnnotations,
  type AgentToolAnnotations,
} from '../agent-tool-annotations.ts'

interface McpReadOnlyTrustConfig {
  url?: unknown
  trustReadOnlyAnnotations?: unknown
}

const TRUSTED_READ_ONLY_MCP_ENDPOINTS = new Set([
  'https://mcp.exa.ai/mcp',
  'https://mcp.context7.com/mcp',
  'https://api.searchcode.com/v1/mcp',
])

const TRUSTED_READ_ONLY_MCP_FALLBACK_TOOLS = new Set([
  'mcp__exa__web_search_exa',
  'mcp__exa__web_fetch_exa',
  'mcp__context7__resolve_library_id',
  'mcp__context7__query_docs',
  'mcp__searchcode__code_analyze',
  'mcp__searchcode__code_search',
  'mcp__searchcode__code_get_file',
  'mcp__searchcode__code_file_tree',
  'mcp__searchcode__code_get_files',
  'mcp__searchcode__code_get_findings',
])

function normalizeMcpEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`
  } catch {
    return undefined
  }
}

/**
 * MCP annotations are server-provided hints, not a security proof. Domi only
 * accepts them after an explicit per-server trust decision or for a
 * host-maintained HTTPS endpoint identity.
 */
export function isHostMaintainedTrustedMcpEndpoint(url: unknown): boolean {
  const endpoint = normalizeMcpEndpoint(url)
  return endpoint !== undefined && TRUSTED_READ_ONLY_MCP_ENDPOINTS.has(endpoint)
}

export function trustsMcpReadOnlyAnnotations(config: McpReadOnlyTrustConfig): boolean {
  return config.trustReadOnlyAnnotations === true
}

export function resolveEffectiveMcpToolAnnotations(input: {
  config: McpReadOnlyTrustConfig
  toolName: string
  serverAnnotations: unknown
}): AgentToolAnnotations | undefined {
  if (!trustsMcpReadOnlyAnnotations(input.config)) return undefined

  const annotations = normalizeAgentToolAnnotations(input.serverAnnotations)
  if (!TRUSTED_READ_ONLY_MCP_FALLBACK_TOOLS.has(input.toolName)) return annotations
  if (annotations?.readOnlyHint === false) return annotations
  return { ...annotations, readOnlyHint: true }
}
