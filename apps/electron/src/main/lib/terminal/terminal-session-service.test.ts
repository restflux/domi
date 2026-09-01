import { describe, expect, test } from 'bun:test'
import type { TerminalExitEvent, TerminalOutputEvent } from '@domi/shared'
import { TerminalSessionService, type TerminalRuntimePort } from './terminal-session-service.ts'
import type { TerminalRuntimeCreateInput, TerminalRuntimeState } from './terminal-runtime-protocol.ts'

class FakeRuntime implements TerminalRuntimePort {
  creates: TerminalRuntimeCreateInput[] = []
  inputs: Array<{ terminalId: string; data: string }> = []
  killed: string[] = []
  interrupted: string[] = []
  private outputListener?: (event: TerminalOutputEvent) => void
  private exitListener?: (event: TerminalExitEvent) => void

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void { this.outputListener = listener; return () => {} }
  onExit(listener: (event: TerminalExitEvent) => void): () => void { this.exitListener = listener; return () => {} }
  onFailure(): () => void { return () => {} }
  async create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeState> {
    this.creates.push(input)
    return { terminalId: input.terminalId, title: 'Bash', cwd: input.cwd, profile: input.profile, pid: 42 }
  }
  input(terminalId: string, data: string): void { this.inputs.push({ terminalId, data }) }
  resize(): void {}
  interrupt(terminalId: string): void { this.interrupted.push(terminalId) }
  kill(terminalId: string): void { this.killed.push(terminalId) }
  stop(): void {}
  output(event: TerminalOutputEvent): void { this.outputListener?.(event) }
  exit(event: TerminalExitEvent): void { this.exitListener?.(event) }
}

