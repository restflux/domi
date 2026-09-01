import { chmodSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Bun 安装预构建 node-pty 时可能丢失 Unix spawn-helper 的执行位。 */
const nodePtyRoots = [
  join(import.meta.dir, '..', 'node_modules', 'node-pty'),
  join(import.meta.dir, '..', '..', '..', 'node_modules', 'node-pty'),
]
const helperPaths = nodePtyRoots.flatMap((nodePtyRoot) => [
  join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
  join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
  join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
])

for (const helperPath of helperPaths) {
  if (!existsSync(helperPath)) continue
  const mode = statSync(helperPath).mode
  if ((mode & 0o100) !== 0) continue
  chmodSync(helperPath, mode | 0o100)
  console.log(`[node-pty] 已恢复 spawn-helper 执行权限：${helperPath}`)
}
