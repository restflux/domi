const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

// 按打包目标而非宿主架构准备，覆盖直接 electron-builder 和跨架构打包入口。
module.exports = async function prepareRtkBeforePack(context) {
  if (context.electronPlatformName === "darwin") return
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (!arch) throw new Error('RTK 尚不支持此打包架构')
  const platform = { win32: 'win', darwin: 'mac', linux: 'linux' }[context.electronPlatformName]
  const result = spawnSync('bun', [join(__dirname, 'prepare-rtk.ts'), '--target', `${platform}-${arch}`], {
    cwd: context.packager.info.appDir, stdio: 'inherit', shell: false,
  })
  if (result.error || result.status !== 0) throw new Error('内置 RTK 准备失败，停止打包')
}
