import { spawn } from 'node:child_process'

// 固定脚本只接收已经过宿主身份校验的 quarantine 路径；不启动 Shell 或后代进程。
const REMOVE_SCRIPT = `
const fs = require('node:fs/promises');
(async () => {
  const path = process.argv[1];
  let stat;
  try { stat = await fs.lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('拒绝删除非目录或符号链接');
  await fs.rm(path, { recursive: true, force: true, maxRetries: 0 });
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
`

/**
 * fs.rm 无取消接口，不能用 Promise.race 释放锁后让它继续删除。
 * 在专用子进程中删除，预算耗尽时终止并等待 close，再将残余交给现有重试流程。
 */
export function removeDirectoryBounded(path: string, timeoutMs = 30_000): Promise<void> {
  if (timeoutMs <= 0) return Promise.reject(Object.assign(new Error('目录清理预算已耗尽'), { code: 'ETIMEDOUT' }))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', REMOVE_SCRIPT, path], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let timedOut = false
    let errorOutput = ''
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stderr.on('data', (chunk: Buffer) => {
      errorOutput = (errorOutput + chunk.toString()).slice(-2048)
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(Object.assign(new Error('目录清理超时，删除进程已退出，残余保留以供重试'), { code: 'ETIMEDOUT' }))
      } else if (code === 0) resolve()
      else reject(new Error(`目录清理失败：${errorOutput.trim() || `exit ${code}`}`))
    })
  })
}
