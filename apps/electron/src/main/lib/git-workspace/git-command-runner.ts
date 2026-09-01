import { spawn } from 'node:child_process'

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export interface CommandOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** 写入 stdin 后关闭（commit 消息经 stdin 传入，杜绝 shell 注入）。 */
  stdin?: string
}

export interface GitCommandOptions extends CommandOptions {
  /** 同一进程内完全相同的只读请求可以共享一次执行。 */
  dedupeKey?: string
}

const inFlightGitCommands = new Map<string, Promise<CommandResult>>()

/** 参数数组执行器；永远不启用 shell，避免路径和参数被二次解释。 */
export function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ...options.env,
        },
      })
      child.stdin.on('error', () => { /* EPIPE：命令未读 stdin 即退出，忽略 */ })
      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin)
      } else {
        child.stdin.end()
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })

      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, 250).unref()
      }, options.timeoutMs ?? 10_000)
      timeout.unref()

      child.on('error', (error) => {
        clearTimeout(timeout)
        finish({
          ok: false,
          stdout,
          stderr: stderr || error.message,
          exitCode: null,
          timedOut,
        })
      })
      child.on('close', (exitCode) => {
        clearTimeout(timeout)
        finish({
          ok: exitCode === 0 && !timedOut,
          stdout,
          stderr,
          exitCode,
          timedOut,
        })
      })
    } catch (error) {
      finish({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
        timedOut: false,
      })
    }
  })
}

/** 只读 Git 命令统一入口；调用方只传参数，不传 shell 字符串。 */
export function runGitCommand(
  args: readonly string[],
  cwd: string,
  options: GitCommandOptions = {},
): Promise<CommandResult> {
  const execute = (): Promise<CommandResult> => runCommand(
    'git',
    ['-c', 'core.quotePath=false', ...args],
    {
      cwd,
      timeoutMs: options.timeoutMs,
      stdin: options.stdin,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        LANG: 'C',
        ...options.env,
      },
    },
  )

  if (!options.dedupeKey) return execute()
  const key = `${cwd}\0${options.dedupeKey}`
  const existing = inFlightGitCommands.get(key)
  if (existing) return existing
  const promise = execute().finally(() => {
    if (inFlightGitCommands.get(key) === promise) inFlightGitCommands.delete(key)
  })
  inFlightGitCommands.set(key, promise)
  return promise
}

export function getInFlightGitCommandCountForTest(): number {
  return inFlightGitCommands.size
}
