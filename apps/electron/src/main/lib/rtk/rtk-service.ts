import type { RtkStatus } from "@domi/shared"
import type { RtkFilter } from "./rtk-command-filter.ts"
import { runRtkProcess, type RtkCanRun } from "./rtk-process.ts"
import { findRtkExecutable, isRtkPlatformSupported, RTK_SUPPORTED_VERSION } from "./rtk-bundled.ts"
export { findRtkExecutable, RTK_SUPPORTED_VERSION } from "./rtk-bundled.ts"
export { buildRtkEnvironment, runRtkProcess, RTK_MAX_INPUT_BYTES } from "./rtk-process.ts"

export interface RtkServiceDependencies {
  isSupported?(): boolean
  findExecutable(): Promise<string | undefined>
  run(executable: string, args: readonly string[], input?: string, signal?: AbortSignal, canRun?: RtkCanRun): Promise<string>
}
interface Detection { availability: RtkStatus['availability']; version?: string; executable?: string }

export function createRtkService(dependencies: RtkServiceDependencies) {
  let executable: string | undefined
  let status: RtkStatus = { availability: 'not-checked', optimizedCalls: 0, originalBytes: 0, returnedBytes: 0 }
  let checking: Promise<RtkStatus> | undefined
  let generation = 0
  const getStatus = (): RtkStatus => ({ ...status })
  async function detect(canRun: RtkCanRun, signal?: AbortSignal): Promise<Detection | undefined> {
    const active = (): boolean => !signal?.aborted && canRun()
    try {
      if (!active()) return
      if (dependencies.isSupported?.() === false) return { availability: 'unsupported' }
      const path = await dependencies.findExecutable()
      if (!active()) return
      if (!path) return { availability: 'not-found' }
      const versionText = (await dependencies.run(path, ['--version'], '', signal, active)).trim()
      if (!active()) return
      const version = /^rtk (\d+\.\d+\.\d+)$/.exec(versionText)?.[1]
      if (version !== RTK_SUPPORTED_VERSION) return { availability: 'incompatible', version }
      const probe = 'domi-rtk-pipe-probe\n'
      const output = await dependencies.run(path, ['pipe', '--passthrough'], probe, signal, active)
      if (!active()) return
      return output === probe ? { availability: 'available', version, executable: path } : { availability: 'incompatible', version }
    } catch { return active() ? { availability: 'error' } : undefined }
  }
  function publish(detection: Detection): void {
    executable = detection.executable
    status = { ...status, availability: detection.availability, version: detection.version }
  }
  async function recheck(): Promise<RtkStatus> {
    if (checking) return checking
    generation++
    executable = undefined
    // 设置页面的组件检查独立于 Bash，不共享可能已取消/撤销的工具检测生命周期。
    checking = (async () => {
      const result = await detect(() => true)
      if (result) publish(result)
      return getStatus()
    })()
    try { return await checking } finally { checking = undefined }
  }
  async function filter(name: RtkFilter, text: string, signal?: AbortSignal, canRun: RtkCanRun = () => true): Promise<string | undefined> {
    const active = (): boolean => !signal?.aborted && canRun()
    try {
      if (!active()) return
      if (status.availability === 'not-checked') {
        const startedGeneration = generation
        const detected = await detect(active, signal)
        if (!active() || !detected || startedGeneration !== generation) return
        publish(detected)
      }
      if (!active() || !executable || status.availability !== 'available') return
      const result = await dependencies.run(executable, ['pipe', '--filter', name], text, signal, active)
      return active() ? result : undefined
    } catch { return undefined }
  }
  function record(originalBytes: number, returnedBytes: number): void {
    status.optimizedCalls++
    status.originalBytes += originalBytes
    status.returnedBytes += returnedBytes
  }
  // 打开设置即检查内置组件，已可用时仅返回统计，不再要求用户点击检测。
  const inspect = (): Promise<RtkStatus> => checking ?? (status.availability === 'available' ? Promise.resolve(getStatus()) : recheck())
  return { getStatus, inspect, recheck, filter, record }
}

export const rtkService = createRtkService({ findExecutable: findRtkExecutable, isSupported: isRtkPlatformSupported, run: runRtkProcess })
