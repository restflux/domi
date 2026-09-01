import { describe, expect, test } from 'bun:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import {
  installPiToolExecutionScheduler,
  partitionToolCalls,
  type PiToolCallDescriptor,
} from './pi-agent-adapter.ts'

function toolCall(id: string, name: string): PiToolCallDescriptor {
  return { id, name }
}

interface TestToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
}

interface TestTool {
  name: string
  executionMode?: 'parallel' | 'sequential'
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<TestToolResult>
}

interface TestBeforeToolCallContext {
  assistantMessage: object
  toolCall: PiToolCallDescriptor
}

interface TestAfterToolCallContext extends TestBeforeToolCallContext {
  result: TestToolResult
  isError: boolean
}

interface TestAgentSession {
  agent: {
    toolExecution: 'parallel' | 'sequential'
    state: { tools: TestTool[] }
    beforeToolCall?: (
      context: TestBeforeToolCallContext,
      signal?: AbortSignal,
    ) => Promise<{ block?: boolean; reason?: string } | undefined>
    afterToolCall?: (
      context: TestAfterToolCallContext,
      signal?: AbortSignal,
    ) => Promise<unknown>
  }
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function result(name: string): TestToolResult {
  return {
    content: [{ type: 'text', text: name }],
    details: {},
  }
}

describe('Pi 工具批次划分', () => {
  test('全只读批合并为一个并行组，并保留调用顺序', () => {
    const calls = [
      toolCall('read-1', 'read'),
      toolCall('grep-1', 'grep'),
      toolCall('find-1', 'find'),
      toolCall('ls-1', 'ls'),
      toolCall('task-get-1', 'TaskGet'),
      toolCall('task-list-1', 'TaskList'),
      toolCall('todo-read-1', 'TodoRead'),
    ]

    expect(partitionToolCalls(calls)).toEqual([
      { mode: 'parallel', toolCalls: calls },
    ])
  })

  test('全副作用批按原顺序拆成单调用串行组', () => {
    const calls = [
      toolCall('write-1', 'write'),
      toolCall('edit-1', 'edit'),
      toolCall('bash-1', 'bash'),
      toolCall('task-update-1', 'TaskUpdate'),
    ]

    expect(partitionToolCalls(calls)).toEqual([
      { mode: 'sequential', toolCalls: [calls[0]!] },
      { mode: 'sequential', toolCalls: [calls[1]!] },
      { mode: 'sequential', toolCalls: [calls[2]!] },
      { mode: 'sequential', toolCalls: [calls[3]!] },
    ])
  })

  test('混合批按原始顺序分段，连续只读调用才组成并行组', () => {
    const calls = [
      toolCall('write-1', 'write'),
      toolCall('read-1', 'read'),
      toolCall('task-create-1', 'TaskCreate'),
      toolCall('grep-1', 'grep'),
      toolCall('task-list-1', 'TaskList'),
      toolCall('edit-1', 'edit'),
    ]

    expect(partitionToolCalls(calls)).toEqual([
      { mode: 'sequential', toolCalls: [calls[0]!] },
      { mode: 'parallel', toolCalls: [calls[1]!] },
      { mode: 'sequential', toolCalls: [calls[2]!] },
      { mode: 'parallel', toolCalls: [calls[3]!, calls[4]!] },
      { mode: 'sequential', toolCalls: [calls[5]!] },
    ])
  })

  test('白名单外工具默认按副作用工具串行处理', () => {
    const calls = [
      toolCall('mcp-1', 'mcp__server__read'),
      toolCall('collaboration-1', 'collaboration'),
      toolCall('compact-1', 'CompactContext'),
      toolCall('unknown-1', 'FutureReadTool'),
    ]

    expect(partitionToolCalls(calls)).toEqual([
      { mode: 'sequential', toolCalls: [calls[0]!] },
      { mode: 'sequential', toolCalls: [calls[1]!] },
      { mode: 'sequential', toolCalls: [calls[2]!] },
      { mode: 'sequential', toolCalls: [calls[3]!] },
    ])
  })
})

describe('Pi 工具执行调度', () => {
  test('混合批保持原始顺序，连续只读段并行且按完成顺序 finalize', async () => {
    const events: string[] = []
    const writeGate = deferred()
    const readGate = deferred()
    const grepGate = deferred()
    const createTool = (name: string, gate?: Deferred): TestTool => ({
      name,
      async execute(toolCallId) {
        events.push(`${toolCallId}:start`)
        await gate?.promise
        events.push(`${toolCallId}:done`)
        return result(toolCallId)
      },
    })
    const session: TestAgentSession = {
      agent: {
        toolExecution: 'sequential',
        state: {
          tools: [
            createTool('write', writeGate),
            createTool('read', readGate),
            createTool('grep', grepGate),
            createTool('edit'),
          ],
        },
        beforeToolCall: async ({ toolCall: call }) => {
          events.push(`${call.id}:authorized`)
          return undefined
        },
        afterToolCall: async ({ toolCall: call }) => {
          events.push(`${call.id}:finalized`)
          return undefined
        },
      },
    }
    installPiToolExecutionScheduler(session as unknown as AgentSession)

    const calls = [
      toolCall('write-1', 'write'),
      toolCall('read-1', 'read'),
      toolCall('grep-1', 'grep'),
      toolCall('edit-1', 'edit'),
    ]
    const assistantMessage = { role: 'assistant', content: calls }
    for (const call of calls) {
      await session.agent.beforeToolCall?.({ assistantMessage, toolCall: call })
    }

    const executions = calls.map(async (call) => {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`测试工具不存在: ${call.name}`)
      const toolResult = await tool.execute(call.id, {})
      await session.agent.afterToolCall?.({
        assistantMessage,
        toolCall: call,
        result: toolResult,
        isError: false,
      })
      events.push(`${call.id}:returned`)
    })

    await flushAsyncWork()
    expect(session.agent.toolExecution).toBe('parallel')
    expect(events).toContain('write-1:start')
    expect(events).not.toContain('read-1:start')
    expect(events).not.toContain('grep-1:start')
    expect(events).not.toContain('edit-1:start')
    expect(events.filter((event) => event.endsWith(':authorized'))).toEqual([
      'write-1:authorized',
      'read-1:authorized',
      'grep-1:authorized',
      'edit-1:authorized',
    ])

    writeGate.resolve()
    await flushAsyncWork()
    expect(events).toContain('write-1:finalized')
    expect(events).toContain('read-1:start')
    expect(events).toContain('grep-1:start')
    expect(events).not.toContain('edit-1:start')

    grepGate.resolve()
    await flushAsyncWork()
    expect(events).toContain('grep-1:finalized')
    expect(events).toContain('grep-1:returned')
    expect(events).not.toContain('read-1:finalized')
    expect(events).not.toContain('edit-1:start')

    readGate.resolve()
    await Promise.all(executions)

    expect(events.indexOf('write-1:finalized')).toBeLessThan(events.indexOf('read-1:start'))
    expect(events.indexOf('grep-1:finalized')).toBeLessThan(events.indexOf('read-1:finalized'))
    expect(events.indexOf('read-1:finalized')).toBeLessThan(events.indexOf('edit-1:start'))
  })

  test('授权拒绝的调用不进入调度，后续副作用工具仍可执行', async () => {
    const events: string[] = []
    const createTool = (name: string): TestTool => ({
      name,
      async execute(toolCallId) {
        events.push(`${toolCallId}:start`)
        return result(toolCallId)
      },
    })
    const session: TestAgentSession = {
      agent: {
        toolExecution: 'sequential',
        state: { tools: [createTool('read'), createTool('write')] },
        beforeToolCall: async ({ toolCall: call }) => (
          call.name === 'read' ? { block: true, reason: 'blocked for test' } : undefined
        ),
        afterToolCall: async ({ toolCall: call }) => {
          events.push(`${call.id}:finalized`)
          return undefined
        },
      },
    }
    installPiToolExecutionScheduler(session as unknown as AgentSession)

    const calls = [toolCall('read-1', 'read'), toolCall('write-1', 'write')]
    const assistantMessage = { role: 'assistant', content: calls }
    const allowedCalls: PiToolCallDescriptor[] = []
    for (const call of calls) {
      const beforeResult = await session.agent.beforeToolCall?.({ assistantMessage, toolCall: call })
      if (!beforeResult?.block) allowedCalls.push(call)
    }
    for (const call of allowedCalls) {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`测试工具不存在: ${call.name}`)
      const toolResult = await tool.execute(call.id, {})
      await session.agent.afterToolCall?.({ assistantMessage, toolCall: call, result: toolResult, isError: false })
    }

    expect(events).not.toContain('read-1:start')
    expect(events).toEqual(['write-1:start', 'write-1:finalized'])
  })

