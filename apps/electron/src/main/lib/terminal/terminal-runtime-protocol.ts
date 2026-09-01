import type {
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalProfile,
} from '@domi/shared'

export interface TerminalRuntimeCreateInput {
  terminalId: string
  cwd: string
  profile: TerminalProfile
  cols: number
  rows: number
  mode: 'interactive-shell' | 'agent-command'
  command?: string
  /** Main 从受信 RuntimeEnv 解析出的 Shell，不接受 Renderer 输入。 */
  shellPath?: string
  wslDistro?: string
}

export interface TerminalRuntimeState {
  terminalId: string
  title: string
  cwd: string
  profile: TerminalProfile
  pid: number
}

export type TerminalRuntimeRequest =
  | { type: 'terminal.create'; input: TerminalRuntimeCreateInput }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.interrupt'; terminalId: string }
  | { type: 'terminal.kill'; terminalId: string }
  | { type: 'terminal.ack-output'; terminalId: string; sequence: number }
  | { type: 'terminal.shutdown' }

export type TerminalRuntimeMessage =
  | { type: 'terminal.ready'; pid: number }
  | { type: 'terminal.created'; state: TerminalRuntimeState }
  | { type: 'terminal.output'; event: TerminalOutputEvent }
  | { type: 'terminal.exit'; event: TerminalExitEvent }
  | { type: 'terminal.error'; terminalId: string; message: string }
  | { type: 'terminal.stopped' }

export function isTerminalRuntimeRequest(value: unknown): value is TerminalRuntimeRequest {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'terminal.create'
    || type === 'terminal.input'
    || type === 'terminal.resize'
    || type === 'terminal.interrupt'
    || type === 'terminal.kill'
    || type === 'terminal.ack-output'
    || type === 'terminal.shutdown'
}
