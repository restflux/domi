import { describe, expect, test } from 'bun:test'
import {
  installPiFinalToolGuard,
  type PiFinalToolGuardSession,
  type PiToolCallHookContext,
} from './pi-final-tool-guard.ts'
import {
  createPiRunAuditRecorder,
  type PiRunAuditTimingEvent,
} from '../audit/pi-run-audit.ts'

function call(toolName: string, input: Record<string, unknown> = {}): PiToolCallHookContext {
  return {
    toolCall: { id: `${toolName}-id`, name: toolName },
    args: input,
  }
}

describe('Pi session final tool guard', () => {
  test('Given builtin, product, MCP, and Trusted Extension tools When Pi preflights them Then every tool is authorized exactly once', async () => {
    const authorized: string[] = []
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      authorize: async (request) => {
        authorized.push(request.toolName)
        return { behavior: 'allow', updatedInput: request.input }
      },
    })

    for (const toolName of ['Read', 'AskUserQuestion', 'mcp__server__read', 'trusted_extension_tool']) {
      expect(await session.agent.beforeToolCall?.(call(toolName), new AbortController().signal)).toBeUndefined()
    }

    expect(authorized).toEqual(['Read', 'AskUserQuestion', 'mcp__server__read', 'trusted_extension_tool'])
  })

  test('Given a Trusted Extension reuses a readonly-looking name When Pi preflights it Then source remains resource-owned', async () => {
    let source: string | undefined
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      resolveToolSource: () => 'resource',
      authorize: async (request) => {
        source = request.options.toolSource
        return { behavior: 'allow', updatedInput: request.input }
      },
    })

    await session.agent.beforeToolCall?.(call('Read', { path: 'C:\\repo\\file.ts' }))

    expect(source).toBe('resource')
  })

  test('Given a registered MCP tool has capability annotations When Pi preflights it Then normalized metadata reaches final authorization', async () => {
    let annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      resolveToolSource: () => 'mcp',
      resolveToolAnnotations: () => ({ readOnlyHint: true, destructiveHint: false }),
      authorize: async (request) => {
        annotations = request.options.toolAnnotations
        return { behavior: 'allow', updatedInput: request.input }
      },
    })

    await session.agent.beforeToolCall?.(call('mcp__future__inspect'))

    expect(annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
  })

  test('Given a denied tool call When Pi preflights it Then execution is blocked before the tool can run', async () => {
    let executeCount = 0
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      authorize: async () => ({ behavior: 'deny', message: 'policy denied' }),
    })

    const result = await session.agent.beforeToolCall?.(call('trusted_extension_write'), new AbortController().signal)
    if (!result?.block) executeCount += 1

    expect(result).toEqual({ block: true, reason: 'policy denied' })
    expect(executeCount).toBe(0)
  })

  test('Given a permission adapter modifies validated input When the final hook cannot apply it Then the call fails closed', async () => {
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      authorize: async () => ({ behavior: 'allow', updatedInput: { path: 'C:\\other' } }),
    })

    const result = await session.agent.beforeToolCall?.(call('Read', { path: 'C:\\repo\\file.ts' }))

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('修改工具输入')
  })

  test('Given a known Bash validation When authorization waits and denies Then only safe timing metadata and the final outcome are audited', async () => {
    let now = 5_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-guard',
      workspaceId: 'workspace-guard',
      runStartedAt: 4_900,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })
    const session: PiFinalToolGuardSession = { agent: {} }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      auditRecorder: recorder,
      authorize: async () => {
        now = 5_075
        return { behavior: 'deny', message: 'policy denied' }
      },
    })

    const result = await session.agent.beforeToolCall?.(call('Bash', {
      command: 'bun test',
      env: { API_KEY: 'sk-do-not-persist' },
    }))
    await new Promise((resolve) => queueMicrotask(resolve))

    expect(result?.block).toBe(true)
    expect(events).toMatchObject([{
      phase: 'tool_wait',
      waitType: 'authorization',
      toolCorrelationId: expect.stringMatching(/^tool:[a-f0-9]{12}$/),
      toolName: 'Bash',
      validation: true,
      outcome: 'deny',
      durationMs: 75,
    }])
    const persisted = JSON.stringify(events)
    expect(persisted).not.toContain('bun test')
    expect(persisted).not.toContain('sk-do-not-persist')
    expect(persisted).not.toContain('API_KEY')
    expect(persisted).not.toContain('Bash-id')
    expect(persisted).not.toContain('toolCallId')
  })

  test('Given an earlier Pi hook blocks a mixed compaction batch When final guard is composed Then policy is not invoked', async () => {
    let authorizationCount = 0
    const session: PiFinalToolGuardSession = {
      agent: {
        beforeToolCall: async () => ({ block: true, reason: 'CompactContext 必须单独调用' }),
      },
    }
    installPiFinalToolGuard(session, {
      cwd: 'C:\\repo',
      authorize: async (request) => {
        authorizationCount += 1
        return { behavior: 'allow', updatedInput: request.input }
      },
    })

    const result = await session.agent.beforeToolCall?.(call('CompactContext'))

    expect(result).toEqual({ block: true, reason: 'CompactContext 必须单独调用' })
    expect(authorizationCount).toBe(0)
  })
})
