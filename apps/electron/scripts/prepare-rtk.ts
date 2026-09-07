import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import manifest from '../rtk-manifest.json'

export type RtkTarget = keyof typeof manifest.targets
const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/rtk')
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_BINARY_BYTES = 32 * 1024 * 1024

export function getRtkTarget(platform: string, arch: string): RtkTarget {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform
  const target = `${os}-${arch}`
  if (!Object.hasOwn(manifest.targets, target)) throw new Error(`未支持的 RTK 构建目标：${target}`)
  return target as RtkTarget
}

export function verifyRtkDigest(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('RTK SHA-256 校验失败')
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`RTK 下载失败：HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_ARCHIVE_BYTES) throw new Error('RTK 下载超过大小上限')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

/** 只读出指定成员；不将归档路径或链接解压到文件系统。 */
function extract(archive: Buffer, target: RtkTarget): Buffer {
  const spec = manifest.targets[target]
  if (spec.asset.endsWith('.zip')) {
    const entry = new AdmZip(archive).getEntry(spec.binary)
    if (!entry || entry.isDirectory || entry.header.size > MAX_BINARY_BYTES) throw new Error('RTK 归档成员无效')
    return entry.getData()
  }
  const env = { ...process.env }
  delete env.TAR_OPTIONS
  const result = spawnSync('tar', ['-xzOf', '-', spec.binary], {
    input: archive, env, shell: false, timeout: 30_000, maxBuffer: MAX_BINARY_BYTES,
  })
  if (result.error || result.status !== 0 || result.stderr.length) throw new Error('RTK 归档读取失败')
  return result.stdout
}

/** 构建专用：固定官方资产与双重摘要；损坏缓存不能被打包为可用资源。 */
export async function prepareRtk(target: RtkTarget, root = vendorRoot, fetchArchive = download): Promise<string> {
  const spec = manifest.targets[target]
  const directory = join(root, target)
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('RTK 资源目录不能是链接')
  const executable = join(directory, spec.binary)
  try {
    const info = await lstat(executable)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('RTK 缓存无效')
    verifyRtkDigest(await readFile(executable), spec.binarySha256)
    if (!target.startsWith('win-')) await chmod(executable, 0o755)
    return executable
  } catch { await rm(executable, { force: true }) }
  const archive = await fetchArchive(`https://github.com/rtk-ai/rtk/releases/download/v${manifest.version}/${spec.asset}`)
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('RTK 下载超过大小上限')
  verifyRtkDigest(archive, spec.archiveSha256)
  const binary = extract(archive, target)
  if (binary.length > MAX_BINARY_BYTES) throw new Error('RTK 程序超过大小上限')
  verifyRtkDigest(binary, spec.binarySha256)
  const temporary = join(directory, `${spec.binary}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, binary, { flag: 'wx', mode: 0o755 })
    await rename(temporary, executable)
  } finally { await rm(temporary, { force: true }) }
  return executable
}

if (import.meta.main && process.platform === "darwin" && process.argv.length === 2) {
  console.log("[RTK] 当前仅内置 Windows/Linux x64，macOS 保持原始命令输出")
} else if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--target' || !Object.hasOwn(manifest.targets, args[1]!))) {
    throw new Error('用法：prepare-rtk.ts [--target win-x64|linux-x64]')
  }
  const target = args[1] as RtkTarget | undefined ?? getRtkTarget(process.platform, process.arch)
  console.log(`[RTK] 已准备内置 ${manifest.version}：${await prepareRtk(target)}`)
}
