import { describe, expect, test } from 'bun:test'
import { resolveAgentTerminalProfile } from './terminal-agent-run-spec.ts'

describe('agent terminal run profile', () => {
  test('uses Bash on POSIX', () => {
    expect(resolveAgentTerminalProfile({ platform: 'linux', env: {} })).toBe('bash')
    expect(resolveAgentTerminalProfile({ platform: 'darwin', env: {} })).toBe('bash')
  })

  test('uses the canonical Git Bash selection on Windows', () => {
    expect(resolveAgentTerminalProfile({
      platform: 'win32',
      env: { DOMI_WINDOWS_SHELL: 'git-bash', CLAUDE_CODE_SHELL: 'C:\\Git\\bin\\bash.exe' },
    })).toBe('git-bash')
  })

  test('uses WSL only when the runtime selected WSL', () => {
    expect(resolveAgentTerminalProfile({ platform: 'win32', env: { DOMI_WINDOWS_SHELL: 'wsl' } })).toBe('wsl')
  })

  test('fails closed instead of silently executing Bash source in PowerShell', () => {
    expect(() => resolveAgentTerminalProfile({ platform: 'win32', env: {} })).toThrow('Git Bash 或 WSL')
  })
})