  test('只读工具执行失败仍会 finalize 并释放后续副作用工具', async () => {
    const events: string[] = []
    const session: TestAgentSession = {
      agent: {
        toolExecution: 'sequential',
        state: {
          tools: [
            {
              name: 'read',
              async execute(toolCallId) {
                events.push(`${toolCallId}:start`)
                throw new Error('read failed')
              },
            },
            {
              name: 'write',
              async execute(toolCallId) {
                events.push(`${toolCallId}:start`)
                return result(toolCallId)
              },
            },
          ],
        },
        beforeToolCall: async () => undefined,
        afterToolCall: async ({ toolCall: call }) => {
          events.push(`${call.id}:finalized`)
          return undefined
        },
      },
    }
    installPiToolExecutionScheduler(session as unknown as AgentSession)

    const calls = [toolCall('read-1', 'read'), toolCall('write-1', 'write')]
    const assistantMessage = { role: 'assistant', content: calls }
    for (const call of calls) {
      await session.agent.beforeToolCall?.({ assistantMessage, toolCall: call })
    }
    await Promise.all(calls.map(async (call) => {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`测试工具不存在: ${call.name}`)
      let toolResult: TestToolResult
      let isError = false
      try {
        toolResult = await tool.execute(call.id, {})
      } catch {
        toolResult = result('error')
        isError = true
      }
      await session.agent.afterToolCall?.({ assistantMessage, toolCall: call, result: toolResult, isError })
    }))

    expect(events.indexOf('read-1:finalized')).toBeLessThan(events.indexOf('write-1:start'))
    expect(events).toContain('write-1:finalized')
  })

  test('后组等待期间 abort 时不启动副作用工具且调度能正常收束', async () => {
    const events: string[] = []
    const readGate = deferred()
    const controller = new AbortController()
    const createTool = (name: string, gate?: Deferred): TestTool => ({
      name,
      async execute(toolCallId) {
        events.push(`${toolCallId}:start`)
        await gate?.promise
        return result(toolCallId)
      },
    })
    const session: TestAgentSession = {
      agent: {
        toolExecution: 'sequential',
        state: { tools: [createTool('read', readGate), createTool('write')] },
        beforeToolCall: async () => undefined,
        afterToolCall: async ({ toolCall: call }) => {
          events.push(`${call.id}:finalized`)
          return undefined
        },
      },
    }
    installPiToolExecutionScheduler(session as unknown as AgentSession)

    const calls = [toolCall('read-1', 'read'), toolCall('write-1', 'write')]
    const assistantMessage = { role: 'assistant', content: calls }
    for (const call of calls) {
      await session.agent.beforeToolCall?.({ assistantMessage, toolCall: call }, controller.signal)
    }
    const executions = calls.map(async (call) => {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`测试工具不存在: ${call.name}`)
      let toolResult: TestToolResult
      let isError = false
      try {
        toolResult = await tool.execute(call.id, {}, controller.signal)
      } catch {
        toolResult = result('aborted')
        isError = true
      }
      await session.agent.afterToolCall?.({ assistantMessage, toolCall: call, result: toolResult, isError }, controller.signal)
    })

    await flushAsyncWork()
    expect(events).toContain('read-1:start')
    expect(events).not.toContain('write-1:start')

    controller.abort()
    await flushAsyncWork()
    expect(events).not.toContain('write-1:start')
    expect(events).toContain('write-1:finalized')

    readGate.resolve()
    await Promise.all(executions)
    expect(events).toContain('read-1:finalized')
  })
})
