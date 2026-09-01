import type { TerminalProfile } from '@domi/shared'

interface AgentTerminalProfileInput {
  platform?: string
  env?: NodeJS.ProcessEnv
}

/** Agent Run 必须与 Canonical Shell Analysis 使用同一种 Bash 语义。 */
export function resolveAgentTerminalProfile(input: AgentTerminalProfileInput = {}): Extract<TerminalProfile, 'bash' | 'git-bash' | 'wsl'> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  if (platform !== 'win32') return 'bash'
  if (env.DOMI_WINDOWS_SHELL === 'wsl') return 'wsl'
  if (env.DOMI_WINDOWS_SHELL === 'git-bash' || env.CLAUDE_CODE_SHELL?.toLowerCase().includes('bash')) {
    return 'git-bash'
  }
  throw new Error('Agent 可见终端需要当前会话选择 Git Bash 或 WSL，以保持 Bash 权限分析语义。')
}
