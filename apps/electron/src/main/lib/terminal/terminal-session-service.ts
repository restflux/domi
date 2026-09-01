import { randomUUID } from 'node:crypto'
import {
  assertTerminalProfileSupported,
  parseTerminalProfile,
  type TerminalCreateInput,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalProfile,
  type TerminalReadResult,
  type TerminalSessionView,
  type TerminalSnapshot,
  type TerminalStateChange,
  type TerminalSourceTargetView,
} from '@domi/shared'
import { resolveTerminalCwd } from './terminal-cwd-policy.ts'
import { resolveAgentTerminalProfile } from './terminal-agent-run-spec.ts'
import { appendTerminalOutput, createTerminalOutputBuffer, readTerminalOutput, type TerminalOutputBuffer } from './terminal-output-buffer.ts'
import type { TerminalRuntimeCreateInput, TerminalRuntimeState } from './terminal-runtime-protocol.ts'

export interface TerminalRuntimePort {
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
  onFailure(listener: (error: Error) => void): () => void
  create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeState>
  input(terminalId: string, data: string): void
  resize(terminalId: string, cols: number, rows: number): void
  interrupt(terminalId: string): void
  kill(terminalId: string): void
  stop(): void
}

export interface TerminalOwnerContext {
  ownerSessionId: string
  source: 'interactive' | 'automation' | 'delegation'
  workspaceRoot: string
  allowedCwdRoots: string[]
  target: Omit<TerminalSourceTargetView, 'stale'>
  env: NodeJS.ProcessEnv
}

interface TerminalRecord {
  state: TerminalSessionView
  sourceTarget: Omit<TerminalSourceTargetView, 'stale'>
  output: TerminalOutputBuffer
  interruptRequested: boolean
}

export interface TerminalSessionServiceDependencies {
  runtime: TerminalRuntimePort
  resolveOwner: (ownerSessionId: string) => Promise<TerminalOwnerContext | undefined>
  createId?: () => string
  now?: () => number
  onOutput?: (event: TerminalOutputEvent) => void
  onStateChanged?: (event: TerminalStateChange) => void
}

export interface UserTerminalCreateOptions {
  profile?: TerminalProfile
  title?: string
  cwd?: string
  cols: number
  rows: number
}

export class TerminalSessionService {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly pending = new Map<string, Promise<TerminalSessionView>>()
  private readonly createId: () => string
  private readonly now: () => number
  private readonly disposeRuntimeListeners: Array<() => void>

  constructor(private readonly dependencies: TerminalSessionServiceDependencies) {
    this.createId = dependencies.createId ?? randomUUID
    this.now = dependencies.now ?? Date.now
    this.disposeRuntimeListeners = [
      dependencies.runtime.onOutput((event) => this.handleOutput(event)),
      dependencies.runtime.onExit((event) => this.handleExit(event)),
      dependencies.runtime.onFailure((error) => this.handleRuntimeFailure(error)),
    ]
  }

  async createUserShell(ownerSessionId: string, input: UserTerminalCreateOptions): Promise<TerminalSessionView> {
    const owner = await this.requireInteractiveOwner(ownerSessionId)
    const profile = assertTerminalProfileSupported(parseTerminalProfile(input.profile), process.platform)
    return this.create({
      owner,
      kind: 'user-shell',
      title: sanitizeTitle(input.title, '终端'),
      cwd: resolveTerminalCwd(owner.allowedCwdRoots, input.cwd),
      profile,
      cols: normalizeDimension(input.cols),
      rows: normalizeDimension(input.rows),
      mode: 'interactive-shell',
      shellPath: profile === 'git-bash' ? owner.env.CLAUDE_CODE_SHELL : undefined,
      wslDistro: profile === 'wsl' ? owner.env.DOMI_WSL_DISTRO : undefined,
    })
  }

  async runAgent(ownerSessionId: string, input: { command: string; cwd?: string; title?: string }): Promise<TerminalSessionView> {
    const owner = await this.requireInteractiveOwner(ownerSessionId)
    const command = input.command.trim()
    if (!command || command.length > 64 * 1024) throw new Error('终端命令为空或过长')
    const cwd = resolveTerminalCwd(owner.allowedCwdRoots, input.cwd)
    const profile = resolveAgentTerminalProfile({ env: owner.env })
    const shellPath = profile === 'git-bash' ? owner.env.CLAUDE_CODE_SHELL : undefined
    const wslDistro = profile === 'wsl' ? owner.env.DOMI_WSL_DISTRO : undefined
    const reusable = this.findReusableAgentRecord(owner, cwd, profile)
    return this.create({
      owner,
      ...(reusable ? { terminalId: reusable.state.terminalId } : {}),
      kind: 'agent-run',
      title: sanitizeTitle(input.title, `Agent · ${command.replace(/\s+/g, ' ').slice(0, 48)}`),
      cwd,
      profile,
      cols: 100,
      rows: 30,
      mode: 'agent-command',
      command,
      shellPath,
      wslDistro,
    })
  }

