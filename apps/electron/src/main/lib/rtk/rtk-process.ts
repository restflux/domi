import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

export const RTK_MAX_INPUT_BYTES = 48 * 1024
const MAX_PROCESS_BYTES = 64 * 1024
export type RtkCanRun = () => boolean

export function buildRtkEnvironment(root: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMROOT', 'COMSPEC', 'LANG', 'LC_ALL']) {
    if (source[key]) env[key] = source[key]
  }
  return {
    ...env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
    TMP: root, TEMP: root, TMPDIR: root, RTK_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
  }
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (systemRoot && isAbsolute(systemRoot)) {
      // 固定系统工具，argv 只含宿主刚创建的 PID，不经过 shell 或项目 PATH。
      execFile(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 800, maxBuffer: 4096 }, () => { child.kill('SIGKILL') })
      return
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* 组已退出时终止单进程。 */ }
  }
  child.kill('SIGKILL')
}

/** 只接收已有 stdout；固定 argv + 私有空目录 + 最小环境，不解释 shell。 */
export async function runRtkProcess(
  executable: string, args: readonly string[], input = '', signal?: AbortSignal,
  canRun: RtkCanRun = () => true,
): Promise<string> {
  const active = (): boolean => {
    try { return !signal?.aborted && canRun() } catch { return false }
  }
  if (!active() || Buffer.byteLength(input) > RTK_MAX_INPUT_BYTES) throw new Error('RTK 输入不可用')
  const root = await mkdtemp(join(tmpdir(), 'domi-rtk-'))
  let safeToRemove = true
  try {
    return await new Promise<string>((resolve, reject) => {
      if (!active()) { reject(new Error('RTK 已取消')); return }
      safeToRemove = false
      const child = spawn(executable, [...args], {
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        cwd: root, env: buildRtkEnvironment(root), stdio: 'pipe',
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      let finished = false
      let stopping = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (deadline) clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        if (error) reject(error)
        else resolve(Buffer.concat(chunks).toString('utf8'))
      }
      const stop = (reason: string): void => {
        if (finished || stopping) return
        stopping = true
        failure = new Error(reason)
        // 即使后代持有 stdio、系统强杀失败或 close 不到达，调用也必须有界收敛。
        deadline = setTimeout(() => { child.kill('SIGKILL'); finish(failure) }, 1200)
        killTree(child)
      }
      const abort = (): void => stop('RTK 已取消')
      const timer = setTimeout(() => stop('RTK 处理超时'), 2000)
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (data: Buffer) => {
        if (stopping || finished) return
        bytes += data.length
        if (bytes > MAX_PROCESS_BYTES) { stop('RTK 输出超限'); return }
        chunks.push(data)
      })
      child.stderr.on('data', () => stop('RTK 返回错误信息'))
      child.stdout.on('error', () => stop('RTK 输出读取失败'))
      child.stderr.on('error', () => stop('RTK 错误输出读取失败'))
      child.stdin.on('error', () => stop('RTK 输入失败'))
      child.once('error', () => {
        if (!child.pid) safeToRemove = true
        finish(new Error('RTK 无法启动'))
      })
      child.once('close', code => {
        // 仅在未强制收敛前观察到完整 stdio 关闭才清理；未知后代仍占用时保留空临时目录。
        safeToRemove = !finished
        finish(failure ?? (code === 0 && active() ? undefined : new Error('RTK 处理失败或已停用')))
      })
      if (!active()) { stop('RTK 已取消'); return }
      child.stdin.end(input)
    })
  } finally {
    if (safeToRemove) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}