function setup() {
  const runtime = new FakeRuntime()
  let revision = 3
  let terminalSequence = 0
  const stateEvents: unknown[] = []
  const service = new TerminalSessionService({
    runtime,
    createId: () => `terminal-${++terminalSequence}`,
    resolveOwner: async (ownerSessionId) => ({
      ownerSessionId,
      source: 'interactive',
      workspaceRoot: process.cwd(),
      allowedCwdRoots: [process.cwd()],
      target: { kind: 'isolated', checkoutId: 'checkout-1', revision },
      env: process.platform === 'win32'
        ? { DOMI_WINDOWS_SHELL: 'git-bash', CLAUDE_CODE_SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' }
        : {},
    }),
    onStateChanged: (event) => stateEvents.push(event),
  })
  return { runtime, service, stateEvents, setRevision: (next: number) => { revision = next } }
}

describe('TerminalSessionService', () => {
  test('runs one Agent command in a dedicated PTY and records the real exit code', async () => {
    const { runtime, service } = setup()
    const running = await service.runAgent('session-1', { command: 'bun run dev', title: 'Dev server' })
    expect(running.kind).toBe('agent-run')
    expect(running.status).toBe('running')
    expect(runtime.creates[0]).toMatchObject({
      mode: 'agent-command',
      command: 'bun run dev',
      ...(process.platform === 'win32' ? { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
    })

    runtime.exit({ terminalId: running.terminalId, exitCode: 7 })
    const exited = await service.inspect('session-1', running.terminalId)
    expect(exited.status).toBe('exited')
    expect(exited.exitCode).toBe(7)
    expect(exited.finishedAt).toBeNumber()
  })

  test('opens an explicit project directory in a user-owned embedded shell', async () => {
    const { runtime, service } = setup()
    const terminal = await service.createUserShell('session-1', {
      cwd: 'apps/electron',
      cols: 80,
      rows: 24,
    } as never)

    expect(terminal.cwd.replace(/\\/g, '/')).toEndWith('/apps/electron')
    expect(runtime.creates[0]?.cwd.replace(/\\/g, '/')).toEndWith('/apps/electron')
  })

  test('reuses one compatible exited Agent terminal tab without touching user terminals', async () => {
    const { runtime, service } = setup()
    const first = await service.runAgent('session-1', { command: 'printf first', cwd: 'apps/electron' })
    runtime.output({ terminalId: first.terminalId, sequence: 1, data: 'first output\n' })
    runtime.exit({ terminalId: first.terminalId, exitCode: 0 })
    const userTerminal = await service.createUserShell('session-1', { cols: 80, rows: 24 })
    runtime.exit({ terminalId: userTerminal.terminalId, exitCode: 0 })

    const second = await service.runAgent('session-1', { command: 'printf second', cwd: 'apps/electron' })

    expect(second.terminalId).toBe(first.terminalId)
    expect(second.terminalId).not.toBe(userTerminal.terminalId)
    expect(runtime.creates.map((input) => input.terminalId)).toEqual([
      first.terminalId,
      userTerminal.terminalId,
      first.terminalId,
    ])
    runtime.output({ terminalId: second.terminalId, sequence: 1, data: 'second output\n' })
    await expect(service.snapshot('session-1', second.terminalId)).resolves.toMatchObject({
      sequence: 2,
      output: expect.stringContaining('first output'),
    })
    expect((await service.snapshot('session-1', second.terminalId)).output).toContain('second output')
  })

  test('does not reuse an Agent terminal after the Session Target revision changes', async () => {
    const { runtime, service, setRevision } = setup()
    const first = await service.runAgent('session-1', { command: 'printf first', cwd: 'apps/electron' })
    runtime.exit({ terminalId: first.terminalId, exitCode: 0 })
    setRevision(4)

    const second = await service.runAgent('session-1', { command: 'printf second', cwd: 'apps/electron' })

    expect(second.terminalId).not.toBe(first.terminalId)
  })

  test('does not expose user terminal output through Agent read', async () => {
    const { service } = setup()
    const terminal = await service.createUserShell('session-1', { cols: 80, rows: 24 })
    await expect(service.readAgent('session-1', terminal.terminalId)).rejects.toThrow('用户终端')
  })

  test('enforces session ownership', async () => {
    const { service } = setup()
    const terminal = await service.runAgent('session-1', { command: 'sleep 10' })
    await expect(service.inspect('session-2', terminal.terminalId)).rejects.toThrow('不属于当前会话')
  })

  test('marks an existing terminal stale after target revision changes', async () => {
    const { service, setRevision } = setup()
    const terminal = await service.runAgent('session-1', { command: 'sleep 10' })
    setRevision(4)
    const inspected = await service.inspect('session-1', terminal.terminalId)
    expect(inspected.sourceTarget?.stale).toBe(true)
  })

  test('records an interrupted run as stopped after the PTY exits', async () => {
    const { runtime, service } = setup()
    const terminal = await service.runAgent('session-1', { command: 'sleep 10' })
    expect(await service.interrupt('session-1', terminal.terminalId)).toBe(true)
    runtime.exit({ terminalId: terminal.terminalId, exitCode: 130, signal: 2 })
    expect((await service.inspect('session-1', terminal.terminalId)).status).toBe('stopped')
  })

  test('reports a running owner so session deletion cannot orphan a PTY', async () => {
    const { runtime, service } = setup()
    const terminal = await service.runAgent('session-1', { command: 'sleep 10' })
    expect(service.hasRunningOwner('session-1')).toBe(true)
    runtime.exit({ terminalId: terminal.terminalId, exitCode: 0 })
    expect(service.hasRunningOwner('session-1')).toBe(false)
  })

  test('keeps cleanup idempotent', async () => {
    const { runtime, service } = setup()
    const terminal = await service.runAgent('session-1', { command: 'sleep 10' })
    expect(await service.close('session-1', terminal.terminalId)).toBe(true)
    expect(await service.close('session-1', terminal.terminalId)).toBe(false)
    expect(runtime.killed).toEqual([terminal.terminalId])
  })
})
