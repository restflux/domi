import { join } from 'node:path'
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import type { TerminalExitEvent, TerminalOutputEvent } from '@domi/shared'
import type {
  TerminalRuntimeCreateInput,
  TerminalRuntimeMessage,
  TerminalRuntimeRequest,
  TerminalRuntimeState,
} from './terminal-runtime-protocol.ts'

interface RuntimePort extends Pick<MessagePortMain, 'close' | 'postMessage' | 'start'> {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

interface PendingCreate {
  resolve: (state: TerminalRuntimeState) => void
  reject: (reason: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const STARTUP_TIMEOUT_MS = 10_000

export class TerminalRuntimeClient {
  private port?: RuntimePort
  private runtimeProcess?: UtilityProcess
  private starting?: Promise<void>
  private pendingCreates = new Map<string, PendingCreate>()
  private outputListeners = new Set<(event: TerminalOutputEvent) => void>()
  private exitListeners = new Set<(event: TerminalExitEvent) => void>()
  private failureListeners = new Set<(error: Error) => void>()

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  async create(input: TerminalRuntimeCreateInput): Promise<TerminalRuntimeState> {
    await this.start()
    if (this.pendingCreates.has(input.terminalId)) throw new Error('终端正在创建中')
    const promise = new Promise<TerminalRuntimeState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingCreates.delete(input.terminalId)) return
        this.kill(input.terminalId)
        reject(new Error('终端创建超时'))
      }, STARTUP_TIMEOUT_MS)
      this.pendingCreates.set(input.terminalId, { resolve, reject, timeout })
    })
    this.post({ type: 'terminal.create', input })
    return promise
  }

  input(terminalId: string, data: string): void {
    this.post({ type: 'terminal.input', terminalId, data })
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.post({ type: 'terminal.resize', terminalId, cols, rows })
  }

  interrupt(terminalId: string): void {
    this.post({ type: 'terminal.interrupt', terminalId })
  }

  kill(terminalId: string): void {
    this.post({ type: 'terminal.kill', terminalId })
  }

  stop(): void {
    const port = this.port
    this.port = undefined
    if (port) {
      port.postMessage({ type: 'terminal.shutdown' } satisfies TerminalRuntimeRequest)
      port.close()
    }
    this.runtimeProcess?.kill()
    this.runtimeProcess = undefined
    this.starting = undefined
    this.rejectPendingCreates(new Error('终端运行时已停止'))
  }

  private async start(): Promise<void> {
    if (this.port) return
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const runtimeProcess = utilityProcess.fork(join(__dirname, 'terminal-runtime.cjs'), [], {
        serviceName: 'Domi Terminal Runtime',
      })
      this.runtimeProcess = runtimeProcess
      const channel = new MessageChannelMain()
      const port = channel.port2 as unknown as RuntimePort
      let settled = false
      const complete = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        action()
      }
      const fail = (error: Error): void => complete(() => {
        this.handleRuntimeFailure(error)
        reject(error)
      })
      const timeout = setTimeout(() => fail(new Error('终端运行时启动超时')), STARTUP_TIMEOUT_MS)
      this.port = port
      port.on('message', ({ data }) => {
        const message = data as TerminalRuntimeMessage
        if (message?.type === 'terminal.ready') complete(resolve)
        this.handleMessage(message)
      })
      port.start()
      runtimeProcess.on('error', (type) => {
        const error = new Error(`终端运行时错误：${type}`)
        if (settled) this.handleRuntimeFailure(error)
        else fail(error)
      })
      runtimeProcess.on('exit', (code) => {
        const error = new Error(`终端运行时已退出（${code}）`)
        if (settled) this.handleRuntimeFailure(error)
        else fail(error)
      })
      runtimeProcess.postMessage({ type: 'domi-terminal-runtime-port' }, [channel.port1])
    }).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private handleMessage(message: TerminalRuntimeMessage): void {
    if (message.type === 'terminal.created') {
      const pending = this.pendingCreates.get(message.state.terminalId)
      this.pendingCreates.delete(message.state.terminalId)
      if (pending) clearTimeout(pending.timeout)
      pending?.resolve(message.state)
      return
    }
    if (message.type === 'terminal.error') {
      const pending = this.pendingCreates.get(message.terminalId)
      this.pendingCreates.delete(message.terminalId)
      if (pending) clearTimeout(pending.timeout)
      pending?.reject(new Error(message.message))
      return
    }
    if (message.type === 'terminal.output') {
      for (const listener of this.outputListeners) listener(message.event)
      this.port?.postMessage({
        type: 'terminal.ack-output',
        terminalId: message.event.terminalId,
        sequence: message.event.sequence,
      } satisfies TerminalRuntimeRequest)
      return
    }
    if (message.type === 'terminal.exit') {
      for (const listener of this.exitListeners) listener(message.event)
    }
  }

  private handleRuntimeFailure(error: Error): void {
    this.port?.close()
    this.port = undefined
    this.runtimeProcess = undefined
    this.rejectPendingCreates(error)
    for (const listener of this.failureListeners) listener(error)
  }

  private rejectPendingCreates(error: Error): void {
    for (const pending of this.pendingCreates.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingCreates.clear()
  }

  private post(request: TerminalRuntimeRequest): void {
    if (!this.port) throw new Error('终端运行时未启动')
    this.port.postMessage(request)
  }
}

export const terminalRuntimeClient = new TerminalRuntimeClient()
