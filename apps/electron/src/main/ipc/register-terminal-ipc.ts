import {
  TERMINAL_IPC_CHANNELS,
  isTerminalProfile,
  type TerminalCreateInput,
  type TerminalInput,
  type TerminalOwnerInput,
  type TerminalResizeInput,
} from '@domi/shared'
import type { TerminalSessionService } from '../lib/terminal/terminal-session-service.ts'

interface TerminalIpcRegistrar {
  handle(channel: string, listener: (event: { sender: { id: number } }, input: unknown) => unknown): void
}

export interface TerminalIpcGuard {
  assertSender(senderId: number): void
}

export function registerTerminalIpc(
  ipc: TerminalIpcRegistrar,
  terminal: Pick<TerminalSessionService, 'createUserShell' | 'list' | 'inspect' | 'snapshot' | 'input' | 'resize' | 'interrupt' | 'close'>,
  guard: TerminalIpcGuard,
): void {
  const register = <T>(channel: string, parse: (input: unknown) => T, run: (input: T) => unknown): void => {
    ipc.handle(channel, async (event, rawInput) => {
      guard.assertSender(event.sender.id)
      return run(parse(rawInput))
    })
  }

  register(TERMINAL_IPC_CHANNELS.CREATE, parseCreate, (input) => terminal.createUserShell(input.ownerSessionId, input))
  register(TERMINAL_IPC_CHANNELS.LIST, parseOwnerOnly, (input) => terminal.list(input.ownerSessionId))
  register(TERMINAL_IPC_CHANNELS.INSPECT, parseOwner, (input) => terminal.inspect(input.ownerSessionId, input.terminalId))
  register(TERMINAL_IPC_CHANNELS.SNAPSHOT, parseOwner, (input) => terminal.snapshot(input.ownerSessionId, input.terminalId))
  register(TERMINAL_IPC_CHANNELS.INPUT, parseInput, (input) => terminal.input(input.ownerSessionId, input.terminalId, input.data))
  register(TERMINAL_IPC_CHANNELS.RESIZE, parseResize, (input) => terminal.resize(input.ownerSessionId, input.terminalId, input.cols, input.rows))
  register(TERMINAL_IPC_CHANNELS.INTERRUPT, parseOwner, (input) => terminal.interrupt(input.ownerSessionId, input.terminalId))
  register(TERMINAL_IPC_CHANNELS.CLOSE, parseOwner, (input) => terminal.close(input.ownerSessionId, input.terminalId))
}

function parseCreate(input: unknown): TerminalCreateInput {
  const value = requireRecord(input, ['ownerSessionId', 'profile', 'presentation', 'title', 'cwd', 'cols', 'rows'], ['ownerSessionId', 'cols', 'rows'])
  if (value.profile !== undefined && !isTerminalProfile(value.profile)) invalid()
  if (value.presentation !== undefined && value.presentation !== 'dock' && value.presentation !== 'workspace') invalid()
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 80)) invalid()
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    ...(value.profile === undefined ? {} : { profile: value.profile }),
    ...(value.presentation === undefined ? {} : { presentation: value.presentation }),
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.cwd === undefined ? {} : { cwd: requireCwd(value.cwd) }),
    cols: requireDimension(value.cols),
    rows: requireDimension(value.rows),
  }
}

function parseOwnerOnly(input: unknown): Pick<TerminalOwnerInput, 'ownerSessionId'> {
  const value = requireRecord(input, ['ownerSessionId'])
  return { ownerSessionId: requireId(value.ownerSessionId) }
}

function parseOwner(input: unknown): TerminalOwnerInput {
  const value = requireRecord(input, ['ownerSessionId', 'terminalId'])
  return { ownerSessionId: requireId(value.ownerSessionId), terminalId: requireId(value.terminalId) }
}

function parseInput(input: unknown): TerminalInput {
  const value = requireRecord(input, ['ownerSessionId', 'terminalId', 'data'])
  if (typeof value.data !== 'string' || value.data.length < 1 || value.data.length > 64 * 1024 || value.data.includes('\0')) invalid()
  return { ownerSessionId: requireId(value.ownerSessionId), terminalId: requireId(value.terminalId), data: value.data }
}

function parseResize(input: unknown): TerminalResizeInput {
  const value = requireRecord(input, ['ownerSessionId', 'terminalId', 'cols', 'rows'])
  return {
    ownerSessionId: requireId(value.ownerSessionId),
    terminalId: requireId(value.terminalId),
    cols: requireDimension(value.cols),
    rows: requireDimension(value.rows),
  }
}

function requireRecord(input: unknown, allowedKeys: string[], requiredKeys = allowedKeys): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const value = input as Record<string, unknown>
  const keys = Object.keys(value)
  if (keys.some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !(key in value))) invalid()
  return value
}

function requireId(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 200 || /[\0\r\n]/.test(input)) invalid()
  return input
}

function requireCwd(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length < 1 || input.length > 4096 || input.includes('\0')) invalid()
  return input
}

function requireDimension(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 500) invalid()
  return input as number
}

function invalid(): never {
  throw new Error('终端 IPC 请求无效。')
}
