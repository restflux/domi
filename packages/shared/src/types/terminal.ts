export type TerminalKind = 'user-shell' | 'agent-run'
export type TerminalPresentation = 'dock' | 'workspace'
export type TerminalStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed'
export type TerminalProfile = 'default' | 'zsh' | 'bash' | 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl'

const POSIX_TERMINAL_PROFILES = ['default', 'zsh', 'bash'] as const satisfies readonly TerminalProfile[]
const WINDOWS_TERMINAL_PROFILES = ['default', 'pwsh', 'powershell', 'cmd', 'git-bash', 'wsl'] as const satisfies readonly TerminalProfile[]

export function getTerminalProfilesForPlatform(platform: string): readonly TerminalProfile[] {
  if (platform === 'win32') return WINDOWS_TERMINAL_PROFILES
  if (platform === 'darwin' || platform === 'linux') return POSIX_TERMINAL_PROFILES
  return ['default']
}

export function assertTerminalProfileSupported(profile: TerminalProfile, platform: string): TerminalProfile {
  if (getTerminalProfilesForPlatform(platform).includes(profile)) return profile
  throw new Error(`Shell ${profile} 不支持当前平台 ${platform}；可选值：${getTerminalProfilesForPlatform(platform).join('、')}`)
}

export function isTerminalProfile(value: unknown): value is TerminalProfile {
  return value === 'default'
    || value === 'zsh'
    || value === 'bash'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'cmd'
    || value === 'git-bash'
    || value === 'wsl'
}

export function parseTerminalProfile(value: unknown): TerminalProfile {
  if (value === undefined || value === null || value === '') return 'default'
  if (!isTerminalProfile(value)) throw new Error('终端 Shell 类型无效。')
  return value
}

export interface TerminalSourceTargetView {
  kind: 'local' | 'isolated'
  checkoutId?: string
  revision: number
  stale: boolean
}

export interface TerminalAppearance {
  fontFamily: string
  fontSize?: number
  theme?: {
    background?: string
    foreground?: string
    cursor?: string
    cursorAccent?: string
    selectionBackground?: string
    selectionInactiveBackground?: string
    black?: string
    red?: string
    green?: string
    yellow?: string
    blue?: string
    magenta?: string
    cyan?: string
    white?: string
    brightBlack?: string
    brightRed?: string
    brightGreen?: string
    brightYellow?: string
    brightBlue?: string
    brightMagenta?: string
    brightCyan?: string
    brightWhite?: string
  }
  source: 'custom' | 'system' | 'fallback'
}

export interface TerminalSessionView {
  terminalId: string
  ownerSessionId: string
  kind: TerminalKind
  presentation: TerminalPresentation
  title: string
  cwd: string
  profile: TerminalProfile
  /** 仅 v2 用户交互终端的 utility 探测结果；v1 与 Agent run 不生成。 */
  appearance?: TerminalAppearance
  status: TerminalStatus
  pid?: number
  startedAt: number
  finishedAt?: number
  exitCode?: number
  signal?: number
  error?: string
  sourceTarget?: TerminalSourceTargetView
}

export interface TerminalSessionClosed {
  terminalId: string
  ownerSessionId: string
  closed: true
}

export type TerminalStateChange = TerminalSessionView | TerminalSessionClosed

export interface TerminalCreateInput {
  ownerSessionId: string
  profile?: TerminalProfile
  presentation?: TerminalPresentation
  /** 仅用户交互终端可选择 v2；Main 始终校验 owner/Target/cwd。 */
  engine?: 'zcode'
  title?: string
  /** 绝对路径或相对 Session Target 根目录的目录；Main 会重新校验授权根。 */
  cwd?: string
  cols: number
  rows: number
}

export interface TerminalOwnerInput {
  ownerSessionId: string
  terminalId: string
}

export interface TerminalInput extends TerminalOwnerInput {
  data: string
}

export interface TerminalResizeInput extends TerminalOwnerInput {
  cols: number
  rows: number
}

export interface TerminalRunInput {
  command: string
  cwd?: string
  title?: string
}

export interface TerminalReadInput extends TerminalOwnerInput {
  offset?: number
  limit?: number
}

export interface TerminalOutputEvent {
  terminalId: string
  sequence: number
  data: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number
  signal?: number
}

export interface TerminalSnapshot {
  state: TerminalSessionView
  output: string
  sequence: number
}

export interface TerminalOutputReadResult {
  output: string
  startOffset: number
  endOffset: number
  nextOffset: number
  truncatedBefore: boolean
  truncatedAfter: boolean
}

export interface TerminalReadResult {
  terminal: TerminalSessionView
  read: TerminalOutputReadResult
}
