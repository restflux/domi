import { execFile, type ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

export const WORKTREE_CREATE_TIMEOUT_MS = 5 * 60_000
export const GIT_COMMAND_TIMEOUT_MS = 2 * 60_000

/** 仅修改本次 Git 调用，不改变用户配置；非 Git 工具的长路径能力不在此契约内。 */
export function gitLongPathArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['-c', 'core.longpaths=true'] : []
}

export function gitTimeoutMs(args: readonly string[]): number {
  return args[0] === 'worktree' && (args[1] === 'add' || args[1] === 'remove')
    ? WORKTREE_CREATE_TIMEOUT_MS : GIT_COMMAND_TIMEOUT_MS
}

/** 超时之后不再拥有自动清理权：即使父进程 close，也无法证明所有后代均已退出。 */
export class GitCommandInterruptedError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Git ${operation} 超时（${timeoutMs}ms）；已请求终止，无法确认所有子进程退出，现场已保留`)
    this.name = 'GitCommandInterruptedError'
  }
}

/** 固定系统工具和宿主 PID，不经过 shell；调用有界，但不声称整个进程树已静止。 */
export async function requestGitTermination(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (systemRoot && isAbsolute(systemRoot)) {
      await new Promise<void>((resolve) => {
        execFile(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 2_000, maxBuffer: 4096 }, () => resolve())
      })
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 组不存在时仍尝试终止父进程。 */ }
  }
  try { child.kill('SIGKILL') } catch { /* 保留不确定退出状态，由调用方禁止清理。 */ }
}