  async list(ownerSessionId: string): Promise<TerminalSessionView[]> {
    const owner = await this.requireOwner(ownerSessionId)
    return Promise.all([...this.records.values()]
      .filter((record) => record.state.ownerSessionId === owner.ownerSessionId)
      .map((record) => this.project(record, owner)))
  }

  async inspect(ownerSessionId: string, terminalId: string): Promise<TerminalSessionView> {
    const owner = await this.requireOwner(ownerSessionId)
    return this.project(this.requireOwnedRecord(ownerSessionId, terminalId), owner)
  }

  async snapshot(ownerSessionId: string, terminalId: string): Promise<TerminalSnapshot> {
    const owner = await this.requireOwner(ownerSessionId)
    const record = this.requireOwnedRecord(ownerSessionId, terminalId)
    return { state: await this.project(record, owner), output: record.output.output, sequence: record.output.sequence }
  }

  async readAgent(ownerSessionId: string, terminalId: string, offset?: number, limit?: number): Promise<TerminalReadResult> {
    const owner = await this.requireOwner(ownerSessionId)
    const record = this.requireOwnedRecord(ownerSessionId, terminalId)
    if (record.state.kind !== 'agent-run') throw new Error('Agent 不能读取用户终端。')
    return {
      terminal: await this.project(record, owner),
      read: readTerminalOutput(record.output, { offset, limit }),
    }
  }

  async input(ownerSessionId: string, terminalId: string, data: string): Promise<void> {
    this.requireInput(data)
    await this.assertCurrentOwner(ownerSessionId, terminalId)
    const record = this.records.get(terminalId)
    if (record?.state.status !== 'running') return
    this.dependencies.runtime.input(terminalId, data)
  }

  async resize(ownerSessionId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    await this.assertCurrentOwner(ownerSessionId, terminalId)
    const record = this.records.get(terminalId)
    if (record?.state.status !== 'running' && record?.state.status !== 'starting') return
    this.dependencies.runtime.resize(terminalId, normalizeDimension(cols), normalizeDimension(rows))
  }

  async interrupt(ownerSessionId: string, terminalId: string): Promise<boolean> {
    await this.assertCurrentOwner(ownerSessionId, terminalId)
    const record = this.records.get(terminalId)
    if (!record || record.state.status !== 'running') return false
    record.interruptRequested = true
    this.dependencies.runtime.interrupt(terminalId)
    return true
  }

  async close(ownerSessionId: string, terminalId: string): Promise<boolean> {
    await this.requireOwner(ownerSessionId)
    const record = this.records.get(terminalId)
    if (!record) return false
    this.assertOwner(record, ownerSessionId)
    this.records.delete(terminalId)
    this.dependencies.runtime.kill(terminalId)
    this.dependencies.onStateChanged?.({ terminalId, ownerSessionId, closed: true })
    return true
  }

  hasRunningOwner(ownerSessionId: string): boolean {
    return [...this.records.values()].some((record) => (
      record.state.ownerSessionId === ownerSessionId
      && (record.state.status === 'starting' || record.state.status === 'running')
    ))
  }

  async closeOwner(ownerSessionId: string): Promise<number> {
    const terminalIds = [...this.records.values()]
      .filter((record) => record.state.ownerSessionId === ownerSessionId)
      .map((record) => record.state.terminalId)
    for (const terminalId of terminalIds) {
      this.records.delete(terminalId)
      this.dependencies.runtime.kill(terminalId)
      this.dependencies.onStateChanged?.({ terminalId, ownerSessionId, closed: true })
    }
    return terminalIds.length
  }

  async dispose(): Promise<void> {
    for (const record of [...this.records.values()]) {
      this.dependencies.runtime.kill(record.state.terminalId)
    }
    this.records.clear()
    this.pending.clear()
    for (const dispose of this.disposeRuntimeListeners) dispose()
    this.dependencies.runtime.stop()
  }

  private async create(input: {
    owner: TerminalOwnerContext
    terminalId?: string
    kind: 'user-shell' | 'agent-run'
    title: string
    cwd: string
    profile: TerminalProfile
    cols: number
    rows: number
    mode: 'interactive-shell' | 'agent-command'
    command?: string
    shellPath?: string
    wslDistro?: string
  }): Promise<TerminalSessionView> {
    const terminalId = input.terminalId ?? this.createId()
    const starting: TerminalSessionView = {
      terminalId,
      ownerSessionId: input.owner.ownerSessionId,
      kind: input.kind,
      title: input.title,
      cwd: input.cwd,
      profile: input.profile,
      status: 'starting',
      startedAt: this.now(),
      sourceTarget: { ...input.owner.target, stale: false },
    }
    const previous = this.records.get(terminalId)
    const record: TerminalRecord = {
      state: starting,
      sourceTarget: input.owner.target,
      output: previous?.output ?? createTerminalOutputBuffer(),
      interruptRequested: false,
    }
    this.records.set(terminalId, record)
    this.dependencies.onStateChanged?.(starting)
    const creation = this.dependencies.runtime.create({
      terminalId,
      cwd: input.cwd,
      profile: input.profile,
      cols: input.cols,
      rows: input.rows,
      mode: input.mode,
      ...(input.command ? { command: input.command } : {}),
      ...(input.shellPath ? { shellPath: input.shellPath } : {}),
      ...(input.wslDistro ? { wslDistro: input.wslDistro } : {}),
    }).then((runtimeState) => {
      if (!this.records.has(terminalId)) {
        this.dependencies.runtime.kill(terminalId)
        throw new Error('终端已在创建完成前关闭')
      }
      record.state = { ...record.state, status: 'running', pid: runtimeState.pid }
      this.dependencies.onStateChanged?.(record.state)
      return record.state
    }).catch((error) => {
      if (this.records.has(terminalId)) {
        record.state = {
          ...record.state,
          status: 'failed',
          finishedAt: this.now(),
          error: error instanceof Error ? error.message : String(error),
        }
        this.dependencies.onStateChanged?.(record.state)
      }
      throw error
    }).finally(() => this.pending.delete(terminalId))
    this.pending.set(terminalId, creation)
    return creation
  }

