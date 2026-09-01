import { describe, expect, test } from 'bun:test'
import { normalizeAgentToolAnnotations } from './agent-tool-annotations.ts'

describe('Agent tool annotations', () => {
  test('Given MCP metadata When normalized Then only boolean capability hints survive', () => {
    expect(normalizeAgentToolAnnotations({
      title: 'Inspect',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: 'yes',
    })).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  test('Given absent or malformed metadata When normalized Then it cannot claim read-only capability', () => {
    expect(normalizeAgentToolAnnotations(undefined)).toBeUndefined()
    expect(normalizeAgentToolAnnotations({ readOnlyHint: 'true' })).toBeUndefined()
  })
})
