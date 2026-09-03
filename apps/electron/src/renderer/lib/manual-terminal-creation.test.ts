import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import { createManualTerminal, type ManualTerminalCreationGuard } from './manual-terminal-creation.ts'

const terminal = (presentation: 'dock' | 'workspace'): TerminalSessionView => ({
  terminalId: `${presentation}-terminal`,
  ownerSessionId: 'session-1',
  kind: 'user-shell',
  presentation,
  title: '终端',
  cwd: '/repo',
  profile: 'bash',
  status: 'running',
  startedAt: 1,
})

describe('手动终端创建', () => {
  test('一次点击立即按目标区域创建 Shell', async () => {
    const inputs: unknown[] = []
    const guard: ManualTerminalCreationGuard = { pending: false }

    const created = await createManualTerminal(guard, {
      create: async (input) => {
        inputs.push(input)
        return terminal('workspace')
      },
      onError: () => {},
    }, {
      ownerSessionId: 'session-1',
      presentation: 'workspace',
      cols: 80,
      rows: 28,
    })

    expect(inputs).toEqual([{
      ownerSessionId: 'session-1',
      presentation: 'workspace',
      cols: 80,
      rows: 28,
    }])
    expect(created?.presentation).toBe('workspace')
    expect(guard.pending).toBe(false)
  })

  test('创建进行中忽略重复点击', async () => {
    const guard: ManualTerminalCreationGuard = { pending: false }
    let createCount = 0
    let resolveCreate: ((value: TerminalSessionView) => void) | undefined
    const dependencies = {
      create: async () => {
        createCount += 1
        return new Promise<TerminalSessionView>((resolve) => { resolveCreate = resolve })
      },
      onError: () => {},
    }

    const first = createManualTerminal(guard, dependencies, {
      ownerSessionId: 'session-1', presentation: 'dock', cols: 100, rows: 28,
    })
    const second = await createManualTerminal(guard, dependencies, {
      ownerSessionId: 'session-1', presentation: 'dock', cols: 100, rows: 28,
    })

    expect(second).toBeNull()
    expect(createCount).toBe(1)
    resolveCreate?.(terminal('dock'))
    expect((await first)?.presentation).toBe('dock')
  })

  test('创建失败时反馈错误并释放重复点击防护', async () => {
    const guard: ManualTerminalCreationGuard = { pending: false }
    const errors: unknown[] = []

    const created = await createManualTerminal(guard, {
      create: async () => { throw new Error('spawn failed') },
      onError: (error) => errors.push(error),
    }, {
      ownerSessionId: 'session-1', presentation: 'workspace', cols: 80, rows: 28,
    })

    expect(created).toBeNull()
    expect(errors).toHaveLength(1)
    expect(guard.pending).toBe(false)
  })
})