  private findReusableAgentRecord(
    owner: TerminalOwnerContext,
    cwd: string,
    profile: TerminalProfile,
  ): TerminalRecord | undefined {
    return [...this.records.values()]
      .filter((record) => record.state.kind === 'agent-run'
        && record.state.ownerSessionId === owner.ownerSessionId
        && (record.state.status === 'exited' || record.state.status === 'stopped')
        && record.state.cwd === cwd
        && record.state.profile === profile
        && record.sourceTarget.kind === owner.target.kind
        && record.sourceTarget.checkoutId === owner.target.checkoutId
        && record.sourceTarget.revision === owner.target.revision)
      .sort((left, right) => right.state.startedAt - left.state.startedAt)[0]
  }

  private handleOutput(event: TerminalOutputEvent): void {
    const record = this.records.get(event.terminalId)
    if (!record) return
    const projectedEvent = event.sequence > record.output.sequence
      ? event
      : { ...event, sequence: record.output.sequence + 1 }
    record.output = appendTerminalOutput(record.output, projectedEvent, 500_000)
    this.dependencies.onOutput?.(projectedEvent)
  }

  private handleExit(event: TerminalExitEvent): void {
    const record = this.records.get(event.terminalId)
    if (!record) return
    record.state = {
      ...record.state,
      status: record.interruptRequested ? 'stopped' : 'exited',
      finishedAt: this.now(),
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    }
    this.dependencies.onStateChanged?.(record.state)
  }

  private handleRuntimeFailure(error: Error): void {
    for (const record of this.records.values()) {
      if (record.state.status !== 'starting' && record.state.status !== 'running') continue
      record.state = { ...record.state, status: 'failed', finishedAt: this.now(), error: error.message }
      this.dependencies.onStateChanged?.(record.state)
    }
  }

  private async project(record: TerminalRecord, owner: TerminalOwnerContext): Promise<TerminalSessionView> {
    this.assertOwner(record, owner.ownerSessionId)
    const stale = owner.target.kind !== record.sourceTarget.kind
      || owner.target.checkoutId !== record.sourceTarget.checkoutId
      || owner.target.revision !== record.sourceTarget.revision
    return { ...record.state, sourceTarget: { ...record.sourceTarget, stale } }
  }

  private async assertCurrentOwner(ownerSessionId: string, terminalId: string): Promise<TerminalOwnerContext> {
    const owner = await this.requireOwner(ownerSessionId)
    this.assertOwner(this.requireOwnedRecord(ownerSessionId, terminalId), owner.ownerSessionId)
    return owner
  }

  private requireOwnedRecord(ownerSessionId: string, terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId)
    if (!record) throw new Error('终端不存在或已关闭。')
    this.assertOwner(record, ownerSessionId)
    return record
  }

  private assertOwner(record: TerminalRecord, ownerSessionId: string): void {
    if (record.state.ownerSessionId !== ownerSessionId) throw new Error('终端不属于当前会话。')
  }

  private async requireInteractiveOwner(ownerSessionId: string): Promise<TerminalOwnerContext> {
    const owner = await this.requireOwner(ownerSessionId)
    if (owner.source !== 'interactive') throw new Error('Automation 和 Delegation 不能创建交互终端。')
    return owner
  }

  private async requireOwner(ownerSessionId: string): Promise<TerminalOwnerContext> {
    if (!ownerSessionId || ownerSessionId.length > 200) throw new Error('终端 owner session 无效。')
    const owner = await this.dependencies.resolveOwner(ownerSessionId)
    if (!owner || owner.ownerSessionId !== ownerSessionId) throw new Error('Agent 会话不存在。')
    return owner
  }

  private requireInput(data: string): void {
    if (typeof data !== 'string' || data.length < 1 || data.length > 64 * 1024 || data.includes('\0')) {
      throw new Error('终端输入无效。')
    }
  }
}

function sanitizeTitle(value: string | undefined, fallback: string): string {
  const title = value?.trim().replace(/[\0\r\n]/g, ' ').slice(0, 80)
  return title || fallback
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.min(500, Math.max(1, Math.floor(value)))
}
