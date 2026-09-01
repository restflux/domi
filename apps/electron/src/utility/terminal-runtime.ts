import { existsSync, statSync } from 'node:fs'
import { spawn, type IPty } from 'node-pty'
import type { TerminalExitEvent, TerminalOutputEvent } from '@domi/shared'
import {
  isTerminalRuntimeRequest,
  type TerminalRuntimeCreateInput,
  type TerminalRuntimeMessage,
} from '../main/lib/terminal/terminal-runtime-protocol.ts'
import { resolveTerminalShell } from './terminal-shell-resolver.ts'

interface MessagePortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
  start(): void
  close(): void
}

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown; ports?: MessagePortLike[] }) => void): void
  start?: () => void
}

interface ManagedTerminal {
  pty: IPty
  output: string
  droppedOutputChars: number
  nextSequence: number
  inFlight?: { sequence: number; data: string }
  flushTimer?: ReturnType<typeof setTimeout>
  exitEvent?: TerminalExitEvent
}

const MAX_PENDING_OUTPUT_CHARS = 1_000_000
const OUTPUT_FLUSH_DELAY_MS = 16
const terminals = new Map<string, ManagedTerminal>()
const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort
let runtimePort: MessagePortLike | undefined

if (!parentPort) {
  console.error('[TerminalRuntime] Electron parentPort 不可用')
  process.exit(1)
}

parentPort.on('message', (event) => {
  const data = event.data as { type?: unknown } | undefined
  if (data?.type !== 'domi-terminal-runtime-port') return
  const port = event.ports?.[0]
  if (!port) {
    console.error('[TerminalRuntime] MessagePort bootstrap 无效')
    process.exit(1)
  }
  runtimePort?.close()
  runtimePort = port
  port.on('message', (message) => handleRequest(message.data))
  port.start()
  post({ type: 'terminal.ready', pid: process.pid })
})
parentPort.start?.()

function handleRequest(raw: unknown): void {
  if (!isTerminalRuntimeRequest(raw)) return
  switch (raw.type) {
    case 'terminal.create':
      createTerminal(raw.input)
      return
    case 'terminal.input':
      terminals.get(raw.terminalId)?.pty.write(raw.data)
      return
    case 'terminal.resize':
      terminals.get(raw.terminalId)?.pty.resize(normalizeDimension(raw.cols), normalizeDimension(raw.rows))
      return
    case 'terminal.interrupt':
      terminals.get(raw.terminalId)?.pty.write('\x03')
      return
    case 'terminal.kill':
      destroyTerminal(raw.terminalId)
      return
    case 'terminal.ack-output':
      acknowledgeOutput(raw.terminalId, raw.sequence)
      return
    case 'terminal.shutdown':
      for (const terminalId of [...terminals.keys()]) destroyTerminal(terminalId)
      post({ type: 'terminal.stopped' })
  }
}

function createTerminal(input: TerminalRuntimeCreateInput): void {
  if (terminals.has(input.terminalId)) return
  try {
    if (!isDirectory(input.cwd)) throw new Error(`终端工作目录不存在：${input.cwd}`)
    const shell = resolveTerminalShell({
      profile: input.profile,
      mode: input.mode,
      command: input.command,
      cwd: input.cwd,
      shellPath: input.shellPath,
      wslDistro: input.wslDistro,
    })
    const pty = spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: normalizeDimension(input.cols),
      rows: normalizeDimension(input.rows),
      cwd: input.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const terminal: ManagedTerminal = {
      pty,
      output: '',
      droppedOutputChars: 0,
      nextSequence: 1,
    }
    terminals.set(input.terminalId, terminal)
    post({
      type: 'terminal.created',
      state: {
        terminalId: input.terminalId,
        title: shell.title,
        cwd: input.cwd,
        profile: input.profile,
        pid: pty.pid,
      },
    })
    pty.onData((data) => enqueueOutput(input.terminalId, data))
    pty.onExit(({ exitCode, signal }) => {
      const event: TerminalExitEvent = {
        terminalId: input.terminalId,
        exitCode,
        ...(signal === undefined ? {} : { signal }),
      }
      const current = terminals.get(input.terminalId)
      if (!current) {
        post({ type: 'terminal.exit', event })
        return
      }
      current.exitEvent = event
      flushOutput(input.terminalId)
      emitExitWhenDrained(input.terminalId)
    })
  } catch (error) {
    post({
      type: 'terminal.error',
      terminalId: input.terminalId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function enqueueOutput(terminalId: string, data: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal) return
  const remaining = MAX_PENDING_OUTPUT_CHARS - terminal.output.length
  if (remaining <= 0) {
    terminal.droppedOutputChars += data.length
    return
  }
  if (data.length > remaining) terminal.droppedOutputChars += data.length - remaining
  terminal.output += data.length > remaining ? data.slice(0, remaining) : data
  terminal.flushTimer ??= setTimeout(() => flushOutput(terminalId), OUTPUT_FLUSH_DELAY_MS)
}

function flushOutput(terminalId: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal) return
  if (terminal.flushTimer) clearTimeout(terminal.flushTimer)
  terminal.flushTimer = undefined
  if (terminal.inFlight) return
  if (!terminal.output && terminal.droppedOutputChars === 0) return
  const lossMarker = terminal.droppedOutputChars > 0
    ? `\r\n\x1b[33m[Domi：终端输出过快，已丢弃 ${terminal.droppedOutputChars} 个字符]\x1b[0m\r\n`
    : ''
  const data = terminal.output + lossMarker
  terminal.output = ''
  terminal.droppedOutputChars = 0
  const sequence = terminal.nextSequence++
  terminal.inFlight = { sequence, data }
  const event: TerminalOutputEvent = { terminalId, sequence, data }
  post({ type: 'terminal.output', event })
}

function acknowledgeOutput(terminalId: string, sequence: number): void {
  const terminal = terminals.get(terminalId)
  if (!terminal?.inFlight || terminal.inFlight.sequence !== sequence) return
  terminal.inFlight = undefined
  flushOutput(terminalId)
  emitExitWhenDrained(terminalId)
}

function emitExitWhenDrained(terminalId: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal?.exitEvent || terminal.inFlight || terminal.output) return
  post({ type: 'terminal.exit', event: terminal.exitEvent })
  terminals.delete(terminalId)
}

function destroyTerminal(terminalId: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal) return
  if (terminal.flushTimer) clearTimeout(terminal.flushTimer)
  terminals.delete(terminalId)
  try {
    terminal.pty.kill()
  } catch {
    // PTY 可能已退出；清理保持幂等。
  }
}

function isDirectory(path: string): boolean {
  if (!path || !existsSync(path)) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.min(500, Math.max(1, Math.floor(value))) : 80
}

function post(message: TerminalRuntimeMessage): void {
  runtimePort?.postMessage(message)
}
