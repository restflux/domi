import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTerminalShell } from './terminal-shell-resolver.ts'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('terminal shell resolver', () => {
  test('ignores mutable CLAUDE_CODE_SHELL and uses only the Main-provided Git Bash path', () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-terminal-shell-'))
    cleanup.push(root)
    const trusted = join(root, 'bash.exe')
    writeFileSync(trusted, '')
    const shell = resolveTerminalShell({
      profile: 'git-bash',
      mode: 'agent-command',
      command: 'echo ok',
      platform: 'win32',
      shellPath: trusted,
      env: { CLAUDE_CODE_SHELL: 'C:\\attacker\\bash.exe' },
    })
    expect(shell.file).toBe(trusted)
    expect(shell.args.at(-2)).toBe('-c')
    expect(shell.args.at(-1)).toBe('echo ok')
  })

  test('pins the selected WSL distribution and passes cwd as argv data', () => {
    const shell = resolveTerminalShell({
      profile: 'wsl', mode: 'agent-command', command: 'bun run dev', cwd: 'C:\\repo',
      wslDistro: 'Ubuntu', platform: 'win32', env: {},
    })
    expect(shell.file).toBe('wsl.exe')
    expect(shell.args.slice(0, 4)).toEqual(['--distribution', 'Ubuntu', '--exec', 'bash'])
    expect(shell.args.at(-2)).toBe('C:\\repo')
    expect(shell.args.at(-1)).toBe('bun run dev')
  })
})
