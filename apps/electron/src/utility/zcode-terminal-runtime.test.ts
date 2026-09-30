import { describe, expect, test } from 'bun:test'
import type { IPty } from 'node-pty'
import { spawnZCodeTerminal } from './zcode-terminal-runtime.ts'

const input = { file: 'pwsh.exe', args: [], cols: 80, rows: 24, cwd: 'C:\\project', env: { TERM: 'xterm-256color' } }
const pty = { pid: 42 } as IPty

describe('ZCode v2 PTY 启动', () => {
  test('Windows DLL 不可用时仅回退系统 ConPTY，保留相同 shell/cwd', () => {
    const attempts: Array<{ file: string; cwd: string; dll: boolean | undefined }> = []
    const spawnPty = ((file: string, _args: string[], options: { cwd: string; useConptyDll?: boolean }) => {
      attempts.push({ file, cwd: options.cwd, dll: options.useConptyDll })
      if (options.useConptyDll) throw new Error('cannot find conpty.dll error code: 126')
      return pty
    }) as typeof import('node-pty').spawn
    expect(spawnZCodeTerminal(input, 'win32', spawnPty)).toBe(pty)
    expect(attempts).toEqual([
      { file: 'pwsh.exe', cwd: 'C:\\project', dll: true },
      { file: 'pwsh.exe', cwd: 'C:\\project', dll: false },
    ])
  })

  test('shell 或 cwd 的普通错误不能自动降级重试', () => {
    let count = 0
    const spawnPty = (() => { count++; throw new Error('Access denied') }) as typeof import('node-pty').spawn
    expect(() => spawnZCodeTerminal(input, 'win32', spawnPty)).toThrow('Access denied')
    expect(count).toBe(1)
  })
})
