const { createHash } = require('node:crypto')
const { readFile, writeFile, lstat } = require('node:fs/promises')
const { join } = require('node:path')
const manifest = require('../rtk-manifest.json')

// Windows extraResources 会经过 Authenticode transformer。在应用签名之前恢复官方
// RTK 原件，不修改 Domi.exe 的签名流程，也不放宽运行时固定摘要校验。
module.exports = async function preserveRtkAfterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  if (context.arch !== 1) throw new Error('RTK 尚不支持此 Windows 架构')
  const spec = manifest.targets['win-x64']
  const source = join(context.packager.info.appDir, 'vendor', 'rtk', 'win-x64', spec.binary)
  if (!(await lstat(source)).isFile()) throw new Error('RTK 构建资源无效')
  const bytes = await readFile(source)
  if (createHash('sha256').update(bytes).digest('hex') !== spec.binarySha256) throw new Error('RTK 构建资源 SHA-256 校验失败')
  await writeFile(join(context.appOutDir, 'resources', 'rtk', spec.binary), bytes)
}
