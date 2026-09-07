import { createHash } from 'node:crypto'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import manifest from '../../../../rtk-manifest.json'

export const RTK_SUPPORTED_VERSION = manifest.version

export function isRtkPlatformSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return Object.hasOwn(manifest.targets, `${platform === 'win32' ? 'win' : platform}-${arch}`)
}

/** 不接受 PATH 或用户配置；资源根只能由 Main 的应用路径或测试注入。 */
export async function findBundledRtk(directory: string, platform: string = process.platform, arch: string = process.arch): Promise<string | undefined> {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform
  const target = `${os}-${arch}`
  if (!Object.hasOwn(manifest.targets, target)) return
  const spec = manifest.targets[target as keyof typeof manifest.targets]
  const executable = join(directory, spec.binary)
  try {
    // 资源目录和程序均不得跳转至外部；缺失/损坏时保持原始 Bash 输出。
    const parent = await realpath(dirname(directory))
    if (await realpath(directory) !== join(parent, basename(directory)) || (await lstat(directory)).isSymbolicLink()) return
    const info = await lstat(executable)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) return
    await access(executable, constants.X_OK)
    // 不用 isPackaged 假定签名已验证；程序与固定摘要不一致时一律禁用。
    if (createHash('sha256').update(await readFile(executable)).digest('hex') !== spec.binarySha256) return
    return executable
  } catch { return undefined }
}

export async function findRtkExecutable(): Promise<string | undefined> {
  const app = process.versions.electron ? (await import('electron')).app : undefined
  if (app?.isPackaged) return findBundledRtk(join(process.resourcesPath, 'rtk'), process.platform, process.arch)
  // Bun 源码测试与 Electron dev 共用构建缓存；打包后只读取 resources，不向开发路径回退。
  const appPath = app?.getAppPath() ?? resolve(__dirname, '../../../..')
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform
  return findBundledRtk(join(appPath, 'vendor/rtk', `${os}-${process.arch}`))
}
