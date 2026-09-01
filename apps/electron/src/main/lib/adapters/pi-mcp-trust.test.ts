import { describe, expect, test } from 'bun:test'
import {
  isHostMaintainedTrustedMcpEndpoint,
  resolveEffectiveMcpToolAnnotations,
  trustsMcpReadOnlyAnnotations,
} from './pi-mcp-trust.ts'

describe('Pi MCP read-only trust', () => {
  test('Given host-maintained vendor endpoints When checked Then read-only annotations are trusted by endpoint identity', () => {
    for (const url of [
      'https://mcp.exa.ai/mcp',
      'https://mcp.context7.com/mcp/',
      'https://api.searchcode.com/v1/mcp?ignored=true',
    ]) {
      expect(isHostMaintainedTrustedMcpEndpoint(url), url).toBe(true)
    }
    expect(isHostMaintainedTrustedMcpEndpoint('https://attacker.example/mcp')).toBe(false)
    expect(trustsMcpReadOnlyAnnotations({ url: 'https://mcp.exa.ai/mcp' })).toBe(false)
  })

  test('Given an untrusted server copies a known tool name When metadata is resolved Then name and self-reported hints cannot grant access', () => {
    expect(resolveEffectiveMcpToolAnnotations({
      config: { url: 'https://attacker.example/mcp' },
      toolName: 'mcp__exa__web_search_exa',
      serverAnnotations: { readOnlyHint: true },
    })).toBeUndefined()
  })

  test('Given an explicitly trusted server When it reports capabilities Then read-only metadata is preserved and contradictions remain fail-closed', () => {
    expect(resolveEffectiveMcpToolAnnotations({
      config: { trustReadOnlyAnnotations: true },
      toolName: 'mcp__future__inspect',
      serverAnnotations: { readOnlyHint: true, destructiveHint: false },
    })).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(resolveEffectiveMcpToolAnnotations({
      config: { trustReadOnlyAnnotations: true },
      toolName: 'mcp__future__contradictory',
      serverAnnotations: { readOnlyHint: true, destructiveHint: true },
    })).toEqual({ readOnlyHint: true, destructiveHint: true })
  })

  test('Given a trusted legacy retrieval tool omits annotations When resolved Then host fallback grants only that exact tool', () => {
    expect(resolveEffectiveMcpToolAnnotations({
      config: { url: 'https://mcp.exa.ai/mcp', trustReadOnlyAnnotations: true },
      toolName: 'mcp__exa__web_fetch_exa',
      serverAnnotations: undefined,
    })).toEqual({ readOnlyHint: true })
    expect(resolveEffectiveMcpToolAnnotations({
      config: { url: 'https://mcp.exa.ai/mcp', trustReadOnlyAnnotations: true },
      toolName: 'mcp__exa__delete_everything',
      serverAnnotations: undefined,
    })).toBeUndefined()
  })
})
