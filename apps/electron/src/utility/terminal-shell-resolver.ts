import { accessSync, constants, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertTerminalProfileSupported, type TerminalProfile } from '@domi/shared'

export interface ResolvedTerminalShell {
  file: string
  args: string[]
  title: string
}

interface ResolveTerminalShellInput {
  profile: TerminalProfile
  mode: 'interactive-shell' | 'agent-command'
  command?: string
  cwd?: string
  shellPath?: string
  wslDistro?: string
  platform?: string
  env?: NodeJS.ProcessEnv
}

export function resolveTerminalShell(input: ResolveTerminalShellInput): ResolvedTerminalShell {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  assertTerminalProfileSupported(input.profile, platform)
  const shell = platform === 'win32'
    ? resolveWindowsShell(input.profile, env, input.shellPath)
    : resolvePosixShell(input.profile, platform, env)

  if (input.mode === 'interactive-shell') return shell
  const command = input.command?.trim()
  if (!command) throw new Error('Agent 终端命令为空')
  if (input.profile !== 'bash' && input.profile !== 'git-bash' && input.profile !== 'wsl') {
    throw new Error(`Agent 终端只接受 Bash 语义，不能使用 ${input.profile}`)
  }
  if (input.profile === 'wsl') {
    const cwd = input.cwd?.trim()
    if (!cwd) throw new Error('WSL Agent 终端缺少工作目录')
    const wrapper = 'cd "$(wslpath -a -- "$1")" && exec bash -lc "$2"'
    return {
      ...shell,
      args: [
        ...(input.wslDistro ? ['--distribution', input.wslDistro] : []),
        '--exec', 'bash', '-lc', wrapper, 'domi-terminal', cwd, command,
      ],
    }
  }
  return { ...shell, args: [...shell.args, '-c', command] }
}

function resolvePosixShell(profile: TerminalProfile, platform: string, env: NodeJS.ProcessEnv): ResolvedTerminalShell {
  if (profile === 'zsh') return executableShell('/bin/zsh', [], 'Zsh')
  if (profile === 'bash') return executableShell('/bin/bash', [], 'Bash')
  const configured = env.SHELL
  if (configured && canExecute(configured)) {
    const name = basename(configured)
    return { file: configured, args: [], title: name === 'zsh' ? 'Zsh' : name === 'bash' ? 'Bash' : name }
  }
  if (platform === 'darwin' && canExecute('/bin/zsh')) return { file: '/bin/zsh', args: [], title: 'Zsh' }
  return executableShell('/bin/bash', [], 'Bash')
}

function resolveWindowsShell(profile: TerminalProfile, env: NodeJS.ProcessEnv, trustedShellPath?: string): ResolvedTerminalShell {
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (profile === 'wsl') return { file: 'wsl.exe', args: [], title: 'WSL' }
  if (profile === 'git-bash') {
    const candidates = [
      trustedShellPath && basename(trustedShellPath).toLowerCase().includes('bash') ? trustedShellPath : undefined,
      env.ProgramFiles ? join(env.ProgramFiles, 'Git', 'bin', 'bash.exe') : undefined,
      env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : undefined,
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ].filter((value): value is string => Boolean(value))
    const file = candidates.find((candidate) => existsSync(candidate))
    if (!file) throw new Error('未找到 Git Bash，Agent 可见终端需要 Git for Windows')
    return { file, args: ['--noprofile', '--norc'], title: 'Git Bash' }
  }
  if (profile === 'cmd') return { file: env.ComSpec || 'cmd.exe', args: [], title: 'Command Prompt' }
  if (profile === 'pwsh') return { file: 'pwsh.exe', args: ['-NoLogo'], title: 'PowerShell 7' }
  if (profile === 'powershell') return executableShell(powershell, ['-NoLogo'], 'Windows PowerShell')
  if (canExecute(powershell)) return { file: powershell, args: ['-NoLogo'], title: 'PowerShell' }
  return { file: env.ComSpec || 'cmd.exe', args: [], title: 'Command Prompt' }
}

function executableShell(file: string, args: string[], title: string): ResolvedTerminalShell {
  if (!canExecute(file)) throw new Error(`Shell 不存在或不可执行：${file}`)
  return { file, args, title }
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
