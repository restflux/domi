import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'

/**
 * 改编自 ZCode packages/services/src/terminal/terminalService.ts 的 PTY spawn 路径。
 * shell/args、cwd、env 均由 Domi Main 校验后传入；这里不得接受 renderer 的任意命令。
 */
export function spawnZCodeTerminal(input: {
  file: string
  args: string[]
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}, platform: NodeJS.Platform = process.platform, spawnPty: typeof spawn = spawn): IPty {
  const base = {
    name: 'xterm-256color',
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
    encoding: 'utf8' as const,
  }
  if (platform !== 'win32') return spawnPty(input.file, input.args, base)

  try {
    return spawnPty(input.file, input.args, { ...base, useConpty: true, useConptyDll: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(message)) throw error
    return spawnPty(input.file, input.args, { ...base, useConpty: true, useConptyDll: false })
  }
}
